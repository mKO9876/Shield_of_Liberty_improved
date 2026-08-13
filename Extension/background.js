import { CONFIG } from "./config.js"
import { extractRequestData } from './helper.js';
import { initializeRules, clearRulesForTab, addBlockingRule } from './rules.js';

const tabRequestBuffers = {}; // { tabId: [extractedFeatureDict, ...] }
const tabResetting = new Set();

//console.log("I'M DOING SOMETHING")

chrome.runtime.onStartup.addListener(async () => {
    //console.log("Extnesion created - Running setup...");
    await initializeRules();
});

// 1. Reset rules when the user navigates to a new page in a tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    //console.log("ON UPDATE TAB, BACKGROUND")
    // Reset on new navigation
    if (changeInfo.status === 'loading' && changeInfo.url) {
        if (tabTimers[tabId]) {
            clearInterval(tabTimers[tabId]);
            delete tabTimers[tabId];
        }
        tabResetting.add(tabId);
        tabRequestBuffers[tabId] = [];
        clearRulesForTab(tabId);
        tabResetting.delete(tabId);
    }

    // Page fully loaded — ask content script for DOM graph
    if (changeInfo.status === 'complete') {
        if (!tab.url ||
            tab.url.startsWith('chrome://') ||
            tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('about:') ||
            tab.url.startsWith('data:')) {
            return;
        }
        startPeriodicFlush(tabId);

        setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: 'extractDOM' }).catch(err => {
                console.warn(`Could not reach content script on tab ${tabId}:`, err.message);
            });
        }, 500)
    }
});

// 2. Clean up rules when a tab is closed to prevent memory/ID leaks
chrome.tabs.onRemoved.addListener((tabId) => {
    console.log(`Tab ${tabId} closed. Cleaning up rules...`);
    clearRulesForTab(tabId);
});

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId === -1) return;
        const storageKey = `start_${details.requestId}`;
        chrome.storage.session.set({ [storageKey]: Date.now() });
    },
    { urls: ["http://*/*", "https://*/*"] }
);

// Buffer extracted features (not raw details) during page load
chrome.webRequest.onHeadersReceived.addListener(
    async (details) => {
        //console.log("I'M COLLECTING FEATURES")
        if (details.tabId === -1 || details.type === 'main_frame') return;
        if (tabResetting.has(details.tabId)) return;
        const apiOrigin = new URL(CONFIG.FLASK_API_PREDICT).origin;
        if (new URL(details.url).origin === apiOrigin) return;

        // Extract features client-side (same as before) and buffer the result
        const features = await extractRequestData(details);  // your existing helper.js function
        if (!tabRequestBuffers[details.tabId]) tabRequestBuffers[details.tabId] = [];
        tabRequestBuffers[details.tabId].push(features);
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders"]
);

// Listener za popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'domGraph') {
        const tabId = sender.tab.id;
        const requests = tabRequestBuffers[tabId] || [];
        // console.log("requests: ", requests)
        // console.log("possible requests: ", tabRequestBuffers[tabId])

        fetch(CONFIG.FLASK_API_PREDICT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tabId,
                domGraph: message.graph,   // { mainPageUrl, graph: { nodes, edges } }
                requests                   // [ ...extracted feature dicts ]
            })
        })
            .then(r => r.json())
            .then(async result => {
                // result.blocked = [ { url, mainPageUrl, resourceType }, ... ]
                // console.log("result", result)
                console.log("result. blocked", result.blocked)
                for (const item of result.blocked) {
                    const safeFilter = item.url.replace(/([?*^|])/g, '\\$1');
                    await addBlockingRule(safeFilter, tabId);
                }
                chrome.tabs.sendMessage(tabId, {
                    action: 'neutralize',
                    blockedUrls: result.blocked.map(i => i.url)
                });
            })
            .catch(console.error);

        return true;
    }

    else if (message.action === "getBlockedContent") {
        const tabId = message.tabId;

        // Fetch dynamic rules matching this tabId
        chrome.declarativeNetRequest.getSessionRules().then(rules => {
            const tabRules = rules.filter(rule =>
                rule.condition.tabIds && rule.condition.tabIds.includes(tabId)
            );

            // Format rules for display in popup
            const blockedContent = tabRules.map(rule => ({
                url: rule.condition.urlFilter,
                type: rule.condition.resourceTypes ? rule.condition.resourceTypes.join(', ') : 'All'
            }));

            sendResponse({ blockedContent: blockedContent });
        }).catch(err => {
            console.error("Failed to fetch dynamic rules:", err);
            sendResponse({ blockedContent: [] });
        });

        return true; // Keeps message channel open for async response
    }
});

const tabTimers = {}; // { tabId: intervalId }

function startPeriodicFlush(tabId) {
    // Clear any existing timer for this tab
    if (tabTimers[tabId]) clearInterval(tabTimers[tabId]);
    
    tabTimers[tabId] = setInterval(async () => {
        const buffer = tabRequestBuffers[tabId];
        if (!buffer || buffer.length === 0) return;

            let tab;
            try { tab = await chrome.tabs.get(tabId); } 
            catch { clearInterval(tabTimers[tabId]); delete tabTimers[tabId]; return; }

            if (!tab.url || /^(chrome|chrome-extension|about|data):/.test(tab.url)) return;


        // Only send requests that arrived since last flush
        const toSend = [...buffer];
        tabRequestBuffers[tabId] = []; // clear buffer immediately

        try {
            const tab = await chrome.tabs.get(tabId);
            
            // Get fresh DOM graph
            chrome.tabs.sendMessage(tabId, { action: 'extractDOM' }, async (domGraph) => {
                 if (chrome.runtime.lastError) {
                    console.warn(chrome.runtime.lastError.message);
                    return; // don't fetch with garbage domGraph
                }
                
                const response = await fetch(CONFIG.FLASK_API_PREDICT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tabId,
                        domGraph: domGraph || {},
                        requests: toSend
                    })
                });

                const result = await response.json();
                for (const item of result.blocked || []) {
                    const safeFilter = item.url.replace(/([?*^|])/g, '\\$1');
                    await addBlockingRule(safeFilter, tabId);
                }

                chrome.tabs.sendMessage(tabId, {
                    action: 'neutralize',
                    blockedUrls: (result.blocked || []).map(i => i.url)
                });
            });
        } catch (err) {
            console.warn(`Periodic flush failed for tab ${tabId}:`, err);
        }
    }, 30000); // flush every 30 seconds
}


// Stop timer when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabTimers[tabId]) {
        clearInterval(tabTimers[tabId]);
        delete tabTimers[tabId];
    }
    clearRulesForTab(tabId);
});