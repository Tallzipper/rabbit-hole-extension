document.getElementById("openBurrowBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("burrow.html")});

});

chrome.storage.local.get("burrows", (res) => {
    console.log("Side panel storage check:", res);

}); 