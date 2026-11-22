let storageQueue = Promise.resolve(); // Mutex lock so rapid tab events don't overwrite each other in storage
const pendingOpenerMap = new Map(); // Stashes parent tab info if a new tab opens before its URL loads
const pendingStepJumpMap = new Map(); // Remembers manual step clicks so we move the cursor instead of duplicating

const MAX_CLOSED_BURROWS = 25; // Keep the last 25 closed burrows around for Ctrl+Shift+T recovery
const RESTORE_WINDOW_MS = 10 * 60 * 1000; // 10-minute window to resurrect a closed burrow
const BLOCKED_PREFIXES = [
  "edge://",
  "chrome://",
  "extension://",
  "chrome-extension://",
  "about:",
  "https://ntp.msn.com",
  "http://ntp.msn.com",
];
const SEARCH_HOSTS = ["bing.com", "google.com", "duckduckgo.com"];

// --- Storage & Session --- //

// Queues up read-modify-write ops on local storage so events run one at a time
const withState = (fn) => {
  const next = storageQueue.then(async () => {
    const data = await chrome.storage.local.get(["burrows", "closedBurrows"]);
    const state = {
      burrows: data.burrows || [],
      closedBurrows: data.closedBurrows || [],
    };
    if (await fn(state)) await chrome.storage.local.set(state);
    return state;
  });
  storageQueue = next.catch((e) =>
    console.error("Rabbit Hole storage error:", e),
  );
  return next;
};

// Grab temp session data (1-page tabs waiting to become burrows + last focused tab)
const getSession = async () => {
  const d = await chrome.storage.session.get([
    "untrackedFirstSteps",
    "lastActiveExternalTab",
  ]);
  return {
    firstSteps: d.untrackedFirstSteps || {},
    lastActive: d.lastActiveExternalTab || null,
  };
};

// Save or clear a tab's first page before it navigates a second time
const setFirstStep = async (tabId, stepOrNull) => {
  const { firstSteps } = await getSession();
  stepOrNull ? (firstSteps[tabId] = stepOrNull) : delete firstSteps[tabId];
  await chrome.storage.session.set({ untrackedFirstSteps: firstSteps });
};

// Remember the last normal tab you looked at (helps catch cross-window forks)
const recordExternalTab = (tabId, windowId, url) => {
  if (url && !isInternalURL(url)) {
    chrome.storage.session
      .set({
        lastActiveExternalTab: { tabId, windowId, timestamp: Date.now() },
      })
      .catch(() => {});
  }
};

// --- URL, Title & Step Helpers --- //

const isInternalURL = (u) =>
  Boolean(u) && BLOCKED_PREFIXES.some((p) => u.startsWith(p));
const isRedirectHop = (u) =>
  /bing\.com\/(ck\/a|aclick)|google\.com\/url\?/.test(u);

// Keeps activeStepIndex safely inside the steps array
const getActiveIdx = (b) =>
  Math.max(
    0,
    Math.min(
      typeof b.activeStepIndex === "number"
        ? b.activeStepIndex
        : b.steps.length - 1,
      b.steps.length - 1,
    ),
  );

function parseURL(raw) {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./, "");
    const isEngine =
      parsed.pathname.includes("/search") || SEARCH_HOSTS.includes(host);
    return {
      parsed,
      host,
      isEngine,
      query: (parsed.searchParams.get("q") || "").trim(),
    };
  } catch {
    return null;
  }
}

// Skip internal browser pages, ad redirect wrappers, and blank search pages
const isTrackableURL = (u) => {
  if (!u || isInternalURL(u) || isRedirectHop(u)) return false;
  const info = parseURL(u);
  return !(info && info.parsed.pathname.includes("/search") && !info.query);
};

// Cleans up URLs before comparing them so reloads and #anchors don't count as new steps
function normalizeURLForCompare(raw) {
  const info = raw ? parseURL(raw) : null;
  if (!info) return raw || "";
  const { parsed, host, isEngine, query } = info;
  if (isEngine && query)
    return `${parsed.protocol}//${host}/search?q=${query.toLowerCase()}`;

  // Keep Gmail/SPA hash routes intact, strip normal page #anchors
  const hash = parsed.hash || "";
  if ((host === "mail.google.com" || /^#[!/]/.test(hash)) && hash.length > 1) {
    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${hash.split("?")[0].replace(/\/+$/, "")}`;
  }

  // Drop tracking params, only keep meaningful IDs like YouTube ?v=
  const kept = new URLSearchParams();
  for (const k of ["v", "id", "p"])
    if (parsed.searchParams.get(k)) kept.set(k, parsed.searchParams.get(k));
  const qs = kept.toString();
  return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${qs ? `?${qs}` : ""}`;
}

// Fixes raw URLs or "New tab" titles with something cleaner
function cleanStepTitle(url, rawTitle) {
  const info = parseURL(url);
  const fallback =
    info?.isEngine && info.query
      ? `${info.query} - Search`
      : url || "Untitled Page";
  if (!rawTitle || rawTitle === "New tab" || /^https?:\/\//.test(rawTitle))
    return fallback;
  if (
    info?.isEngine &&
    info.query &&
    !rawTitle.toLowerCase().includes(info.query.toLowerCase())
  )
    return fallback;
  return rawTitle;
}

const buildStep = (
  tabId,
  url,
  title = "",
  favIconUrl = "",
  inherited = false,
) => ({
  stepId: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  tabId,
  url,
  title: cleanStepTitle(url, title),
  favIconUrl: favIconUrl || "",
  visitedAt: Date.now(),
  inherited, // True if we copied this step from a parent tab that got closed
});

const buildStepFromTab = (tab, url = "", inherited = false) =>
  buildStep(
    tab.id,
    url || tab.pendingUrl || tab.url || "",
    tab.title,
    tab.favIconUrl,
    inherited,
  );

// Pulls a tab's saved first page out of session storage when promoting it to a burrow
async function consumeInitialStep(tab, fallbackUrl) {
  const { firstSteps } = await getSession();
  const saved = firstSteps[tab.id];
  await setFirstStep(tab.id, null);
  return saved
    ? { ...saved, title: cleanStepTitle(saved.url, saved.title) }
    : buildStepFromTab(tab, fallbackUrl);
}

// Removes a tabId from whichever burrow owns it
function detachTabFromBurrows(burrows, tabId) {
  let dirty = false;
  for (const b of burrows) {
    const i = b.tabIds.indexOf(tabId);
    if (i !== -1) {
      b.tabIds.splice(i, 1);
      dirty = true;
    }
  }
  return dirty;
}

// Collapses back-to-back duplicate URLs (like quick redirects) into a single step
function deduplicateSteps(burrow) {
  if (!burrow?.steps || burrow.steps.length < 2) return;
  const out = [burrow.steps[0]];
  for (let i = 1; i < burrow.steps.length; i++) {
    const prev = out[out.length - 1],
      curr = burrow.steps[i];
    if (
      normalizeURLForCompare(prev.url) === normalizeURLForCompare(curr.url) &&
      Boolean(prev.inherited) === Boolean(curr.inherited)
    ) {
      if (curr.title && !curr.title.startsWith("http")) prev.title = curr.title;
      if (curr.favIconUrl) prev.favIconUrl = curr.favIconUrl;
      prev.url = curr.url;
    } else out.push(curr);
  }
  burrow.steps = out;
  burrow.activeStepIndex = getActiveIdx(burrow);
}

// Creates a new burrow object (basically our PCB for a browsing trail)
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
  lastAccessedAt: Date.now(),
});

// --- Lineage, Resurrection & Branching --- //

function tryResurrectClosedBurrow({
  tabId,
  windowId,
  url,
  burrows,
  closedBurrows,
}) {
  if (!isTrackableURL(url) || !closedBurrows.length) return false;
  const norm = normalizeURLForCompare(url),
    now = Date.now();

  // Check if this URL matches a burrow closed within the last 10 mins (Ctrl+Shift+T)
  const idx = closedBurrows.findIndex(
    (e) =>
      e &&
      now - (e.closedAt || 0) <= RESTORE_WINDOW_MS &&
      e.burrow?.steps?.length &&
      normalizeURLForCompare(e.burrow.steps[getActiveIdx(e.burrow)].url) ===
        norm,
  );
  if (idx === -1) return false;

  const [archived] = closedBurrows.splice(idx, 1);
  const revived = archived.burrow;
  const alive = new Map(burrows.map((b) => [b.id, b]));

  Object.assign(revived, {
    windowId,
    tabIds: [tabId],
    hidden: false,
    lastAccessedAt: now,
    branchedTo: [],
    steps: revived.steps.map((s) => ({ ...s, tabId })),
    activeStepIndex: Math.max(0, revived.steps.length - 1),
  });

  // Hook back up to its original parent if that parent is still open
  if (revived.branchedFrom && alive.has(revived.branchedFrom.burrowId)) {
    const anc = alive.get(revived.branchedFrom.burrowId);
    if (!anc.branchedTo.some((l) => l.burrowId === revived.id)) {
      anc.branchedTo.push({
        burrowId: revived.id,
        fromTabId: revived.branchedFrom.tabId,
        fromStepId: revived.branchedFrom.stepId,
        windowId,
      });
    }
  } else revived.branchedFrom = null;

  // Strip the temporary inherited steps we lent to any surviving children
  const inheritedSet = new Set(archived.inheritedStepIds || []);
  const fallbackSplit = revived.steps[revived.steps.length - 1] || null;

  for (const childId of archived.inheritedByChildIds || []) {
    const child = alive.get(childId);
    if (!child) continue;

    if (inheritedSet.size && child.steps) {
      const removedBefore = child.steps
        .slice(0, getActiveIdx(child) + 1)
        .filter((s) => inheritedSet.has(s.stepId)).length;
      child.steps = child.steps.filter((s) => !inheritedSet.has(s.stepId));
      child.activeStepIndex = Math.max(
        0,
        Math.min(getActiveIdx(child) - removedBefore, child.steps.length - 1),
      );
    }
    if (child.branchedFrom && alive.has(child.branchedFrom.burrowId)) {
      const gp = alive.get(child.branchedFrom.burrowId);
      gp.branchedTo = gp.branchedTo.filter((l) => l.burrowId !== child.id);
    }

    // Re-link the child directly back to this revived parent
    const origin =
      revived.steps.find(
        (s) => s.stepId === archived.childSplitMap?.[child.id],
      ) || fallbackSplit;
    child.branchedFrom = {
      burrowId: revived.id,
      tabId,
      stepId: origin?.stepId || null,
      stepTitle: origin?.title || "Main timeline",
    };
    revived.branchedTo.push({
      burrowId: child.id,
      fromTabId: tabId,
      fromStepId: origin?.stepId || null,
      windowId: child.windowId,
    });
  }

  burrows.push(revived);
  return true;
}

async function linkChildToParent(
  childTabId,
  childWindowId,
  childURL,
  openerTabId,
) {
  if (!childURL || isInternalURL(childURL)) return;
  await withState(async ({ burrows }) => {
    let opener, childTab;
    try {
      [opener, childTab] = await Promise.all([
        chrome.tabs.get(openerTabId),
        chrome.tabs.get(childTabId),
      ]);
    } catch {
      return false;
    }

    const openerURL = opener.pendingUrl || opener.url || "";
    if (
      isInternalURL(openerURL) ||
      burrows.some((b) => b.tabIds.includes(childTabId))
    )
      return false;

    // Promote the parent tab into a real burrow first if it was still just 1 page
    let parent = burrows.find((b) => b.tabIds.includes(opener.id));
    if (!parent) {
      parent = createBurrow(
        opener.windowId,
        [opener.id],
        [await consumeInitialStep(opener, openerURL)],
      );
      burrows.push(parent);
    }
    await setFirstStep(childTabId, null);

    // Fork the child burrow off the parent's current active step
    const split = parent.steps[getActiveIdx(parent)];
    const child = createBurrow(
      childWindowId,
      [childTabId],
      [buildStepFromTab(childTab, childURL)],
      {
        burrowId: parent.id,
        tabId: opener.id,
        stepId: split.stepId,
        stepTitle: split.title,
      },
    );

    parent.branchedTo.push({
      burrowId: child.id,
      fromTabId: opener.id,
      fromStepId: split.stepId,
      windowId: childWindowId,
    });
    parent.lastAccessedAt = Date.now();
    burrows.push(child);
    return true;
  });
}

// --- Tab & Lifecycle Listeners --- //

chrome.runtime.onInstalled.addListener(() => withState(() => true));
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("Side Panel error:", e));

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id !== "number") return;
  const url = tab.pendingUrl || tab.url || "";
  if (isInternalURL(url)) return;

  // Catch cross-window forks when Chrome leaves openerTabId null
  let openerId = typeof tab.openerTabId === "number" ? tab.openerTabId : null;
  if (openerId === null && url) {
    const { lastActive } = await getSession();
    if (
      lastActive &&
      tab.windowId !== lastActive.windowId &&
      Date.now() - lastActive.timestamp < 5000
    )
      openerId = lastActive.tabId;
  }

  if (typeof openerId === "number") {
    // Fork right away if URL is ready, otherwise stash in pendingOpenerMap until onUpdated
    url
      ? linkChildToParent(tab.id, tab.windowId, url, openerId)
      : pendingOpenerMap.set(tab.id, {
          openerTabId: openerId,
          windowId: tab.windowId,
        });
  } else if (url) {
    // No parent tab -> see if this is a Ctrl+Shift+T restore
    withState(async ({ burrows, closedBurrows }) => {
      if (burrows.some((b) => b.tabIds.includes(tab.id))) return false;
      const ok = tryResurrectClosedBurrow({
        tabId: tab.id,
        windowId: tab.windowId,
        url,
        burrows,
        closedBurrows,
      });
      if (ok) await setFirstStep(tab.id, null);
      return ok;
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // Update the last-focused tab in case you drag/open a link into a new window
  try {
    const t = await chrome.tabs.get(tabId);
    recordExternalTab(tabId, windowId, t.pendingUrl || t.url || "");
  } catch {}

  withState(({ burrows }) => {
    const b = burrows.find((x) => x.tabIds.includes(tabId));
    if (!b) return false;
    b.lastAccessedAt = Date.now();
    return true;
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || "",
    title = changeInfo.title || "",
    favicon = changeInfo.favIconUrl || tab.favIconUrl || "";

  if (changeInfo.url && tab.active)
    recordExternalTab(tabId, tab.windowId, changeInfo.url);

  // Deferred fork: link to parent now that the new tab's URL finally loaded
  if (changeInfo.url && pendingOpenerMap.has(tabId)) {
    const p = pendingOpenerMap.get(tabId);
    pendingOpenerMap.delete(tabId);
    if (!isInternalURL(changeInfo.url))
      linkChildToParent(
        tabId,
        typeof tab.windowId === "number" ? tab.windowId : p.windowId,
        changeInfo.url,
        p.openerTabId,
      );
    return;
  }

  // Stop tracking if you navigate to chrome://, settings, etc.
  if (changeInfo.url && isInternalURL(changeInfo.url)) {
    setFirstStep(tabId, null).catch(() => {});
    withState((s) => {
      if (!detachTabFromBurrows(s.burrows, tabId)) return false;
      s.burrows = s.burrows.filter((b) => b.tabIds.length > 0);
      return true;
    });
    return;
  }

  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;

withState(async ({ burrows, closedBurrows }) => {
    const burrow = burrows.find((b) => b.tabIds.includes(tabId));
    if (burrow?.hidden) return false;

    // Not in a burrow yet
    if (!burrow) {
      if (!isTrackableURL(url)) return false;
      const { firstSteps } = await getSession();
      const first = firstSteps[tabId] || null;

      // 1st page: check for Ctrl+Shift+T restore, otherwise hold it in session storage
      if (!first) {
        if (
          tryResurrectClosedBurrow({
            tabId,
            windowId: tab.windowId,
            url,
            burrows,
            closedBurrows,
          })
        ) {
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

      // Still on the 1st page, just update its title/favicon while waiting
      if (normalizeURLForCompare(url) === normalizeURLForCompare(first.url)) {
        let dirty = false;
        if (title) {
          const next = cleanStepTitle(first.url, title);
          if (first.title !== next) {
            first.title = next;
            dirty = true;
          }
        }
        if (
          changeInfo.favIconUrl &&
          first.favIconUrl !== changeInfo.favIconUrl
        ) {
          first.favIconUrl = changeInfo.favIconUrl;
          dirty = true;
        }
        if (dirty) await setFirstStep(tabId, first);
        return false;
      }

      // 2-step promotion: you clicked to a 2nd page, so turn this tab into a real burrow
      await setFirstStep(tabId, null);
      const promoted = createBurrow(
        tab.windowId,
        [tabId],
        [
          { ...first, title: cleanStepTitle(first.url, first.title) },
          buildStep(tabId, url, title, favicon),
        ],
      );
      deduplicateSteps(promoted);
      burrows.push(promoted);
      return true;
    }

    // Already in a burrow
    burrow.activeStepIndex = getActiveIdx(burrow);
    let changed = false,
      active = burrow.steps[burrow.activeStepIndex] || null;

    if (changeInfo.url && isTrackableURL(changeInfo.url)) {
      const inNorm = normalizeURLForCompare(changeInfo.url),
        actNorm = active ? normalizeURLForCompare(active.url) : "";
      const jump = pendingStepJumpMap.get(tabId);

      // Manual step click in the UI: move the active highlight without adding a duplicate
      if (jump && normalizeURLForCompare(jump.targetURL) === inNorm) {
        pendingStepJumpMap.delete(tabId);
        const idx = burrow.steps.findIndex((s, i) =>
          jump.stepIndex !== undefined
            ? i === jump.stepIndex
            : normalizeURLForCompare(s.url) === inNorm,
        );
        if (idx !== -1) {
          burrow.activeStepIndex = idx;
          burrow.lastAccessedAt = Date.now();
          changed = true;
        }
      } else if (inNorm !== actNorm) {
        // Check if you hit browser Back or Forward (matches activeStepIndex - 1 or + 1)
        const adj = [
          burrow.activeStepIndex - 1,
          burrow.activeStepIndex + 1,
        ].find(
          (i) =>
            i >= 0 &&
            i < burrow.steps.length &&
            normalizeURLForCompare(burrow.steps[i].url) === inNorm,
        );
        if (adj !== undefined) burrow.activeStepIndex = adj;
        else {
          // Brand-new page: append it to the end of the trail
          burrow.steps.push(buildStep(tabId, changeInfo.url, title, favicon));
          deduplicateSteps(burrow);
          burrow.activeStepIndex = burrow.steps.length - 1;
        }
        burrow.lastAccessedAt = Date.now();
        changed = true;
      } else if (active && !active.inherited) {
        active.url = changeInfo.url;
        changed = true;
      }
    }

    // Fill in title/favicon once the page finishes loading, and update any forked child labels
    active = burrow.steps[burrow.activeStepIndex] || null;
    if (active && !active.inherited) {
      if (title) {
        const clean = cleanStepTitle(active.url, title);
        if (active.title !== clean) {
          active.title = clean;
          changed = true;
          for (const b of burrows)
            if (b.branchedFrom?.stepId === active.stepId)
              b.branchedFrom.stepTitle = clean;
        }
      }
      if (
        changeInfo.favIconUrl &&
        active.favIconUrl !== changeInfo.favIconUrl
      ) {
        active.favIconUrl = changeInfo.favIconUrl;
        changed = true;
      }
    }
    return changed;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingOpenerMap.delete(tabId);
  pendingStepJumpMap.delete(tabId);
  setFirstStep(tabId, null).catch(() => {});

  withState((state) => {
    if (!detachTabFromBurrows(state.burrows, tabId)) return false;

    const surviving = state.burrows.filter((b) => b.tabIds.length > 0);
    const pruned = state.burrows.filter((b) => b.tabIds.length === 0);
    const alive = new Map(surviving.map((b) => [b.id, b]));
    const dead = new Map(pruned.map((b) => [b.id, b]));
    const metaMap = new Map(
      pruned.map((p) => [
        p.id,
        { inheritedByChildIds: [], inheritedStepIds: [], childSplitMap: {} },
      ]),
    );

    // Orphan reparenting: if a parent burrow closed, copy its steps into surviving children
    for (const child of surviving) {
      if (!child.branchedFrom || !dead.has(child.branchedFrom.burrowId))
        continue;
      const parentId = child.branchedFrom.burrowId,
        splitId = child.branchedFrom.stepId;
      let cursor = dead.get(parentId),
        chain = [],
        ancestorLink = null;

      // Walk up any chain of dead ancestors until we hit root or a living grandparent
      while (cursor) {
        const copied = (cursor.steps || []).map((s) => ({
          ...s,
          stepId: `inherited-${s.stepId}-${Math.random().toString(36).slice(2, 5)}`,
          inherited: true,
        }));
        const m = metaMap.get(cursor.id);
        if (m) {
          if (!m.inheritedByChildIds.includes(child.id))
            m.inheritedByChildIds.push(child.id);
          copied.forEach((cs) => m.inheritedStepIds.push(cs.stepId));
          if (cursor.id === parentId && splitId)
            m.childSplitMap[child.id] = splitId;
        }
        chain = [...copied, ...chain];
        if (!cursor.branchedFrom) break;
        if (alive.has(cursor.branchedFrom.burrowId)) {
          ancestorLink = cursor.branchedFrom;
          break;
        }
        cursor = dead.get(cursor.branchedFrom.burrowId) || null;
      }

      // Prepend the inherited steps and shift activeStepIndex so the highlight stays on the right step
      const prevIdx = getActiveIdx(child);
      child.steps = [...chain, ...(child.steps || [])];
      child.activeStepIndex = Math.min(
        prevIdx + chain.length,
        Math.max(0, child.steps.length - 1),
      );

      // Point the child to the nearest living ancestor (or make it a root burrow)
      if (ancestorLink) {
        const gp = alive.get(ancestorLink.burrowId);
        child.branchedFrom = {
          burrowId: gp.id,
          tabId: ancestorLink.tabId,
          stepId: ancestorLink.stepId,
          stepTitle: ancestorLink.stepTitle,
        };
        if (!gp.branchedTo.some((l) => l.burrowId === child.id)) {
          gp.branchedTo.push({
            burrowId: child.id,
            fromTabId: ancestorLink.tabId,
            fromStepId: ancestorLink.stepId,
            windowId: child.windowId,
          });
        }
      } else child.branchedFrom = null;
    }

    // Save closed burrows to closedBurrows in case you hit Ctrl+Shift+T
    const now = Date.now();
    for (const p of pruned) {
      if (p.steps.some((s) => s.url && !isInternalURL(s.url))) {
        state.closedBurrows.unshift({
          closedAt: now,
          burrow: { ...p },
          ...metaMap.get(p.id),
        });
      }
    }
    state.closedBurrows = state.closedBurrows.slice(0, MAX_CLOSED_BURROWS);

    // Clean up dead child links on surviving burrows
    for (const b of surviving) {
      b.branchedTo = b.branchedTo.filter((l) => alive.has(l.burrowId));
    }
    state.burrows = surviving;
    return true;
  });
});

// --- UI Message Routing --- //

const MESSAGE_HANDLERS = {

  // Eye button: hide/unhide the hover card in the side panel
  async SET_BURROW_HIDDEN({ burrowId, hidden }) {
    let target = null;
        await withState(({ burrows }) => {
        target = burrows.find((b) => b.id === burrowId) || null;
        if (!target) return false;
        target.hidden = Boolean(hidden);
        return true;
        });
        return target
        ? { ok: true, burrow: target }
        : { ok: false, error: "Burrow not found." };
    },
    async REGISTER_STEP_JUMP({ tabId, url, stepIndex }) {
        if (typeof tabId === "number" && url)
        pendingStepJumpMap.set(tabId, { targetURL: url, stepIndex });
        return { ok: true };
    },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && MESSAGE_HANDLERS[msg.type];
  if (!fn) return false;
  fn(msg, sender)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
