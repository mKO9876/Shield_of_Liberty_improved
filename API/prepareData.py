from urllib.parse import urlparse
import numpy

def categSuspiciousHeaders(element_headers):
    UNWANTED_HEADERS = {
    #other unwanted
        "x-onetrust-isbot", "x-didomi-configs-version", "x-didomi-remote-config-metadata",
        "x-didomi-version", "x-datadome", "x-datadome-cid", "x-dd-b", "x-dd-page-size",
        "bxpunish", "x5-punish-cache", "x-px-blocked", "x-amzn-waf-challenge-id",
        "x-amzn-waf-action", "cf-chl-out", "cf-chl-gen", "cf-chl-out-s",
        "x-experiment-payload", "x-experiment-tracking", "x-experiment-visitor-id",
        "x-treatment-hash", "x-treatment-ids", "x-treatment-page-hash",
        "x-erf-bev-bev", "x-erf-bev-bev-is-generated", "x-splittest",
        "x-abt-application-version", "statsig-final-byte-size", "x-statsig-region"
    #ad
        'x-tbl-io-backend', 'x-tbl-io-error', 'x-amz-meta-x-tbl-source',
        'x-criteo-endpoint-action', 'x-criteo-endpoint-controller', 'x-criteo-endpoint-version',
        'ad-auction-allowed', 'x-spotim-device-uuid', 'x-spotim-bid', 'x-spotim-rid',
        'x-spotim-vid', "bidder", "x-openrtb-version", "x-prebid", "adthrive-bucket",
        "adthrive-commit", "adthrive-deployment", "adthrive-gdpr", "google-creative-id",
        "google-lineitem-id", "google-mediationgroup-id", "google-mediationtag-id",
        "x-begun-impressionid", "x-begun-graphcount", "x-begun-graphprice",
        "x-begun-textcount", "x-begun-textprice", "x-atmtd-floors-created-at",
        "x-atmtd-floors-path", "x-atmtd-floors-source", "allow-fenced-frame-automatic-beacons"
    # tracking
        "tracking", "x-pixel-event-id", "x-criteo-endpoint-action", "x-criteo-endpoint-controller",
        "x-criteo-endpoint-version", "observe-browsing-topics", "x-fb-optimizer", "x-reddit-ct",
        "x-hubspot-correlation-id", "x-nyt-audience-target-flat", "x-nyt-mktg-group", "bxuuid",
        "x-tracking-snippet-served-by", "x-nike-visitid", "x-nike-visitorid", "x-airbnb-everest-device-id",
        "x-zm-trackingid", "x-zm-zoneid", "campaign-trace-id", "x-newrelic-app-data", 'x-didomi-version',
        'x-didomi-configs-version', 'x-didomi-remote-config-metadata', 'x-onetrust-isbot',
        'x-fides-version', 'x-logrocket-upload-max-interval', 'x-logrocket-upload-max-size',
        'dotmetrics-hit-status', 'attribution-reporting-register-source',
        'attribution-reporting-register-aggregatable-source', 'spoor-device-id', 'spoor-ticket',
        'x-recombee-request-id', 'x-evergage-beacon-ver', 'x-fb-connection-quality', 'x-fb-debug',
        'x-fb-edge-debug', 'x-fb-ptm-uuid', 'x-pinterest-rid', 'x-pinterest-rid-128bit',
        'pinterest-version', 'x-twitter-response-tags', 'x-hs-request-id', 'x-hs-user-login-state',
        'x-klaviyo-hash', 'x-datadog-trace-id'
    #cookie
        'set-cookie', 'cookie', 'x-cached-cookies', 'x-server-cookie',
        'worker-missing-cookies', 'x-as-suppresssetcookie'
    }

    if isinstance(element_headers, dict):
            all_names = [k.lower() for k in element_headers.keys()]
    elif isinstance(element_headers, list):
        all_names = [el["name"].lower() for el in element_headers if isinstance(el, dict)]
    else:
        return 0

    return sum(1 for h in all_names if h in UNWANTED_HEADERS)


def categHasSizeBytes(sizeByte):
    try:
        return int(sizeByte) > 0
    except (TypeError, ValueError):
        return False

def categMimeType(mime):
    if not mime: return 'unknown'
    m = str(mime).lower().split(';')[0].strip()

    if "script" in m or "sacript" in m:
        return "javascript"
    elif "image" in m or "jpg" in m:
        return "image"
    elif "font" in m or "woff" in m:
        return "font"
    elif "json" in m:
        return "json"
    elif "xml" in m:
        return "xml"
    elif "icon" in m:
        return "icon"
    elif "binary" in m or "octet" in m:
        return "binary"
    elif "video" in m or "mpeg" in m:
        return "video"
    elif "text/html" in m:
        return "html"
    elif "text/css" in m:
        return "css"
    return "unknown"


def categMethod(method):
  m =str(method).lower()
  if m =="get" or m=="post": return m.upper()
  else: return "other"


def categStatus(status):
    if status is None or numpy.isnan(status) or status == 0:
        return "Failed_Connection"

    status = int(status)

    if status == 200 or status == 204:
        return "Success_OK"
    elif status in [201, 202]:
        return "Success_Created"
    elif 200 <= status < 300:
        return "Success_Other"
    elif status >= 300 and status < 400: return "Redirects"
    elif status >= 400 and status < 500: return "Error_user"
    else: return "Error_server"


def categInitiatorType(initiator):
  allow_list = ["other", "parser", "script", "preflight"]
  if initiator in allow_list: return initiator
  else: return "unknown"



def prepareData(vl, col):
    if col == "suspiciousReqHeaders" or col == "suspiciousResHeaders": 
        temp = categSuspiciousHeaders(vl)
        if temp >= 1: return 1
        return temp
    elif col == "queryParamsCount": return numpy.log1p(vl)
    elif col == "hassizeBytes": return categHasSizeBytes(vl)
    elif col == 'latency': return numpy.log1p(vl)
    elif col == 'urlLength': return numpy.log1p(vl)
    elif col == "mimeType": return categMimeType(vl)
    elif col == "method": return categMethod(vl)
    elif col == "status": return categStatus(vl)
    elif col == "initiatorType": return categInitiatorType(vl)
    elif col == "consecutiveSameDomainTrack": return 3 if vl >= 3 else vl
    elif col == "uniqueDomainsInChain": return 4 if vl >= 4 else vl
    elif col == "chainLength": return 6 if vl >= 6 else vl
    elif col == "directDomConnections": return 3 if vl >= 3 else vl   
    else: return vl
    