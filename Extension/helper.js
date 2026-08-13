// import {CONFIG} from "./config.js"

// export async function classifyData(details, tabUrl = null) {
//     try {
//         const features = await extractRequestData(details, tabUrl);
       
//         const response = await fetch(CONFIG.FLASK_API_PREDICT, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ features })
//         });

//         if (response.status != 200) { 
//             throw new Error(`Server error: ${response.status}`); 
//         }

//         const result = await response.json();
//         return result.prediction;

//     } catch (error) {
//         console.error("Error fetching data from Flask API:", error);
//         return 0;
//     }
// }

export async function extractRequestData(details, tabUrl = null) { 
    const urlStr = details.url;
    const urlObj = new URL(urlStr);

    const getResHeader = (name) => 
        details.responseHeaders?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
    
    const getReqHeader = (name) => 
        details.requestHeaders?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

    const storageKey = `start_${details.requestId}`;
    const storedData = await chrome.storage.session.get(storageKey);
    const startTime = storedData[storageKey];
    chrome.storage.session.remove(storageKey);

    const heuristics = analyzeURL(urlStr);

    const mainPageUrl = tabUrl || urlStr;
    let isThirdParty = false;
    try {
        isThirdParty = new URL(mainPageUrl).hostname !== urlObj.hostname;
    } catch (e) {
        isThirdParty = false;
    }

    const resContentLength = getResHeader('content-length');

    return {
        url: urlStr,
        mainPageUrl: mainPageUrl,
        method: details.method || 'GET',
        resourceType: getResourceType(details),
        initiatorType: getInitiatorType(details),
        initiatorUrl: details.initiator || null,
        domainEntropy: calculateEntropy(urlObj.hostname),
        urlEntropy: calculateEntropy(urlStr),
        isThirdParty: isThirdParty,
        //reqHeaderCount: details.requestHeaders ? details.requestHeaders.length : 0,
        reqHeader: details.requestHeaders || {},
        hasUUID: /[a-f0-9]{8,}/i.test(urlStr),
        urlLength: urlStr.length,
        ...heuristics,
        status: details.statusCode || 0,
        mimeType: getResHeader('content-type') || 'unknown',
        hassizeBytes: resContentLength ? parseInt(resContentLength) : 0,
        setCookies: !!getResHeader('set-cookie'),
        //resHeaderCount: details.responseHeaders ? details.responseHeaders.length : 0,
        latency: startTime ? (Date.now() - startTime) : 0,
        isPotentialPixel: (getResourceType(details) === 'image' && resContentLength && parseInt(resContentLength) < 100),
        resHeader: details.responseHeaders || {}
    };
}

//Iz scrapera
function analyzeURL(urlStr) {
    try {
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
    } catch (e) {
        return {
            specialCharCount: 0,
            urlTokenCount: 0,
            avgTokenLength: 0,
            suspiciousSymbols: 0,
            lengthRatio: 0,
            characterContinuity: 0,
            isTrackingParam: false
        };
    }
}


function getResourceType(details) {
    const type = details.type;
    const mapping = {
        'main_frame': 'document',
        'sub_frame': 'document',
        'stylesheet': 'stylesheet',
        'script': 'script',
        'image': 'image',
        'font': 'font',
        'object': 'object',
        'xmlhttprequest': 'xhr',
        'ping': 'ping',
        'csp_report': 'csp_report',
        'media': 'media',
        'websocket': 'websocket'
    };

    return mapping[type] || type || 'other';
}


function getInitiatorType(details) {
    if (details.method === 'OPTIONS') return 'preflight';
    if (details.initiator) {
        if (details.initiator.startsWith('http')) return 'script';
    }
    if (['main_frame', 'sub_frame', 'stylesheet', 'image', 'font'].includes(details.type)) {
        return 'parser';
    }
    return 'other';
}

 // Shannon Entropy
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