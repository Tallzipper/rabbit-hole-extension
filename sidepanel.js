let hoveredBurrowTabId = null; // Tab currently showing its inline burrow trail card
let pinnedBurrowTabId = null; // Tab locked open by a click so hover doesn't dismiss it
let openWindowTabs = []; // Live Chrome tabs in the current browser window
let savedBurrows = []; // All tracked rabbit hole trails synced from storage

const FALLBACK_FAVICON_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#9b9996"><circle cx="8" cy="8" r="6"/></svg>',
  );

// --- DOM & URL Helpers --- //

function createElement(tag, props = {}, ...children) {
  // Builds a DOM node with properties, styles, attributes, and children
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (key === "style" && typeof val === "object")
      Object.assign(el.style, val);
    else if (key in el) el[key] = val;
    else el.setAttribute(key, val);
  }
  el.append(...children.filter(Boolean));
  return el;
}

function normalizeUrlForComparison(rawUrl) {
  // Keeps search queries & SPA hash routes intact while stripping article #anchors
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "");
    const query = (parsed.searchParams.get("q") || "").trim().toLowerCase();
    if (
      query &&
      (parsed.pathname.includes("/search") ||
        ["bing.com", "google.com", "duckduckgo.com"].includes(host))
    ) {
      return `${parsed.protocol}//${host}/search?q=${query}`;
    }
    const hash = parsed.hash || "";
    if (
      (host === "mail.google.com" ||
        hash.startsWith("#/") ||
        hash.startsWith("#!")) &&
      hash.length > 1
    ) {
      return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}${hash.split("?")[0].replace(/\/+$/, "")}`;
    }
    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return rawUrl;
  }
}

// --- Formatting & Lookup Helpers --- //

function resolveBurrowSteps(burrow, tabsById) {
  // Returns recorded timeline steps (or synthesizes fallback steps for older burrows)
  if (Array.isArray(burrow.steps) && burrow.steps.length) return burrow.steps;
  return burrow.tabIds.map((tabId) => {
    const tab = tabsById.get(tabId);
    return {
      stepId: `fallback-${tabId}`,
      tabId,
      url: tab?.url || "",
      title: tab?.title || tab?.url || `Tab #${tabId}`,
      favIconUrl: tab?.favIconUrl || "",
      inherited: false,
    };
  });
}

function formatElapsedTime(createdAt) {
  // Formats HH:MM:SS elapsed since a burrow was started
  if (!createdAt) return "00:00:00";
  const sec = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
    .map((u) => String(u).padStart(2, "0"))
    .join(":");
}

function formatActivityLabel(burrow, tabsById) {
  // Returns "Active", "💤 Sleeping", or a relative age like "2h ago"
  const burrowTabs = burrow.tabIds
    .map((id) => tabsById.get(id))
    .filter(Boolean);
  if (burrowTabs.some((t) => t.active)) return "Active";
  if (burrowTabs.length && burrowTabs.every((t) => t.discarded))
    return "💤 Sleeping";
  if (!burrow.lastAccessedAt) return "Active";

  const ageSec = Math.max(
    0,
    Math.floor((Date.now() - burrow.lastAccessedAt) / 1000),
  );
  if (ageSec < 60) return "Just now";
  const [divisor, suffix] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ].find(([s]) => ageSec >= s);
  return `${Math.floor(ageSec / divisor)}${suffix} ago`;
}

function showStatusBanner(message, durationMs = 2800) {
  // Briefly displays feedback at the top of the side panel
  const banner = document.getElementById("statusBanner");
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(showStatusBanner._timer);
  showStatusBanner._timer = setTimeout(
    () => banner.classList.add("hidden"),
    durationMs,
  );
}

const findBurrowByTabId = (tabId) =>
  savedBurrows.find(
    (b) => !b.hidden && Array.isArray(b.tabIds) && b.tabIds.includes(tabId),
  ) || null;
const findBurrowById = (burrowId) =>
  savedBurrows.find((b) => !b.hidden && b.id === burrowId) || null;

// --- State Hydration & Tab List Rendering --- //

async function syncTabsAndRender() {
  // Fetches live window tabs and stored burrows, then refreshes the UI
  try {
    const [tabs, { burrows }] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }),
      chrome.storage.local.get("burrows"),
    ]);
    openWindowTabs = tabs;
    savedBurrows = Array.isArray(burrows) ? burrows : [];
    if (
      hoveredBurrowTabId !== null &&
      (!findBurrowByTabId(hoveredBurrowTabId) ||
        !openWindowTabs.some((t) => t.id === hoveredBurrowTabId))
    ) {
      hoveredBurrowTabId = pinnedBurrowTabId = null;
    }
    renderTabList();
  } catch (err) {
    console.error("Failed to sync Rabbit Hole side panel:", err);
  }
}

function renderTabList() {
  // Draws the vertical tab list and expands the timeline card under the anchored tab
  const listEl = document.getElementById("tabList");
  if (!listEl) return;

  const tabsById = new Map(openWindowTabs.map((t) => [t.id, t]));
  listEl.innerHTML = "";

  for (const tab of openWindowTabs) {
    const burrow = findBurrowByTabId(tab.id);
    const fullTitle = tab.title || tab.url || "";
    const row = createElement(
      "div",
      {
        className: `tab-row${tab.active ? " is-active" : ""}${tab.discarded ? " is-discarded" : ""}`,
      },
      createElement(
        "div",
        { className: "tab-left" },
        createElement("img", {
          className: "tab-favicon",
          src: tab.favIconUrl || FALLBACK_FAVICON_URL,
          alt: "",
          onerror() {
            this.src = FALLBACK_FAVICON_URL;
          },
        }),
        createElement("span", {
          className: "tab-title",
          textContent: fullTitle || "New tab",
          title: fullTitle,
        }),
      ),
      createElement(
        "div",
        { className: "tab-right" },
        tab.discarded &&
          createElement("span", {
            className: "sleep-pill",
            textContent: "💤",
            title: "Tab sleeping",
          }),
        burrow &&
          createElement("span", {
            className: "hole-pill",
            title: "Active Rabbit Hole",
            textContent: `🐇 ${resolveBurrowSteps(burrow, tabsById).length}`,
          }),
        createElement("span", {
          className: "tab-close",
          title: "Close tab",
          textContent: "✕",
        }),
      ),
    );

    row.onmouseenter = () => {
      // Preview burrow card on hover unless another card is pinned
      if (
        !burrow &&
        pinnedBurrowTabId === null &&
        hoveredBurrowTabId !== null
      ) {
        hoveredBurrowTabId = null;
        renderTabList();
      } else if (
        burrow &&
        (pinnedBurrowTabId === null || pinnedBurrowTabId === tab.id) &&
        hoveredBurrowTabId !== tab.id
      ) {
        hoveredBurrowTabId = tab.id;
        renderTabList();
      }
    };

    row.onclick = async (e) => {
      // Close tab, or focus tab and pin its burrow timeline open
      if (e.target.classList.contains("tab-close"))
        return (e.stopPropagation(), chrome.tabs.remove(tab.id));
      hoveredBurrowTabId = pinnedBurrowTabId = burrow ? tab.id : null;
      await chrome.tabs.update(tab.id, { active: true });
      await syncTabsAndRender();
    };

    listEl.appendChild(
      createElement(
        "div",
        { className: "tab-entry", role: "listitem" },
        row,
        burrow &&
          hoveredBurrowTabId === tab.id &&
          buildBurrowTimelineCard(burrow, tab.id, tabsById),
      ),
    );
  }
}

// --- Inline Burrow Timeline Card --- //

function buildBurrowTimelineCard(burrow, anchorTabId, tabsById) {
  // Builds the expandable card showing steps, controls, and branches
  const steps = resolveBurrowSteps(burrow, tabsById);
  const ownerTabId = burrow.tabIds[0];
  const activeIdx =
    typeof burrow.activeStepIndex === "number"
      ? Math.min(burrow.activeStepIndex, steps.length - 1)
      : steps.length - 1;
  const dot = () =>
    createElement("span", { className: "meta-sep", textContent: "•" });
  const stepsContainer = createElement("div", { className: "popover-steps" });

  // Ancestor branch link if this burrow split off from an active parent trail
  const parentBurrow =
    burrow.branchedFrom?.burrowId &&
    findBurrowById(burrow.branchedFrom.burrowId);
  if (parentBurrow) {
    stepsContainer.appendChild(
      createElement(
        "button",
        {
          className: "side-tunnel-pill",
          style: { marginLeft: "8px" },
          title:
            "Jump back to the living ancestor timeline where this branch split off",
          onclick: (e) => {
            e.stopPropagation();
            focusBranchedBurrow(parentBurrow.id);
          },
        },
        createElement("span", {
          className: "step-title",
          textContent: `↖ Split from: ${burrow.branchedFrom.stepTitle || "Main timeline"}`,
        }),
      ),
    );
  }

  steps.forEach((step, index) => {
    const isInherited = Boolean(step.inherited);
    const fullTitle = step.title || step.url || "";
    const stepRow = createElement(
      "div",
      {
        className: `step-row${index === activeIdx ? " current" : ""}`,
        style: isInherited ? { opacity: "0.72" } : {},
      },
      createElement("img", {
        className: "step-favicon",
        src: step.favIconUrl || FALLBACK_FAVICON_URL,
        alt: "",
        onerror() {
          this.src = FALLBACK_FAVICON_URL;
        },
      }),
      createElement("span", {
        className: "step-title",
        textContent: fullTitle || `Step ${index + 1}`,
        title: isInherited
          ? `Inherited from closed parent tab: ${fullTitle}`
          : fullTitle,
      }),
      isInherited
        ? createElement("span", {
            style: { fontSize: "10px", color: "#555350" },
            textContent: "inherited",
          })
        : tabsById.get(ownerTabId)?.discarded &&
            createElement("span", {
              className: "step-sleep",
              textContent: "💤",
            }),
    );

    stepRow.onclick = async (e) => {
      // Time-travel this tab to the clicked step without duplicating history
      e.stopPropagation();
      if (typeof ownerTabId !== "number") return;
      try {
        const liveTab = await chrome.tabs.get(ownerTabId);
        await chrome.runtime.sendMessage({
          type: "REGISTER_STEP_JUMP",
          tabId: ownerTabId,
          url: step.url,
          stepIndex: index,
        });
        const payload =
          step.url &&
          normalizeUrlForComparison(liveTab.url) !==
            normalizeUrlForComparison(step.url)
            ? { active: true, url: step.url }
            : { active: true };
        await chrome.windows.update(liveTab.windowId, { focused: true });
        await chrome.tabs.update(ownerTabId, payload);
        await syncTabsAndRender();
      } catch {
        showStatusBanner("Tab for this timeline was closed.");
      }
    };
    stepsContainer.appendChild(stepRow);

    // Child side-tunnels branched from this step
    for (const link of (burrow.branchedTo || []).filter((l) =>
      l.fromStepId
        ? l.fromStepId === step.stepId
        : index === steps.length - 1 && l.fromTabId === ownerTabId,
    )) {
      const child = findBurrowById(link.burrowId);
      if (!child) continue;
      const childSteps = resolveBurrowSteps(child, tabsById);
      const firstStep = childSteps.find((s) => !s.inherited) || childSteps[0];
      const isNewWin = child.windowId !== burrow.windowId;
      stepsContainer.appendChild(
        createElement(
          "button",
          {
            className: "side-tunnel-pill",
            title: isNewWin
              ? "Focus branched window and open its timeline"
              : "Jump to split timeline branch",
            onclick: (e) => {
              e.stopPropagation();
              focusBranchedBurrow(link.burrowId);
            },
          },
          createElement("span", {
            className: "step-title",
            textContent: isNewWin
              ? "↳ Side tunnel (New Window) →"
              : `↳ Branch: ${firstStep?.title || "Split branch"}`,
          }),
          createElement("span", {
            textContent: `${childSteps.length} step${childSteps.length === 1 ? "" : "s"}`,
          }),
        ),
      );
    }
  });

  return createElement(
    "div",
    {
      className: "trail-popover",
      "data-burrow-id": burrow.id,
      onmouseenter: () => {
        hoveredBurrowTabId = anchorTabId;
      },
    },
    createElement(
      "div",
      { className: "popover-header" },
      createElement(
        "div",
        { className: "popover-meta" },
        createElement("span", { textContent: "🐇 Rabbit Hole" }),
        dot(),
        createElement("span", {
          textContent: `${steps.length} step${steps.length === 1 ? "" : "s"}`,
        }),
        dot(),
        createElement("span", {
          className: "live-elapsed-time",
          "data-created-at": String(burrow.createdAt || Date.now()),
          textContent: formatElapsedTime(burrow.createdAt),
        }),
        dot(),
        createElement("span", {
          textContent: formatActivityLabel(burrow, tabsById),
        }),
      ),
      createElement(
        "div",
        { className: "popover-actions" },
        createElement("button", {
          className: "pop-btn",
          title: "Hide Burrow",
          textContent: "👁️",
          onclick: async (e) => {
            e.stopPropagation();
            await chrome.runtime.sendMessage({
              type: "SET_BURROW_HIDDEN",
              burrowId: burrow.id,
              hidden: true,
            });
            hoveredBurrowTabId = pinnedBurrowTabId = null;
            await syncTabsAndRender();
          },
        }),
        createElement("button", {
          className: "pop-btn",
          title: "Sleep Hole (Discard inactive tabs)",
          textContent: "💤",
          onclick: async (e) => {
            e.stopPropagation();
            let slept = 0;
            for (const tid of burrow.tabIds) {
              const t = tabsById.get(tid);
              if (t && !t.active && !t.discarded)
                try {
                  await chrome.tabs.discard(tid);
                  slept++;
                } catch {}
            }
            showStatusBanner(
              slept
                ? `Put ${slept} tab${slept === 1 ? "" : "s"} in hole to sleep.`
                : "Inactive tabs in this hole are already sleeping.",
            );
            await syncTabsAndRender();
          },
        }),
        createElement("button", {
          className: "pop-btn pop-close",
          title: "Collapse Hole (Close trail tab)",
          textContent: "✕",
          onclick: async (e) => {
            e.stopPropagation();
            const ids = [...burrow.tabIds];
            hoveredBurrowTabId = pinnedBurrowTabId = null;
            if (ids.length) await chrome.tabs.remove(ids);
          },
        }),
      ),
    ),
    stepsContainer,
  );
}

async function focusBranchedBurrow(targetBurrowId) {
  // Switches focus to a linked parent or child burrow's window and tab
  const target = findBurrowById(targetBurrowId);
  if (!target?.tabIds.length)
    return showStatusBanner("Branched tab is no longer open.");
  try {
    hoveredBurrowTabId = pinnedBurrowTabId = target.tabIds[0];
    await chrome.windows.update(target.windowId, { focused: true });
    await chrome.tabs.update(target.tabIds[0], { active: true });
    await syncTabsAndRender();
  } catch {
    showStatusBanner("Could not focus branched tab.");
  }
}

// --- Toolbar Controls & Live Event Listeners --- //

function bindToolbarControls() {
  document
    .getElementById("burrowViewBtn")
    ?.addEventListener("click", () =>
      chrome.tabs.create({ url: chrome.runtime.getURL("burrow.html") }),
    );
  document
    .getElementById("newTabBtn")
    ?.addEventListener("click", () => chrome.tabs.create({}));
  const listEl = document.getElementById("tabList");
  listEl?.addEventListener("click", (e) => {
    if (e.target === listEl) {
      hoveredBurrowTabId = pinnedBurrowTabId = null;
      renderTabList();
    }
  });
}

setInterval(() => {
  // Keep the HH:MM:SS burrow duration timer ticking live while a card is open
  const timerEl = document.querySelector(".live-elapsed-time");
  if (timerEl?.dataset.createdAt)
    timerEl.textContent = formatElapsedTime(Number(timerEl.dataset.createdAt));
}, 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.burrows) syncTabsAndRender();
});
[chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated].forEach(
  (ev) => ev.addListener(syncTabsAndRender),
);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (
    info.url ||
    info.title ||
    info.favIconUrl ||
    info.discarded !== undefined ||
    info.status === "complete"
  )
    syncTabsAndRender();
});
document.addEventListener("DOMContentLoaded", () => {
  bindToolbarControls();
  syncTabsAndRender();
});
