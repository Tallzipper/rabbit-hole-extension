chrome.runtime.onInstalled.addListener(async () => {
    const existing = await chrome.storage .local.get("burrows");

    if(!Array.isArray(existing.burrows)){
        await chrome.storage.local.set({ burrows: [] });
    }
    
    console.log("Rabbit Hole initialized.");
});

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true})
    .catch((err) => console.error("Side Panel setup failed: ", err ));