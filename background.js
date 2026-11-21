// Keeps track of the states and ensures everything stays concurrent
let storageQueue = Promise.resolve();
const pendingOpenerMap = new Map();
let lastActiveExternalTab = null; // tabId, windowId, timestamp


function enqueueStorageTask(taskFn) { // Adds the next tab to the list in its respective burrow
  const next = storageQueue.then(() => taskFn());

  storageQueue = next.catch((err) => {
    console.error("Rabbit Hole storage task error:", err);
  });

  return next;
}


function isInternalURL(rawURL) { // Checks the URL to see what it has 
  if (!rawURL) return false; // No pollution allowed (settings)

  const blockedPrefixes = [
    "edge://",
    "chrome://",
    "extension://",
    "chrome-extension://",
    "about:"
  ];

  return blockedPrefixes.some((prefix) => rawURL.startsWith(prefix));
}


function createBurrowObject({ id, windowId, tabIds, branchedFrom = null }) { // Generates a record of the burrow from start
  const now = Date.now();
  let burrowId = id;

  if (!burrowId) { // Generate a fallback ID if none was passed in
    burrowId = `burrow-${now}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return {
    id: burrowId,
    title: "New Research Burrow",
    windowId,
    tabIds: [...tabIds],
    branchedFrom,
    branchedTo: [],
    hidden: false,
    createdAt: now,
    lastAccessedAt: now
  };
}


async function linkChildTabToParent({ childTabId, childWindowId, childURL, openerTabId }) { // Connects from either same vs diff window
  if (!childURL || isInternalURL(childURL)) return;

  await enqueueStorageTask(async () => {
    let openerTab;

    try {
      openerTab = await chrome.tabs.get(openerTabId);
    }
    catch {
      return; // Parent is closed
    }

    const openerURL = openerTab.pendingUrl || openerTab.url || "";
    if (isInternalURL(openerURL)) return;

    const data = await chrome.storage.local.get("burrows");
    let burrows = [];

    if (Array.isArray(data.burrows)) { // Use stored burrows if initialized
      burrows = data.burrows;
    }

    const now = Date.now();
    let parentBurrow = burrows.find((b) => b.tabIds.includes(openerTab.id));

    if (openerTab.windowId === childWindowId) {
      // Same Window
      if (parentBurrow) { // append to parent's burrow
        if (!parentBurrow.tabIds.includes(childTabId)) { // Avoid adding duplicate tab IDs
          parentBurrow.tabIds.push(childTabId);
        }

        parentBurrow.lastAccessedAt = now;
      }
      else { // start a new 2-tab burrow
        burrows.push(
          createBurrowObject({
            windowId: childWindowId,
            tabIds: [openerTab.id, childTabId]
          })
        );
      }
    }
    else {
      // New Window, keep parent intact in its original burrow and make a linked child burrow
      if (!parentBurrow) { // Parent wasn't in a burrow yet, wrap it in a 1-tab root burrow
        parentBurrow = createBurrowObject({
          windowId: openerTab.windowId,
          tabIds: [openerTab.id]
        });

        burrows.push(parentBurrow);
      }

      const childBurrow = createBurrowObject({
        windowId: childWindowId,
        tabIds: [childTabId],
        branchedFrom: {
          burrowId: parentBurrow.id,
          tabId: openerTab.id
        }
      });

      parentBurrow.branchedTo.push({
        burrowId: childBurrow.id,
        fromTabId: openerTab.id
      });

      parentBurrow.lastAccessedAt = now;
      burrows.push(childBurrow);
    }

    await chrome.storage.local.set({ burrows });
  });
}


chrome.runtime.onInstalled.addListener(async () => { // Sets up empty storage on first install
  await enqueueStorageTask(async () => {
    const existing = await chrome.storage.local.get("burrows");

    if (!Array.isArray(existing.burrows)) { // Only initialize if no burrows array exists yet
      await chrome.storage.local.set({ burrows: [] });
    }
  });

  console.log("Rabbit Hole initialized.");
});


chrome.sidePanel // Opens the Side Panel HUD when clicking the extension icon
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("Side Panel setup failed:", err));


chrome.tabs.onCreated.addListener((tab) => { // Catches new tabs right as they spawn
  if (typeof tab.id !== "number") return;

  const targetURL = tab.pendingUrl || tab.url || "";
  if (isInternalURL(targetURL)) return; // Skip browser internal tabs

  // Get openerTabId directly, or guess it from last active tab if Edge stripped it in a new window
  let resolvedOpenerId = null;

  if (typeof tab.openerTabId === "number") { // Browser provided explicit parent tab ID
    resolvedOpenerId = tab.openerTabId;
  }

  if ( // Infer parent tab when opened in a new window within 5s of active external tab
    resolvedOpenerId === null &&
    targetURL &&
    lastActiveExternalTab &&
    tab.windowId !== lastActiveExternalTab.windowId &&
    Date.now() - lastActiveExternalTab.timestamp < 5000
  ) {
    resolvedOpenerId = lastActiveExternalTab.tabId;
  }

  if (typeof resolvedOpenerId !== "number") return;

  if (targetURL) { // URL is already loaded, link immediately
    linkChildTabToParent({
      childTabId: tab.id,
      childWindowId: tab.windowId,
      childURL: targetURL,
      openerTabId: resolvedOpenerId
    });
  }
  else { // URL is blank for now, wait for onUpdated to deliver it
    pendingOpenerMap.set(tab.id, {
      openerTabId: resolvedOpenerId,
      windowId: tab.windowId
    });
  }
});


chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => { // Tracks which tab the user switches to
  try {
    const tab = await chrome.tabs.get(tabId);
    const activeURL = tab.pendingUrl || tab.url || "";

    if (activeURL && !isInternalURL(activeURL)) { // Save as last active external tab
      lastActiveExternalTab = { tabId, windowId, timestamp: Date.now() };
    }
  }
  catch {
    // Tab closed before lookup finished
  }

  enqueueStorageTask(async () => { // Refresh lastAccessedAt for the active burrow
    const data = await chrome.storage.local.get("burrows");
    let burrows = [];

    if (Array.isArray(data.burrows)) { // Use stored burrows if initialized
      burrows = data.burrows;
    }

    const burrow = burrows.find((b) => b.tabIds.includes(tabId));

    if (!burrow) return;

    burrow.lastAccessedAt = Date.now();
    await chrome.storage.local.set({ burrows });
  });
});


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { // Handles URL changes and delayed Edge tab URLs
  if (!changeInfo.url) return;

  if (tab.active && !isInternalURL(changeInfo.url)) { // Keep lastActiveExternalTab fresh on navigation
    lastActiveExternalTab = {
      tabId,
      windowId: tab.windowId,
      timestamp: Date.now()
    };
  }

  // Resolve tabs that spawned with a blank URL in onCreated
  if (pendingOpenerMap.has(tabId)) { // Tab was waiting in queue for Edge to assign its destination URL
    const pending = pendingOpenerMap.get(tabId);
    pendingOpenerMap.delete(tabId);

    if (!isInternalURL(changeInfo.url)) { // Only link once confirmed it didn't resolve to an internal page
      let resolvedWindowId = pending.windowId;

      if (typeof tab.windowId === "number") { // Prefer current windowId from updated tab if available
        resolvedWindowId = tab.windowId;
      }

      linkChildTabToParent({
        childTabId: tabId,
        childWindowId: resolvedWindowId,
        childURL: changeInfo.url,
        openerTabId: pending.openerTabId
      });
    }

    return;
  }

  // Remove tab from its burrow if the user navigates to an internal browser page
  if (!isInternalURL(changeInfo.url)) return;

  enqueueStorageTask(async () => {
    const data = await chrome.storage.local.get("burrows");
    let burrows = [];

    if (Array.isArray(data.burrows)) { // Use stored burrows if initialized
      burrows = data.burrows;
    }

    let changed = false;

    for (const b of burrows) {
      const idx = b.tabIds.indexOf(tabId);

      if (idx !== -1) { // Found the tab in this burrow, splice it out
        b.tabIds.splice(idx, 1);
        changed = true;
      }
    }

    if (changed) { // Drop burrows that no longer have 2+ tabs or cross-window links
      const cleaned = burrows.filter((b) => {
        const hasLinks = Boolean(b.branchedFrom) || b.branchedTo.length > 0;
        return b.tabIds.length > 1 || (b.tabIds.length === 1 && hasLinks);
      });

      await chrome.storage.local.set({ burrows: cleaned });
    }
  });
});


chrome.tabs.onRemoved.addListener((tabId) => { // Cleans up closed tabs and prunes dead burrows
  pendingOpenerMap.delete(tabId);

  enqueueStorageTask(async () => {
    const data = await chrome.storage.local.get("burrows");
    let burrows = [];

    if (Array.isArray(data.burrows)) { // Use stored burrows if initialized
      burrows = data.burrows;
    }

    let changed = false;

    for (const b of burrows) {
      const idx = b.tabIds.indexOf(tabId);

      if (idx !== -1) { // Remove closed tab ID from burrow
        b.tabIds.splice(idx, 1);
        changed = true;
      }

      const prevLen = b.branchedTo.length; // Remove branch links tied to this closed tab
      b.branchedTo = b.branchedTo.filter((link) => link.fromTabId !== tabId);

      if (b.branchedTo.length !== prevLen) { // Mark dirty if any child branch pointers were removed
        changed = true;
      }
    }

    if (!changed) return;

    // Keep burrows with 2+ tabs, or 1-tab burrows still linked across windows
    const survivingBurrows = burrows.filter((b) => {
      const isLinked = Boolean(b.branchedFrom) || b.branchedTo.length > 0;
      return b.tabIds.length > 1 || (b.tabIds.length === 1 && isLinked);
    });

    // Strip any dangling pointers to burrows that were just pruned
    const survivingIds = new Set(survivingBurrows.map((b) => b.id));

    for (const b of survivingBurrows) {
      if (b.branchedFrom && !survivingIds.has(b.branchedFrom.burrowId)) { // Clear parent link if parent burrow was pruned
        b.branchedFrom = null;
      }

      b.branchedTo = b.branchedTo.filter((link) => survivingIds.has(link.burrowId));
    }

    await chrome.storage.local.set({ burrows: survivingBurrows });
  });
});


chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => { // Listens for UI commands from the Side Panel
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "START_MANUAL_BURROW") { // Starts a burrow on the current tab via button click
    enqueueStorageTask(async () => {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!activeTab || typeof activeTab.id !== "number") {
        return { ok: false, error: "No active tab found." };
      }

      const activeURL = activeTab.pendingUrl || activeTab.url || "";
      if (isInternalURL(activeURL)) {
        return { ok: false, error: "Cannot start a burrow on an internal browser page." };
      }

      const data = await chrome.storage.local.get("burrows");
      let burrows = [];

      if (Array.isArray(data.burrows)) { // Use stored burrows if initialized
        burrows = data.burrows;
      }

      const existing = burrows.find((b) => b.tabIds.includes(activeTab.id));

      if (existing) { // Tab is already tracked, just bump timestamp
        existing.lastAccessedAt = Date.now();
        await chrome.storage.local.set({ burrows });
        return { ok: true, burrow: existing };
      }

      const newBurrow = createBurrowObject({ // Create a standalone 1-tab burrow
        windowId: activeTab.windowId,
        tabIds: [activeTab.id]
      });

      burrows.push(newBurrow);
      await chrome.storage.local.set({ burrows });
      return { ok: true, burrow: newBurrow };
    })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true; // Keep message channel open for async response
  }

  if (message.type === "SET_BURROW_HIDDEN") { // Toggles hidden state for collapsing a burrow in the UI
    const { burrowId, hidden } = message;

    enqueueStorageTask(async () => {
      const data = await chrome.storage.local.get("burrows");
      let burrows = [];

      if (Array.isArray(data.burrows)) { // Use stored burrows if initialized
        burrows = data.burrows;
      }

      const target = burrows.find((b) => b.id === burrowId);

      if (!target) {
        return { ok: false, error: "Burrow not found." };
      }

      target.hidden = Boolean(hidden);
      await chrome.storage.local.set({ burrows });
      return { ok: true, burrow: target };
    })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true; // Keep message channel open for async response
  }

  return false;
});