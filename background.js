let storageQueue = Promise.resolve(); // Keep storage writes in order so rapid tab events don't clobber each other
const pendingOpenerMap = new Map(); // Holds parent info when a new tab opens before its URL loads
const pendingStepJumpMap = new Map(); // Tracks manual step clicks so we move the highlight instead of duplicating

const MAX_CLOSED_BURROWS = 25;
const RESTORE_WINDOW_MS = 10 * 60 * 1000; // Give users 10 mins to hit Ctrl+Shift+T and bring a burrow back
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

const setFirstStep = async (tabId, stepOrNull) => {
  const { firstSteps } = await getSession();
  stepOrNull ? (firstSteps[tabId] = stepOrNull) : delete firstSteps[tabId];
  await chrome.storage.session.set({ untrackedFirstSteps: firstSteps });
};

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

const isTrackableURL = (u) => {
  if (!u || isInternalURL(u) || isRedirectHop(u)) return false;
  const info = parseURL(u);
  return !(info && info.parsed.pathname.includes("/search") && !info.query);
};

function normalizeURLForCompare(raw) {
  const info = raw ? parseURL(raw) : null;
  if (!info) return raw || "";
  const { parsed, host, isEngine, query } = info;
  if (isEngine && query)
    return `${parsed.protocol}//${host}/search?q=${query.toLowerCase()}`;

  const hash = parsed.hash || "";
  if ((host === "mail.google.com" || /^#[!/]/.test(hash)) && hash.length > 1) {
    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${hash.split("?")[0].replace(/\/+$/, "")}`;
  }

  const kept = new URLSearchParams();
  for (const k of ["v", "id", "p"])
    if (parsed.searchParams.get(k)) kept.set(k, parsed.searchParams.get(k));
  const qs = kept.toString();
  return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${qs ? `?${qs}` : ""}`;
}

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
  inherited,
});

const buildStepFromTab = (tab, url = "", inherited = false) =>
  buildStep(
    tab.id,
    url || tab.pendingUrl || tab.url || "",
    tab.title,
    tab.favIconUrl,
    inherited,
  );

async function consumeInitialStep(tab, fallbackUrl) {
  const { firstSteps } = await getSession();
  const saved = firstSteps[tab.id];
  await setFirstStep(tab.id, null);
  return saved
    ? { ...saved, title: cleanStepTitle(saved.url, saved.title) }
    : buildStepFromTab(tab, fallbackUrl);
}

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
    url
      ? linkChildToParent(tab.id, tab.windowId, url, openerId)
      : pendingOpenerMap.set(tab.id, {
          openerTabId: openerId,
          windowId: tab.windowId,
        });
  } else if (url) {
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

    if (!burrow) {
      if (!isTrackableURL(url)) return false;
      const { firstSteps } = await getSession();
      const first = firstSteps[tabId] || null;

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

    burrow.activeStepIndex = getActiveIdx(burrow);
    let changed = false,
      active = burrow.steps[burrow.activeStepIndex] || null;

    if (changeInfo.url && isTrackableURL(changeInfo.url)) {
      const inNorm = normalizeURLForCompare(changeInfo.url),
        actNorm = active ? normalizeURLForCompare(active.url) : "";
      const jump = pendingStepJumpMap.get(tabId);

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

    for (const child of surviving) {
      if (!child.branchedFrom || !dead.has(child.branchedFrom.burrowId))
        continue;
      const parentId = child.branchedFrom.burrowId,
        splitId = child.branchedFrom.stepId;
      let cursor = dead.get(parentId),
        chain = [],
        ancestorLink = null;

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

      const prevIdx = getActiveIdx(child);
      child.steps = [...chain, ...(child.steps || [])];
      child.activeStepIndex = Math.min(
        prevIdx + chain.length,
        Math.max(0, child.steps.length - 1),
      );

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

    for (const b of surviving) {
      b.branchedTo = b.branchedTo.filter((l) => alive.has(l.burrowId));
    }
    state.burrows = surviving;
    return true;
  });
});

// --- UI Message Routing --- //

const MESSAGE_HANDLERS = {
  async START_MANUAL_BURROW() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || typeof tab.id !== "number")
      return { ok: false, error: "No active tab found." };

    const url = tab.pendingUrl || tab.url || "";
    if (isInternalURL(url))
      return {
        ok: false,
        error: "Cannot start a burrow on an internal browser page.",
      };

    let result = null;
    await withState(async ({ burrows }) => {
      const existing = burrows.find((b) => b.tabIds.includes(tab.id));
      if (existing) {
        existing.lastAccessedAt = Date.now();
        result = existing;
        return true;
      }
      result = createBurrow(
        tab.windowId,
        [tab.id],
        [await consumeInitialStep(tab, url)],
      );
      burrows.push(result);
      return true;
    });
    return { ok: true, burrow: result };
  },
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