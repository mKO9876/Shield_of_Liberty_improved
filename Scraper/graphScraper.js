const { onRequest, onRequestFinished } = require('./networkScraper');
const allNetworkData = [];
const allGraphs = [];

for (const url of targetURLs) {
    if (visited.has(url)) continue;
    console.log(`Visiting ${url}`);

    const context = await browser.createBrowserContext();
    const requestTimings = new Map();
    const page = await context.newPage();
    await page.setUserAgent(USER_AGENT);

    page.on('request', (req) => onRequest(req, requestTimings));
    page.on('requestfinished', (req) =>
        onRequestFinished(req, page, requestTimings, allNetworkData)
    );

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await autoScroll(page);
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Extract the DOM Graph, resolving absolute URLs for matching
        const domGraph = await page.evaluate(() => {
            const nodes = [];
            const edges = [];
            let idCounter = 0;

            function traverse(element, parentId) {
                if (element.nodeType !== Node.ELEMENT_NODE) return;

                const currentId = `dom_${idCounter++}`;
                const attributes = {};
                let absoluteUrl = null;

                for (let attr of element.attributes) {
                    attributes[attr.name] = attr.value;

                    // Convert relative paths to absolute URLs so Python can match them to network requests
                    if (['src', 'href', 'action', 'data', 'ping'].includes(attr.name)) {
                        try {
                            absoluteUrl = new URL(attr.value, document.baseURI).href;
                        } catch (e) { /* ignore invalid URLs */ }
                    }
                }

                nodes.push({
                    id: currentId,
                    tag: element.tagName.toLowerCase(),
                    attributes: attributes,
                    resolvedUrl: absoluteUrl // <-- THIS IS YOUR JOIN KEY FOR PYTHON
                });

                if (parentId !== null) {
                    edges.push({ source: parentId, target: currentId, relation: 'CHILD_OF' });
                }

                for (let child of element.children) {
                    traverse(child, currentId);
                }
            }

            traverse(document.documentElement, null);
            return { nodes, edges };
        });

        allGraphs.push({
            mainPageUrl: url,
            graph: domGraph
        });

    } catch (err) {
        console.error(`❌ Failed to visit ${url}:`, err.message);
    } finally {
        visited.add(url);
        await page.close();
        await context.close();
    }
}