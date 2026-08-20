const usedRuleIds = new Set();

export async function initializeRules() {
    try {
        usedRuleIds.clear();

        const [dynamicRules, sessionRules] = await Promise.all([
            chrome.declarativeNetRequest.getDynamicRules(),
            chrome.declarativeNetRequest.getSessionRules()
        ]);

        const dynamicIds = dynamicRules.map(r => r.id);
        const sessionIds = sessionRules.map(r => r.id);

        await Promise.all([
            chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamicIds }),
            chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: sessionIds })
        ]);

        console.log("Deck cleared: Dynamic and Session rules removed.");

    } catch (error) {
        console.error("Failed to clean up rules:", error);
    }
}

/**
 * Adds a blocking rule scoped STRICTLY to a specific tabId.
 * Skips if a rule with the same urlFilter already exists for this tab.
 */
export async function addBlockingRule(urlFilter, tabId) {
    if (!tabId) {
        console.warn("No tabId provided for rule; skipping to avoid global block.");
        return false;
    }

    // Check for duplicate: skip if this URL is already blocked for this tab
    try {
        const existingRules = await chrome.declarativeNetRequest.getSessionRules();
        const alreadyExists = existingRules.some(rule =>
            rule.condition.urlFilter === urlFilter &&
            rule.condition.tabIds && rule.condition.tabIds.includes(tabId)
        );
        if (alreadyExists) return true; // already blocked, no-op
    } catch (e) { /* proceed anyway */ }

    let currentRuleId = null;
    try {
        currentRuleId = await getNextRuleId();

        const rule = {
            id: currentRuleId,
            priority: 1,
            action: { type: "block" },
            condition: {
                urlFilter: urlFilter,
                tabIds: [tabId], // 👈 Key fix: Restricts rule to ONLY this tab!
                resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"]
            }
        };

        await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [rule]
        });

        return true;

    } catch (error) {
        console.error(`Error adding blocking rule for tab ${tabId}:`, error);
        if (currentRuleId) usedRuleIds.delete(currentRuleId);
        return false;
    }
}

/**
 * Removes all rules associated with a specific tab.
 */
export async function clearRulesForTab(tabId) {
    try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        
        // Find rule IDs that target this tabId
        const tabRuleIds = rules
            .filter(rule => rule.condition.tabIds && rule.condition.tabIds.includes(tabId))
            .map(rule => rule.id);

        if (tabRuleIds.length > 0) {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: tabRuleIds
            });

            tabRuleIds.forEach(id => usedRuleIds.delete(id));
            console.log(`Cleared ${tabRuleIds.length} rule(s) for tabId ${tabId}`);
        }
    } catch (error) {
        console.error(`Failed to clear rules for tab ${tabId}:`, error);
    }
}

async function getNextRuleId() {
    try {
        const rules = await chrome.declarativeNetRequest.getSessionRules();  // ← was getDynamicRules
        rules.forEach(rule => usedRuleIds.add(rule.id));

        let nextId = 1;
        while (usedRuleIds.has(nextId)) { nextId++; }

        usedRuleIds.add(nextId);
        return nextId;

    } catch (error) {
        console.error("Error getting next rule ID:", error);
        return Math.floor(Math.random() * 100000);
    }
}