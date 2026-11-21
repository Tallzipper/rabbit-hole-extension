let storageQueue = Promise.resolve(); // Keep storage writes in order so rapid tab events don't clobber each other
const pendingOpenerMap = new Map();   // Holds parent info when a new tab opens before its URL loads
const pendingStepJumpMap = new Map(); // Tracks manual step clicks so we move the highlight instead of duplicating

const MAX_CLOSED_BURROWS = 25;
const RESTORE_WINDOW_MS = 10 * 60 * 1000; // Give users 10 mins to hit Ctrl+Shift+T and bring a burrow back
const BLOCKED_PREFIXES = ["edge://", "chrome://", "extension://", "chrome-extension://", "about:", "https://ntp.msn.com", "http://ntp.msn.com"];
const SEARCH_HOSTS = ["bing.com", "google.com", "duckduckgo.com"];

// --- Storage & Session --- //

const withState = (fn) => { // Grab burrows, run our changes, and auto-save if anything actually changed
  const next = storageQueue.then(async () => {
    const data = await chrome.storage.local.get(["burrows", "closedBurrows"]);
    const state = { burrows: data.burrows || [], closedBurrows: data.closedBurrows || [] };
    if (await fn(state)) await chrome.storage.local.set(state);
    return state;
  });
  storageQueue = next.catch((e) => console.error("Rabbit Hole storage error:", e));
  return next;
};

const getSession = async () => { // Session storage survives Edge putting the service worker to sleep
  const d = await chrome.storage.session.get(["untrackedFirstSteps", "lastActiveExternalTab"]);
  return { firstSteps: d.untrackedFirstSteps || {}, lastActive: d.lastActiveExternalTab || null };
};

const setFirstStep = async (tabId, stepOrNull) => { // Hold onto Step 1 until the tab visits a 2nd page
  const { firstSteps } = await getSession();
  stepOrNull ? (firstSteps[tabId] = stepOrNull) : delete firstSteps[tabId];
  await chrome.storage.session.set({ untrackedFirstSteps: firstSteps });
};

// --- URL, Title & Step Helpers --- //

const isInternalURL = (u) => Boolean(u) && BLOCKED_PREFIXES.some((p) => u.startsWith(p));
const isRedirectHop = (u) => /bing\.com\/(ck\/a|aclick)|google\.com\/url\?/.test(u); // Skip search engine tracking hops
const getActiveIdx = (b) => Math.max(0, Math.min(typeof b.activeStepIndex === "number" ? b.activeStepIndex : b.steps.length - 1, b.steps.length - 1));

function parseURL(raw) {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, "");
    const isEngine = parsed.pathname.includes("/search") || SEARCH_HOSTS.includes(host);
    return { parsed, host, isEngine, query: (parsed.searchParams.get("q") || "").trim() };
  }
  catch { return null; }
}

const isTrackableURL = (u) => { // Ignore browser pages, ad redirects, and blank /search preloads
  if (!u || isInternalURL(u) || isRedirectHop(u)) return false;
  const info = parseURL(u);
  return !(info && info.parsed.pathname.includes("/search") && !info.query);
};

function normalizeURLForCompare(raw) { // Strip noisy params/anchors so we can tell if two URLs are really the same page
  const info = raw ? parseURL(raw) : null;
  if (!info) return raw || "";
  const { parsed, host, isEngine, query } = info;
  if (isEngine && query) return `${parsed.protocol}//${host}/search?q=${query.toLowerCase()}`;

  const hash = parsed.hash || ""; // Keep app routes (like Gmail threads), drop regular #section jumps
  if ((host === "mail.google.com" || /^#[!/]/.test(hash)) && hash.length > 1) {
    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${hash.split("?")[0].replace(/\/+$/, "")}`;
  }

  const kept = new URLSearchParams(); // Hold onto video/post IDs (like YouTube ?v=), drop tracking junk
  for (const k of ["v", "id", "p"]) if (parsed.searchParams.get(k)) kept.set(k, parsed.searchParams.get(k));
  const qs = kept.toString();
  return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${qs ? `?${qs}` : ""}`;
}

function cleanStepTitle(url, rawTitle) { // Avoid ugly raw URLs, "New tab", or leftover titles from an older search
  const info = parseURL(url);
  const fallback = info?.isEngine && info.query ? `${info.query} - Search` : (url || "Untitled Page");
  if (!rawTitle || rawTitle === "New tab" || /^https?:\/\//.test(rawTitle)) return fallback;
  if (info?.isEngine && info.query && !rawTitle.toLowerCase().includes(info.query.toLowerCase())) return fallback;
  return rawTitle;
}

const buildStep = (tabId, url, title = "", favIconUrl = "", inherited = false) => ({
  stepId: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  tabId,
  url,
  title: cleanStepTitle(url, title),
  favIconUrl: favIconUrl || "",
  visitedAt: Date.now(),
  inherited
});

const buildStepFromTab = (tab, url = "", inherited = false) =>
  buildStep(tab.id, url || tab.pendingUrl || tab.url || "", tab.title, tab.favIconUrl, inherited);

function deduplicateSteps(burrow) { // Merge back-to-back duplicates when a page reloads or redirects itself
  if (!burrow?.steps || burrow.steps.length < 2) return;
  const out = [burrow.steps[0]];
  for (let i = 1; i < burrow.steps.length; i++) {
    const prev = out[out.length - 1], curr = burrow.steps[i];
    if (normalizeURLForCompare(prev.url) === normalizeURLForCompare(curr.url) && Boolean(prev.inherited) === Boolean(curr.inherited)) {
      if (curr.title && !curr.title.startsWith("http")) prev.title = curr.title;
      if (curr.favIconUrl) prev.favIconUrl = curr.favIconUrl;
      prev.url = curr.url;
    }
    else out.push(curr);
  }
  burrow.steps = out;
  burrow.activeStepIndex = getActiveIdx(burrow);
}

const createBurrow = (windowId, tabIds, steps = [], branchedFrom = null) => ({
  id: `burrow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  title: "New Research Burrow",
  windowId,
  tabIds: [...tabIds],
  steps: [...steps],
  activeStepIndex: Math.max(0, steps.length - 1),
  branchedFrom,
  branchedTo: [],
  hidden: false,
  createdAt: Date.now(),
  lastAccessedAt: Date.now()
});

// --- Lineage, Resurrection & Branching --- //

function tryResurrectClosedBurrow({ tabId, windowId, url, burrows, closedBurrows }) { // Bring back a closed burrow if the user hits Ctrl+Shift+T
  if (!isTrackableURL(url) || !closedBurrows.length) return false;
  const norm = normalizeURLForCompare(url), now = Date.now();
  const idx = closedBurrows.findIndex((e) => e && now - (e.closedAt || 0) <= RESTORE_WINDOW_MS && e.burrow?.steps?.length && normalizeURLForCompare(e.burrow.steps[getActiveIdx(e.burrow)].url) === norm);
  if (idx === -1) return false;

  const [archived] = closedBurrows.splice(idx, 1);
  const revived = archived.burrow;
  const alive = new Map(burrows.map((b) => [b.id, b]));

  Object.assign(revived, {
    windowId, tabIds: [tabId], hidden: false, lastAccessedAt: now, branchedTo: [],
    steps: revived.steps.map((s) => ({ ...s, tabId })),
    activeStepIndex: Math.max(0, revived.steps.length - 1)
  });

  if (revived.branchedFrom && alive.has(revived.branchedFrom.burrowId)) { // Hook back up to its parent if the parent is still open
    const anc = alive.get(revived.branchedFrom.burrowId);
    if (!anc.branchedTo.some((l) => l.burrowId === revived.id)) {
      anc.branchedTo.push({ burrowId: revived.id, fromTabId: revived.branchedFrom.tabId, fromStepId: revived.branchedFrom.stepId, windowId });
    }
  }
  else revived.branchedFrom = null;

  const inheritedSet = new Set(archived.inheritedStepIds || []);
  const fallbackSplit = revived.steps[revived.steps.length - 1] || null;

  for (const childId of (archived.inheritedByChildIds || [])) { // Reclaim any children that inherited steps when this burrow closed
    const child = alive.get(childId);
    if (!child) continue;

    if (inheritedSet.size && child.steps) { // Strip out the temporary inherited steps so the child goes back to normal
      const removedBefore = child.steps.slice(0, getActiveIdx(child) + 1).filter((s) => inheritedSet.has(s.stepId)).length;
      child.steps = child.steps.filter((s) => !inheritedSet.has(s.stepId));
      child.activeStepIndex = Math.max(0, Math.min(getActiveIdx(child) - removedBefore, child.steps.length - 1));
    }
    if (child.branchedFrom && alive.has(child.branchedFrom.burrowId)) { // Unhook the temporary grandparent bridge
      const gp = alive.get(child.branchedFrom.burrowId);
      gp.branchedTo = gp.branchedTo.filter((l) => l.burrowId !== child.id);
    }

    const origin = revived.steps.find((s) => s.stepId === archived.childSplitMap?.[child.id]) || fallbackSplit;
    child.branchedFrom = { burrowId: revived.id, tabId, stepId: origin?.stepId || null, stepTitle: origin?.title || "Main timeline" };
    revived.branchedTo.push({ burrowId: child.id, fromTabId: tabId, fromStepId: origin?.stepId || null, windowId: child.windowId });
  }

  burrows.push(revived);
  return true;
}

async function linkChildToParent(childTabId, childWindowId, childURL, openerTabId) { // Branch a new child burrow off whatever step the parent is currently viewing
  if (!childURL || isInternalURL(childURL)) return;
  await withState(async ({ burrows }) => {
    let opener, childTab;
    try { [opener, childTab] = await Promise.all([chrome.tabs.get(openerTabId), chrome.tabs.get(childTabId)]); }
    catch { return false; }

    const openerURL = opener.pendingUrl || opener.url || "";
    if (isInternalURL(openerURL) || burrows.some((b) => b.tabIds.includes(childTabId))) return false;

    let parent = burrows.find((b) => b.tabIds.includes(opener.id));
    if (!parent) { // Opener only had 1 step so far—turn it into a real burrow now that it has a child
      const { firstSteps } = await getSession();
      const saved = firstSteps[opener.id];
      const step = saved ? { ...saved, title: cleanStepTitle(saved.url, saved.title) } : buildStepFromTab(opener, openerURL);
      parent = createBurrow(opener.windowId, [opener.id], [step]);
      burrows.push(parent);
    }

    await Promise.all([setFirstStep(opener.id, null), setFirstStep(childTabId, null)]);
    if (!parent.steps.length) parent.steps = [buildStepFromTab(opener, openerURL)];

    const split = parent.steps[getActiveIdx(parent)];
    const child = createBurrow(childWindowId, [childTabId], [buildStepFromTab(childTab, childURL)], {
      burrowId: parent.id, tabId: opener.id, stepId: split.stepId, stepTitle: split.title
    });

    parent.branchedTo.push({ burrowId: child.id, fromTabId: opener.id, fromStepId: split.stepId, windowId: childWindowId });
    parent.lastAccessedAt = Date.now();
    burrows.push(child);
    return true;
  });
}

// --- Tab & Lifecycle Listeners --- //

chrome.runtime.onInstalled.addListener(() => withState(() => true));
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error("Side Panel error:", e));

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id !== "number") return;
  const url = tab.pendingUrl || tab.url || "";
  if (isInternalURL(url)) return;

  let openerId = typeof tab.openerTabId === "number" ? tab.openerTabId : null;
  if (openerId === null && url) { // "Open link in new window" doesn't set openerTabId, so check our last active tab
    const { lastActive } = await getSession();
    if (lastActive && tab.windowId !== lastActive.windowId && Date.now() - lastActive.timestamp < 5000) openerId = lastActive.tabId;
  }

  if (typeof openerId === "number") {
    url ? linkChildToParent(tab.id, tab.windowId, url, openerId) : pendingOpenerMap.set(tab.id, { openerTabId: openerId, windowId: tab.windowId });
  }
  else if (url) {
    withState(async ({ burrows, closedBurrows }) => {
      if (burrows.some((b) => b.tabIds.includes(tab.id))) return false;
      const ok = tryResurrectClosedBurrow({ tabId: tab.id, windowId: tab.windowId, url, burrows, closedBurrows });
      if (ok) await setFirstStep(tab.id, null);
      return ok;
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const t = await chrome.tabs.get(tabId);
    const url = t.pendingUrl || t.url || "";
    if (url && !isInternalURL(url)) await chrome.storage.session.set({ lastActiveExternalTab: { tabId, windowId, timestamp: Date.now() } });
  }
  catch { /* Tab closed before we could read it */ }

  withState(({ burrows }) => {
    const b = burrows.find((x) => x.tabIds.includes(tabId));
    if (!b) return false;
    b.lastAccessedAt = Date.now();
    return true;
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || "", title = changeInfo.title || "", favicon = changeInfo.favIconUrl || tab.favIconUrl || "";

  if (changeInfo.url && tab.active && !isInternalURL(changeInfo.url)) {
    chrome.storage.session.set({ lastActiveExternalTab: { tabId, windowId: tab.windowId, timestamp: Date.now() } }).catch(() => {});
  }

  if (changeInfo.url && pendingOpenerMap.has(tabId)) { // Finish linking a child tab that started out blank
    const p = pendingOpenerMap.get(tabId);
    pendingOpenerMap.delete(tabId);
    if (!isInternalURL(changeInfo.url)) linkChildToParent(tabId, typeof tab.windowId === "number" ? tab.windowId : p.windowId, changeInfo.url, p.openerTabId);
    return;
  }

  if (changeInfo.url && isInternalURL(changeInfo.url)) { // User went to edge://settings or similar—detach this tab
    setFirstStep(tabId, null).catch(() => {});
    withState((s) => {
      let dirty = false;
      for (const b of s.burrows) { const i = b.tabIds.indexOf(tabId); if (i !== -1) { b.tabIds.splice(i, 1); dirty = true; } }
      if (dirty) s.burrows = s.burrows.filter((b) => b.tabIds.length > 0);
      return dirty;
    });
    return;
  }

  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;

  withState(async ({ burrows, closedBurrows }) => {
    const burrow = burrows.find((b) => b.tabIds.includes(tabId));

    if (!burrow) { // Standalone tab: hold Step 1 in session storage, then promote on Step 2
      if (!isTrackableURL(url)) return false;
      const { firstSteps } = await getSession();
      const first = firstSteps[tabId] || null;

      if (!first) {
        if (tryResurrectClosedBurrow({ tabId, windowId: tab.windowId, url, burrows, closedBurrows })) {
          const revived = burrows.find((b) => b.tabIds.includes(tabId));
          const last = revived?.steps[revived.steps.length - 1];
          if (last) {
            if (title) last.title = cleanStepTitle(last.url, title);
            if (favicon) last.favIconUrl = favicon;
          }
          return true;
        }
        await setFirstStep(tabId, buildStep(tabId, url, title, favicon));
        return false;
      }

      if (normalizeURLForCompare(url) === normalizeURLForCompare(first.url)) { // Still on Step 1, just refresh its title/icon
        let dirty = false;
        if (title) { const next = cleanStepTitle(first.url, title); if (first.title !== next) { first.title = next; dirty = true; } }
        if (changeInfo.favIconUrl && first.favIconUrl !== changeInfo.favIconUrl) { first.favIconUrl = changeInfo.favIconUrl; dirty = true; }
        if (dirty) await setFirstStep(tabId, first);
        return false;
      }

      await setFirstStep(tabId, null); // 2nd page visited—promote both steps into a real burrow
      const promoted = createBurrow(tab.windowId, [tabId], [{ ...first, title: cleanStepTitle(first.url, first.title) }, buildStep(tabId, url, title, favicon)]);
      deduplicateSteps(promoted);
      burrows.push(promoted);
      return true;
    }

    // Tab is already in a burrow: handle step jumps, Back/Forward, or new links
    burrow.activeStepIndex = getActiveIdx(burrow);
    let changed = false, active = burrow.steps[burrow.activeStepIndex] || null;

    if (changeInfo.url && isTrackableURL(changeInfo.url)) {
      const inNorm = normalizeURLForCompare(changeInfo.url), actNorm = active ? normalizeURLForCompare(active.url) : "";
      const jump = pendingStepJumpMap.get(tabId);

      if (jump && normalizeURLForCompare(jump.targetURL) === inNorm) { // User clicked an older step in our UI
        pendingStepJumpMap.delete(tabId);
        const idx = burrow.steps.findIndex((s, i) => jump.stepIndex !== undefined ? i === jump.stepIndex : normalizeURLForCompare(s.url) === inNorm);
        if (idx !== -1) { burrow.activeStepIndex = idx; burrow.lastAccessedAt = Date.now(); changed = true; }
      }
      else if (inNorm !== actNorm) { // Check if Back/Forward hit a neighbor step before adding a new one
        const adj = [burrow.activeStepIndex - 1, burrow.activeStepIndex + 1].find((i) => i >= 0 && i < burrow.steps.length && normalizeURLForCompare(burrow.steps[i].url) === inNorm);
        if (adj !== undefined) burrow.activeStepIndex = adj;
        else {
          burrow.steps.push(buildStep(tabId, changeInfo.url, title, favicon));
          deduplicateSteps(burrow);
          burrow.activeStepIndex = burrow.steps.length - 1;
        }
        burrow.lastAccessedAt = Date.now();
        changed = true;
      }
      else if (active && !active.inherited) { active.url = changeInfo.url; changed = true; }
    }

    active = burrow.steps[burrow.activeStepIndex] || null;
    if (active && !active.inherited) { // Fill in title/favicon once the page finishes loading
      if (title) {
        const clean = cleanStepTitle(active.url, title);
        if (active.title !== clean) {
          active.title = clean;
          changed = true;
          for (const b of burrows) if (b.branchedFrom?.stepId === active.stepId) b.branchedFrom.stepTitle = clean;
        }
      }
      if (changeInfo.favIconUrl && active.favIconUrl !== changeInfo.favIconUrl) { active.favIconUrl = changeInfo.favIconUrl; changed = true; }
    }
    return changed;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => { // Pass closed parent steps down to children & archive to graveyard
  pendingOpenerMap.delete(tabId);
  pendingStepJumpMap.delete(tabId);
  setFirstStep(tabId, null).catch(() => {});

  withState((state) => {
    let changed = false;
    for (const b of state.burrows) {
      const idx = b.tabIds.indexOf(tabId);
      if (idx !== -1) { b.tabIds.splice(idx, 1); changed = true; }
      const prev = b.branchedTo.length;
      b.branchedTo = b.branchedTo.filter((l) => l.fromTabId !== tabId);
      if (b.branchedTo.length !== prev) changed = true;
    }
    if (!changed) return false;

    const surviving = state.burrows.filter((b) => b.tabIds.length > 0);
    const pruned = state.burrows.filter((b) => b.tabIds.length === 0);
    const alive = new Map(surviving.map((b) => [b.id, b]));
    const dead = new Map(pruned.map((b) => [b.id, b]));
    const metaMap = new Map(pruned.map((p) => [p.id, { inheritedByChildIds: [], inheritedStepIds: [], childSplitMap: {} }]));

    for (const child of surviving) { // Walk up any closed ancestors so surviving kids don't lose their backstory
      if (!child.branchedFrom || !dead.has(child.branchedFrom.burrowId)) continue;
      const parentId = child.branchedFrom.burrowId, splitId = child.branchedFrom.stepId;
      let cursor = dead.get(parentId), chain = [], ancestorLink = null;

      while (cursor) {
        const copied = (cursor.steps || []).map((s) => ({ ...s, stepId: `inherited-${s.stepId}-${Math.random().toString(36).slice(2, 5)}`, inherited: true }));
        const m = metaMap.get(cursor.id);
        if (m) {
          if (!m.inheritedByChildIds.includes(child.id)) m.inheritedByChildIds.push(child.id);
          copied.forEach((cs) => m.inheritedStepIds.push(cs.stepId));
          if (cursor.id === parentId && splitId) m.childSplitMap[child.id] = splitId;
        }
        chain = [...copied, ...chain];
        if (!cursor.branchedFrom) break;
        if (alive.has(cursor.branchedFrom.burrowId)) { ancestorLink = cursor.branchedFrom; break; }
        cursor = dead.get(cursor.branchedFrom.burrowId) || null;
      }

      const prevIdx = getActiveIdx(child);
      child.steps = [...chain, ...(child.steps || [])];
      child.activeStepIndex = Math.min(prevIdx + chain.length, Math.max(0, child.steps.length - 1));

      if (ancestorLink) { // Re-attach orphaned child to its nearest living ancestor (e.g., grandparent)
        const gp = alive.get(ancestorLink.burrowId);
        child.branchedFrom = { burrowId: gp.id, tabId: ancestorLink.tabId, stepId: ancestorLink.stepId, stepTitle: ancestorLink.stepTitle };
        if (!gp.branchedTo.some((l) => l.burrowId === child.id)) {
          gp.branchedTo.push({ burrowId: child.id, fromTabId: ancestorLink.tabId, fromStepId: ancestorLink.stepId, windowId: child.windowId });
        }
      }
      else child.branchedFrom = null;
    }

    const now = Date.now();
    for (const p of pruned) { // Save closed burrows so Ctrl+Shift+T can bring them back
      if (p.steps.some((s) => s.url && !isInternalURL(s.url))) {
        state.closedBurrows.unshift({ closedAt: now, burrow: JSON.parse(JSON.stringify(p)), ...metaMap.get(p.id) });
      }
    }
    state.closedBurrows = state.closedBurrows.slice(0, MAX_CLOSED_BURROWS);

    for (const b of surviving) {
      if (b.branchedFrom && !alive.has(b.branchedFrom.burrowId)) b.branchedFrom = null;
      b.branchedTo = b.branchedTo.filter((l) => alive.has(l.burrowId));
    }
    state.burrows = surviving;
    return true;
  });
});

// --- UI Message Routing ---

const focusAndUpdateTab = async (tabId, props = { active: true }) => {
  const t = await chrome.tabs.get(tabId);
  await chrome.windows.update(t.windowId, { focused: true });
  await chrome.tabs.update(tabId, props);
  return t;
};

const DRAWER_ACTIONS = {
  ACTIVATE_TAB: ({ tabId }) => focusAndUpdateTab(tabId).then(() => ({ ok: true })),
  async NAVIGATE_STEP({ tabId, url, stepIndex }) {
    const t = await chrome.tabs.get(tabId);
    const props = { active: true };
    if (url) {
      pendingStepJumpMap.set(tabId, { targetURL: url, stepIndex });
      if (normalizeURLForCompare(t.url) !== normalizeURLForCompare(url)) props.url = url;
      else if (typeof stepIndex === "number") { // Already on this URL, just move the active step marker
        await withState(({ burrows }) => {
          const b = burrows.find((x) => x.tabIds.includes(tabId));
          if (!b) return false;
          b.activeStepIndex = stepIndex;
          return true;
        });
      }
    }
    await focusAndUpdateTab(tabId, props);
    return { ok: true };
  },
  CLOSE_TAB: ({ tabId }) => chrome.tabs.remove(tabId).then(() => ({ ok: true })),
  async CLOSE_BURROW({ burrowId }) {
    const { burrows } = await chrome.storage.local.get("burrows");
    const target = (burrows || []).find((b) => b.id === burrowId);
    if (target?.tabIds.length) await chrome.tabs.remove([...target.tabIds]);
    return { ok: true };
  },
  async SLEEP_BURROW({ burrowId }) { // Discard background tabs in this burrow to free up RAM
    const { burrows } = await chrome.storage.local.get("burrows");
    const target = (burrows || []).find((b) => b.id === burrowId);
    let slept = 0;
    for (const tid of (target?.tabIds || [])) {
      try { const t = await chrome.tabs.get(tid); if (!t.active && !t.discarded) { await chrome.tabs.discard(tid); slept++; } }
      catch { /* Can't discard active or protected tabs */ }
    }
    return { ok: true, slept };
  },
  NEW_TAB: () => chrome.tabs.create({}).then(() => ({ ok: true }))
};

const MESSAGE_HANDLERS = {
  async START_MANUAL_BURROW(_msg, sender) { // Triggered when clicking "+ New Burrow" in the UI
    const winId = sender?.tab?.windowId;
    const [tab] = await chrome.tabs.query(typeof winId === "number" ? { active: true, windowId: winId } : { active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") return { ok: false, error: "No active tab found." };

    const url = tab.pendingUrl || tab.url || "";
    if (isInternalURL(url)) return { ok: false, error: "Cannot start a burrow on an internal browser page." };

    let result = null;
    await withState(async ({ burrows }) => {
      const existing = burrows.find((b) => b.tabIds.includes(tab.id));
      if (existing) { existing.lastAccessedAt = Date.now(); result = existing; return true; }

      const { firstSteps } = await getSession();
      const saved = firstSteps[tab.id];
      await setFirstStep(tab.id, null);

      const step = saved ? { ...saved, title: cleanStepTitle(saved.url, saved.title) } : buildStepFromTab(tab, url);
      result = createBurrow(tab.windowId, [tab.id], [step]);
      burrows.push(result);
      return true;
    });
    return { ok: true, burrow: result };
  },
  async SET_BURROW_HIDDEN({ burrowId, hidden }) { // Remember collapse/expand state across the Side Panel and Drawer
    let target = null;
    await withState(({ burrows }) => {
      target = burrows.find((b) => b.id === burrowId) || null;
      if (!target) return false;
      target.hidden = Boolean(hidden);
      return true;
    });
    return target ? { ok: true, burrow: target } : { ok: false, error: "Burrow not found." };
  },
  async REGISTER_STEP_JUMP({ tabId, url, stepIndex }) {
    if (typeof tabId === "number" && url) pendingStepJumpMap.set(tabId, { targetURL: url, stepIndex });
    return { ok: true };
  },
  async GET_DRAWER_STATE(_msg, sender) {
    const winId = sender?.tab?.windowId;
    const [tabs, data] = await Promise.all([
      chrome.tabs.query(typeof winId === "number" ? { windowId: winId } : { currentWindow: true }),
      chrome.storage.local.get("burrows")
    ]);
    return { ok: true, tabs, burrows: data.burrows || [], activeTabId: sender?.tab?.id ?? null };
  },
  DRAWER_TAB_ACTION: (msg) => DRAWER_ACTIONS[msg.action] ? DRAWER_ACTIONS[msg.action](msg) : Promise.resolve({ ok: false, error: "Unknown drawer action." })
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && MESSAGE_HANDLERS[msg.type];
  if (!fn) return false;
  fn(msg, sender).then((res) => sendResponse(res)).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});