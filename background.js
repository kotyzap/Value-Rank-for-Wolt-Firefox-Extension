/* Background script (Firefox port): enable (light up) the toolbar icon only
 * on Wolt domains, and grey it out (disabled) everywhere else.
 *
 * The Chrome build uses chrome.declarativeContent for this, but Firefox does
 * not implement that API. Instead we track tab URL changes directly and
 * toggle the action per-tab.
 *
 * Note: host_permissions only cover wolt.com/wolt.cz, so tab.url is only
 * visible to us on those tabs — on every other tab it comes back undefined,
 * which we correctly treat as "not Wolt" and disable the icon for. No extra
 * "tabs" permission is needed. */

function isWoltUrl(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return /(^|\.)wolt\.com$/.test(hostname) || /(^|\.)wolt\.cz$/.test(hostname);
  } catch (e) {
    return false;
  }
}

function updateAction(tabId, url) {
  if (typeof tabId !== "number") return;
  if (isWoltUrl(url)) {
    chrome.action.enable(tabId);
  } else {
    chrome.action.disable(tabId);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateAction(tabId, tab && tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => updateAction(tabId, tab && tab.url));
});

function initAllTabs() {
  chrome.action.disable(); // off by default, same as the Chrome build
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) updateAction(tab.id, tab.url);
  });
}

chrome.runtime.onInstalled.addListener(initAllTabs);
chrome.runtime.onStartup.addListener(initAllTabs);
