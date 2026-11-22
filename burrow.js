let burrows = []; // All visible burrows from chrome.storage.local
let tabsById = new Map(); // Live Chrome tabs keyed by tab ID
let activeBurrowIndex = 0; // Currently displayed burrow index

const DEFAULT_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#57534e"><circle cx="8" cy="8" r="6"/></svg>',
  );

// --- Helpers --- //

function createElement(tag, props = {}, ...children) {
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

function formatAge(timestamp) {
  if (!timestamp) return "0m";
  const mins = Math.max(1, Math.floor((Date.now() - timestamp) / 60000));
  return mins < 60
    ? `${mins}m`
    : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function showBurrow(index) {
  if (index >= 0 && index < burrows.length) {
    activeBurrowIndex = index;
    renderBurrow();
  }
}

// --- Data Sync & Tab Navigation --- //

async function refreshBurrows() {
  try {
    const [{ burrows: stored }, openTabs] = await Promise.all([
      chrome.storage.local.get("burrows"),
      chrome.tabs.query({}),
    ]);
    burrows = Array.isArray(stored) ? stored.filter((b) => !b.hidden) : [];
    tabsById = new Map(openTabs.map((t) => [t.id, t]));
    activeBurrowIndex = burrows.length
      ? Math.max(0, Math.min(activeBurrowIndex, burrows.length - 1))
      : 0;
    renderBurrow();
  } catch (err) {
    console.error("Failed to load burrows:", err);
  }
}

async function openStep(burrow, step, stepIndex) {
  const tabId = burrow.tabIds?.[0];
  if (typeof tabId !== "number") return;

  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.runtime.sendMessage({
      type: "REGISTER_STEP_JUMP",
      tabId,
      url: step.url,
      stepIndex,
    });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true, url: step.url });
  } catch {
    refreshBurrows();
  }
}

// --- Rendering --- //

function renderBurrow() {
  const counterEl = document.getElementById("burrowCounter");
  const prevBtn = document.getElementById("prevBurrowBtn");
  const nextBtn = document.getElementById("nextBurrowBtn");
  const headerEl = document.getElementById("signpost");
  const listEl = document.getElementById("tunnelMap");

  prevBtn.disabled = activeBurrowIndex <= 0;
  nextBtn.disabled = activeBurrowIndex >= burrows.length - 1;
  headerEl.innerHTML = "";
  listEl.innerHTML = "";

  if (!burrows.length) {
    counterEl.textContent = "Burrow 0 of 0";
    headerEl.append(
      createElement("div", {
        className: "sign-meta",
        textContent: "🌱 No active burrows underground",
      }),
    );
    listEl.append(
      createElement("div", {
        className: "empty-state",
        textContent:
          "🐇 All tunnels are clear.\nBrowse across links to start a burrow automatically.",
      }),
    );
    return;
  }

  const burrow = burrows[activeBurrowIndex];
  const steps = Array.isArray(burrow.steps) ? burrow.steps : [];
  const currentStepIdx =
    typeof burrow.activeStepIndex === "number"
      ? Math.min(burrow.activeStepIndex, steps.length - 1)
      : steps.length - 1;
  const tab = tabsById.get(burrow.tabIds?.[0]);
  const isSleeping = Boolean(tab?.discarded);
  const isFocused = Boolean(tab?.active);
  const parentBurrow = burrow.branchedFrom?.burrowId
    ? burrows.find((b) => b.id === burrow.branchedFrom.burrowId)
    : null;

  const statusText = isSleeping
    ? "💤 Sleeping"
    : isFocused
      ? "● Active"
      : `● Idle (${formatAge(burrow.lastAccessedAt || burrow.createdAt)})`;
  const statusClass =
    isSleeping || !isFocused ? "status-sleep" : "status-active";

  counterEl.textContent = `Burrow ${activeBurrowIndex + 1} of ${burrows.length}`;

  // Burrow summary bar + Hide, Sleep & Close buttons
  headerEl.append(
    createElement(
      "div",
      { className: "sign-meta" },
      createElement("span", {
        textContent: `🪨 ${steps.length} step${steps.length === 1 ? "" : "s"}`,
      }),
      createElement("span", { textContent: "•" }),
      createElement("span", {
        textContent: `⏳ ${formatAge(burrow.createdAt)}`,
      }),
      createElement("span", { textContent: "•" }),
      createElement("span", {
        className: statusClass,
        textContent: statusText,
      }),
    ),
    createElement(
      "div",
      { className: "sign-actions" },
      createElement("button", {
        className: "sign-btn",
        title: "Hide Burrow",
        textContent: "👁️",
        onclick: async () => {
          await chrome.runtime.sendMessage({
            type: "SET_BURROW_HIDDEN",
            burrowId: burrow.id,
            hidden: true,
          });
          refreshBurrows();
        },
      }),
      createElement("button", {
        className: "sign-btn",
        title: "Sleep Burrow",
        textContent: "💤",
        onclick: async () => {
          for (const id of burrow.tabIds || []) {
            const t = tabsById.get(id);
            if (t && !t.active && !t.discarded) {
              try {
                await chrome.tabs.discard(id);
              } catch {}
            }
          }
          refreshBurrows();
        },
      }),
      createElement("button", {
        className: "sign-btn is-close",
        title: "Close Burrow",
        textContent: "✕",
        onclick: async () => {
          if (burrow.tabIds?.length)
            await chrome.tabs.remove([...burrow.tabIds]);
        },
      }),
    ),
  );

  if (parentBurrow) {
    listEl.append(
      createElement("button", {
        className: "back-banner",
        textContent: `↖ Back to Main Tunnel (${burrow.branchedFrom.stepTitle || "Parent"})`,
        onclick: () =>
          showBurrow(burrows.findIndex((b) => b.id === parentBurrow.id)),
      }),
    );
  }

  // Step rows + branch links
  steps.forEach((step, idx) => {
    const isInherited = Boolean(step.inherited);
    const stepCard = createElement(
      "div",
      {
        className: `pebble${idx === currentStepIdx ? " is-current" : ""}${isInherited ? " is-inherited" : ""}`,
        title: step.url || step.title,
        onclick: () => openStep(burrow, step, idx),
      },
      createElement("img", {
        className: "pebble-fav",
        src: step.favIconUrl || DEFAULT_ICON,
        onerror() {
          this.src = DEFAULT_ICON;
        },
      }),
      createElement("span", {
        className: "pebble-title",
        textContent: step.title || step.url || `Step ${idx + 1}`,
      }),
    );

    const branchButtons = (burrow.branchedTo || [])
      .filter((branch) =>
        branch.fromStepId
          ? branch.fromStepId === step.stepId
          : idx === steps.length - 1 && branch.fromTabId === burrow.tabIds?.[0],
      )
      .map((branch) => {
        const childIdx = burrows.findIndex((b) => b.id === branch.burrowId);
        if (childIdx === -1) return null;
        return createElement(
          "button",
          {
            className: "doorway",
            title: "Open branched burrow",
            onclick: () => showBurrow(childIdx),
          },
          "🚪 →",
        );
      });

    listEl.append(
      createElement(
        "div",
        { className: "step-cluster" },
        stepCard,
        ...branchButtons,
      ),
    );
  });
}

// --- Navigation & Event Listeners --- //

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("prevBurrowBtn").onclick = () =>
    showBurrow(activeBurrowIndex - 1);
  document.getElementById("nextBurrowBtn").onclick = () =>
    showBurrow(activeBurrowIndex + 1);

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") showBurrow(activeBurrowIndex - 1);
    if (e.key === "ArrowRight") showBurrow(activeBurrowIndex + 1);
  });

  refreshBurrows();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.burrows) refreshBurrows();
});
[chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated].forEach(
  (event) => event.addListener(refreshBurrows),
);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title || info.favIconUrl || info.discarded !== undefined)
    refreshBurrows();
});
