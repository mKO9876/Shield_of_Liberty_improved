import { CONFIG } from "./config.js"
import { extractRequestData } from './helper.js';
import { initializeRules, clearRulesForTab, addBlockingRule } from './rules.js';

const tabRequestBuffers = {}; // { tabId: [extractedFeatureDict, ...] }
const tabResetting = new Set();
const tabInitialLoadDone = {}; // { tabId: true } — tracks whether /predict was already called
const tabMainPageUrls = {}; // { tabId: mainPageUrl } — tracks the current page URL per tab
const tabTimers = {}; // { tabId: intervalId }
const requestHeadersCache = {}; // { requestId: requestHeaders[] } — temporary cache for req headers

chrome.runtime.onStartup.addListener(async () => {
    await initializeRules();
});

// 1. Reset rules when the user navigates to a new page in a tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Reset on new navigation
    if (changeInfo.status === 'loading' && changeInfo.url) {
        // Stop periodic flush timer
        if (tabTimers[tabId]) {
            clearInterval(tabTimers[tabId]);
            delete tabTimers[tabId];
        }

        // Clear stored graphs on the server for the OLD page
        const oldMainPageUrl = tabMainPageUrls[tabId];
        clearServerGraphs(tabId, oldMainPageUrl);

        // Reset local state
        tabResetting.add(tabId);
        tabRequestBuffers[tabId] = [];
        tabInitialLoadDone[tabId] = false;
        tabMainPageUrls[tabId] = changeInfo.url;
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

        // Save the main page URL for this tab
        tabMainPageUrls[tabId] = tab.url;

        // Start periodic flush for incremental predictions
        startPeriodicFlush(tabId);

        // Request DOM graph from content script (triggers initial /predict)
        setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: 'extractDOM' }).catch(err => {
                console.warn(`Could not reach content script on tab ${tabId}:`, err.message);
            });
        }, 500);
    }
});

// 2. Clean up rules and server state when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    console.log(`Tab ${tabId} closed. Cleaning up...`);
    
    // Stop timer
    if (tabTimers[tabId]) {
        clearInterval(tabTimers[tabId]);
        delete tabTimers[tabId];
    }

    // Clear server-side graphs for this tab (all pages)
    clearServerGraphs(tabId, null);

    // Clean up local state
    clearRulesForTab(tabId);
    delete tabRequestBuffers[tabId];
    delete tabInitialLoadDone[tabId];
    delete tabMainPageUrls[tabId];
});

// 3. Track request start time for latency calculation
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId === -1) return;
        const storageKey = `start_${details.requestId}`;
        chrome.storage.session.set({ [storageKey]: Date.now() });
    },
    { urls: ["http://*/*", "https://*/*"] }
);

// 3b. Capture request headers when request is sent (not available in onHeadersReceived)
chrome.webRequest.onSendHeaders.addListener(
    (details) => {
        if (details.tabId === -1) return;
        requestHeadersCache[details.requestId] = details.requestHeaders || [];
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["requestHeaders"]
);

// 4. Buffer extracted features during page load
chrome.webRequest.onHeadersReceived.addListener(
    async (details) => {
        if (details.tabId === -1 || details.type === 'main_frame') return;
        if (tabResetting.has(details.tabId)) return;
        const apiOrigin = new URL(CONFIG.FLASK_API_PREDICT).origin;
        if (new URL(details.url).origin === apiOrigin) return;

        // Attach cached request headers to details before extracting features
        details.requestHeaders = requestHeadersCache[details.requestId] || [];
        delete requestHeadersCache[details.requestId]; // clean up

        const features = await extractRequestData(details);
        if (!tabRequestBuffers[details.tabId]) tabRequestBuffers[details.tabId] = [];
        tabRequestBuffers[details.tabId].push(features);
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders"]
);

// 5. Message listener — handles domGraph from content script and popup queries
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'domGraph') {
        const tabId = sender.tab.id;
        const requests = tabRequestBuffers[tabId] || [];

        // This is the INITIAL load — send everything to /predict
        tabRequestBuffers[tabId] = []; // clear buffer

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
                console.log("Initial /predict result.blocked:", result.blocked);
                
                // Mark initial load as done — future requests go to /predict_after
                tabInitialLoadDone[tabId] = true;

                for (const item of result.blocked || []) {
                    const safeFilter = item.url.replace(/([?*^|])/g, '\\$1');
                    await addBlockingRule(safeFilter, tabId);
                }
                chrome.tabs.sendMessage(tabId, {
                    action: 'neutralize',
                    blockedUrls: (result.blocked || []).map(i => i.url)
                });
            })
            .catch(console.error);

        return true;
    }

    else if (message.action === "getBlockedContent") {
        const tabId = message.tabId;

        chrome.declarativeNetRequest.getSessionRules().then(rules => {
            const tabRules = rules.filter(rule =>
                rule.condition.tabIds && rule.condition.tabIds.includes(tabId)
            );

            const blockedContent = tabRules.map(rule => ({
                url: rule.condition.urlFilter,
                type: rule.condition.resourceTypes ? rule.condition.resourceTypes.join(', ') : 'All'
            }));

            sendResponse({ blockedContent: blockedContent });
        }).catch(err => {
            console.error("Failed to fetch dynamic rules:", err);
            sendResponse({ blockedContent: [] });
        });

        return true;
    }
});

// ─── Periodic Flush: sends new requests to /predict_after ─────────────────────
function startPeriodicFlush(tabId) {
    if (tabTimers[tabId]) clearInterval(tabTimers[tabId]);
    
    tabTimers[tabId] = setInterval(async () => {
        // Only flush if initial /predict has been called already
        if (!tabInitialLoadDone[tabId]) return;

        const buffer = tabRequestBuffers[tabId];
        if (!buffer || buffer.length === 0) return;

        let tab;
        try { tab = await chrome.tabs.get(tabId); } 
        catch { clearInterval(tabTimers[tabId]); delete tabTimers[tabId]; return; }

        if (!tab.url || /^(chrome|chrome-extension|about|data):/.test(tab.url)) return;

        // Take all buffered requests
        const toSend = [...buffer];
        tabRequestBuffers[tabId] = [];

        const mainPageUrl = tabMainPageUrls[tabId] || tab.url;

        try {
            // Get fresh DOM graph to update the server's stored version
            chrome.tabs.sendMessage(tabId, { action: 'extractDOMForUpdate' }, async (domGraph) => {
                if (chrome.runtime.lastError) {
                    console.warn(chrome.runtime.lastError.message);
                    // Still send without DOM update
                }

                const response = await fetch(CONFIG.FLASK_API_PREDICT_AFTER, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tabId,
                        mainPageUrl: mainPageUrl,
                        domGraph: domGraph || null,  // optional DOM update
                        requests: toSend
                    })
                });

                const result = await response.json();
                
                console.log(`/predict_after result for tab ${tabId}:`, result.blocked?.length, "blocked");

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
            console.warn(`Periodic flush (/predict_after) failed for tab ${tabId}:`, err);
        }
    }, 30000); // flush every 30 seconds
}

// ─── Clear server-side stored graphs ──────────────────────────────────────────
function clearServerGraphs(tabId, mainPageUrl) {
    const body = { tabId };
    if (mainPageUrl) {
        console.log("MAIN PAGE: ", mainPageUrl)
        body.mainPageUrl = mainPageUrl;
    }

    fetch(CONFIG.FLASK_API_CLEAR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).catch(err => {
        // Non-critical — server may not be running, or tab was already cleared
        console.warn(`Failed to clear server graphs for tab ${tabId}:`, err.message);
    });
}
