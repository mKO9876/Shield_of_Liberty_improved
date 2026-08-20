chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractDOM') {
        // Initial DOM extraction — sends graph back to background via runtime message
        const domGraph = buildDOMGraph();
        chrome.runtime.sendMessage({ 
            action: 'domGraph', 
            graph: domGraph 
        });
    }

    if (message.action === 'extractDOMForUpdate') {
        // Periodic update — returns DOM graph via sendResponse callback
        const domGraph = buildDOMGraph();
        sendResponse(domGraph);
        return; // synchronous response
    }

    if (message.action === 'neutralize') {
        neutralizePage(message.blockedUrls);
    }
});

function buildDOMGraph() {
    const nodes = [];
    const edges = [];
    let idCounter = 0;

    function traverse(element, parentId) {
        if (element.nodeType !== Node.ELEMENT_NODE) return;

        const currentId = `dom_${idCounter++}`;
        let absoluteUrl = null;

        for (let attr of element.attributes) {
            if (['src', 'href', 'action', 'data', 'ping'].includes(attr.name)) {
                try {
                    absoluteUrl = new URL(attr.value, document.baseURI).href;
                } catch (e) {}
            }
        }

        nodes.push({
            id: currentId,
            tag: element.tagName.toLowerCase(),
            resolvedUrl: absoluteUrl
        });

        if (parentId !== null) {
            edges.push({ source: parentId, target: currentId, relation: 'CHILD_OF' });
        }

        for (let child of element.children) {
            traverse(child, currentId);
        }
    }

    traverse(document.documentElement, null);

    return {
        mainPageUrl: location.href,
        graph: { nodes, edges }
    };
}

function neutralizePage(blockedUrls) {
    if (!blockedUrls?.length) return;

    const blockedHosts = new Set(
        blockedUrls.map(url => { try { return new URL(url).hostname; } catch { return null; } })
                   .filter(Boolean)
    );

    const isBlocked = src => {
        try { return blockedHosts.has(new URL(src, location.href).hostname); } 
        catch { return false; }
    };

    ['script[src]', 'img', 'iframe', 'link[rel="preload"]'].forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
            if (isBlocked(el.src || el.href)) el.remove();
        });
    });
}
