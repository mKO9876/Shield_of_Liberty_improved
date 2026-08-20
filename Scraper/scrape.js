const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const targetURLs = require('./domains').links();
const { onRequest, onRequestFinished } = require('./networkScraper');
const autoScroll = require('./autoScroll');
const { saveGraph, saveNetworkData } = require('./dataSaver');
const { resolve } = require('dns');
const visited = new Set();

const OUTPUT_DIR = "data";
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

(async () => {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

    const browser = await puppeteer.launch({
        headless: "new",
        userDataDir: './puppeteer_profile',
        args: [
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--lang=en-US,en',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled'
        ],
        protocolTimeout: 60000
    });

    const allNetworkData = [];
    const allGraphs = [];

    for (const url of targetURLs) {
        if (visited.has(url)) continue;
        console.log(`Visiting ${url}`);

        const context = await browser.createBrowserContext();
        const requestTimings = new Map();

        const page = await context.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({width:1929, height:1080});

        await page.evaluateOnNewDocument(()=>{
            Object.defineProperty(navigator, 'webdriver', {get: () => false})
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']})
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]})
        })

        page.on('request', (req) => onRequest(req, requestTimings));
        page.on('requestfinished', (req) =>
            onRequestFinished(req, page, requestTimings, allNetworkData)
        );

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
            await autoScroll(page);
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Use page.url() (final URL after redirects) as mainPageUrl for the graph
            // This matches what networkScraper uses for each request's mainPageUrl
            const finalPageUrl = page.url();

            // Extract the DOM Graph, resolving absolute URLs for matching
            const domGraph = await page.evaluate(() => {
                const nodes = [];
                const edges = [];
                let idCounter = 0;

                function traverse(element, parentId) {
                    if (element.nodeType !== Node.ELEMENT_NODE) return;

                    const currentId = `dom_${idCounter++}`;
                    const attributes = {};
                    let resolvedUrls = [];

                    for (let attr of element.attributes) {
                        attributes[attr.name] = attr.value;
                        
                        // Collect ALL URL-bearing attributes (not just the last one)
                        if (['src', 'href', 'action', 'data', 'ping'].includes(attr.name)) {
                            try {
                                const absUrl = new URL(attr.value, document.baseURI).href;
                                resolvedUrls.push(absUrl);
                            } catch (e) { /* ignore invalid URLs */ }
                        }
                    }

                    // Use the first resolved URL as the primary (src > href > others in DOM order)
                    // but save all for better matching
                    nodes.push({
                        id: currentId,
                        tag: element.tagName.toLowerCase(),
                        attributes: attributes,
                        resolvedUrl: resolvedUrls[0] || null, // primary URL for backward compat
                        resolvedUrls: resolvedUrls             // all URLs for better matching
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
                mainPageUrl: finalPageUrl, // ← Use final URL to match network requests
                graph: domGraph
            });

        } catch (err) {
            console.error(`❌ Failed to visit ${url}:`, err.message);
        } finally {
            visited.add(url);
            await page.close();
            await context.close();
            await new Promise(resolve => setTimeout(resolve, 2000))
        }

        // Save periodically (every 10 pages) to avoid losing data on crash
        if (visited.size % 3 === 0) {
            await saveNetworkData(allNetworkData, OUTPUT_DIR);
            await saveGraph(allGraphs, OUTPUT_DIR);
            console.log(`💾 Checkpoint saved (${visited.size} pages done)`);
        }
    }

    await saveNetworkData(allNetworkData, OUTPUT_DIR);
    await saveGraph(allGraphs, OUTPUT_DIR);

    await browser.close();
    console.log('Data collection complete!');
})();
