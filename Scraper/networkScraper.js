const { URL } = require('url');

const onRequest = (request, timingsMap) => {
    timingsMap.set(request.url(), {
        start: Date.now(),
        initiator: request.initiator()?.type,
        resourceType: request.resourceType()
    });
};

function calculateEntropy(str) {
    if (!str || str.length === 0) return 0;
    const map = {};
    for (const c of str) map[c] = (map[c] || 0) + 1;
    const len = str.length;
    let entropy = 0;
    for (const char in map) {
        const p = map[char] / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

const getInitiatorUrl = (request) => {
    const initiator = request.initiator();
    if (!initiator) return null;

    // If initiated directly by a document/parser URL
    if (initiator.url) return initiator.url;

    // If initiated by a script, grab the top frame of the stack trace
    if (initiator.stack && initiator.stack.callFrames && initiator.stack.callFrames.length > 0) {
        return initiator.stack.callFrames[0].url;
    }

    return null;
};

const analyzeURL = (urlStr) => {
    const url = new URL(urlStr);
    const fullPath = url.hostname + url.pathname + url.search;
    const tokens = fullPath.split(/[^a-zA-Z0-9]/).filter(Boolean);
    const tokenLengths = tokens.map(t => t.length);

    const longestLetter = (fullPath.match(/[a-zA-Z]+/g) || [""]).reduce((a, b) => a.length > b.length ? a : b).length;
    const longestDigit = (fullPath.match(/[0-9]+/g) || [""]).reduce((a, b) => a.length > b.length ? a : b).length;
    const longestSymbol = (fullPath.match(/[^a-zA-Z0-9]+/g) || [""]).reduce((a, b) => a.length > b.length ? a : b).length;

    const charContinuity = (longestLetter + longestDigit + longestSymbol) / (fullPath.length || 1);
    const suspiciousSymbols = (fullPath.match(/[;=@&$!]/g) || []).length;

    return {
        specialCharCount: (fullPath.match(/[^a-zA-Z0-9]/g) || []).length,
        urlTokenCount: tokens.length,
        avgTokenLength: tokens.length ? (tokenLengths.reduce((a, b) => a + b, 0) / tokens.length) : 0,
        suspiciousSymbols: suspiciousSymbols,
        lengthRatio: parseFloat((url.hostname.length / (fullPath.length || 1)).toFixed(4)),
        characterContinuity: parseFloat(charContinuity.toFixed(4)),
        isTrackingParam: /(utm_[a-z]+|gclid|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|ttclid|twclid|yclid|irclickid|aff_id|affiliate|ncid|pk_campaign|pk_kwd|_hsenc|_hsmi|mc_cid|mc_eid)/i.test(url.search)
    };
};

const onRequestFinished = async (request, page, timingsMap, storage) => {
    try {
        const response = await request.response();
        if (!response) return;

        const urlStr = request.url();
        // Ignore data URIs to keep the graph clean
        if (urlStr.startsWith('data:')) return;

        const urlObj = new URL(urlStr);
        const responseHeaders = response.headers();
        const requestHeaders = request.headers();
        const mimeType = responseHeaders['content-type'] || 'unknown';
        const heuristics = analyzeURL(urlStr);
        const timing = timingsMap.get(urlStr) || {};
        const mainPageUrl = page.url();

        // Structure Request and Response as distinct grouped objects
        const dataPoint = {
            url: urlStr,
            mainPageUrl: mainPageUrl,
            method: request.method(),
            resourceType: request.resourceType(),
            initiatorType: request.initiator()?.type || 'unknown',
            initiatorUrl: getInitiatorUrl(request),
            domainEntropy: calculateEntropy(urlObj.hostname),
            urlEntropy: calculateEntropy(urlStr),
            isThirdParty: new URL(mainPageUrl).hostname !== urlObj.hostname,
            reqHeaderCount: Object.keys(requestHeaders).length,
            reqHeader:requestHeaders,
            hasUUID: /[a-f0-9]{8,}/i.test(urlStr),
            urlLength: urlStr.length,
            ...heuristics,
            status: response.status(),
            mimeType: mimeType,
            hassizeBytes: responseHeaders['content-length'],
            setCookies: !!responseHeaders['set-cookie'],
            resHeaderCount: Object.keys(responseHeaders).length,
            latency: timing.start ? Date.now() - timing.start : 0,
            isPotentialPixel: request.resourceType() === 'image' && (parseInt(responseHeaders['content-length']) < 100),
            resHeader: responseHeaders
        };

        storage.push(dataPoint);
    } catch (err) {
        console.error(`❌ Error processing request ${request.url()}:`, err.message);
    }
}

module.exports = { onRequest, onRequestFinished };
