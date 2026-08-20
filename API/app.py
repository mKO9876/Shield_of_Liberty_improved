from flask import Flask, request, jsonify
import joblib
import pandas as pd
import networkx as nx
from prepareData import prepareData
from DOM import extractDOMAndChainFeatures
from urllib.parse import urlparse
import threading

# Load model into memory at startup
model = joblib.load('model.pkl')
scaler = joblib.load('scaler.pkl')
encoder = joblib.load('label_encoders.pkl')


app = Flask(__name__)

FEATURE_ORDER=[
'method', 'resourceType', 'initiatorType',
'domainEntropy', 'urlEntropy', 'isThirdParty', 'hasUUID', 'urlLength',
'status', 'mimeType', 'hassizeBytes', 'latency', 'directDomConnections',
'isAttachedToDom', 'suspiciousResHeaders',
'suspiciousReqHeaders', 'chainLength', 'uniqueDomainsInChain',
'consecutiveSameDomainTrack', 'queryParamsCount'
]

CATEG_COLS = [
    "method", 
    "resourceType", 
    "initiatorType", 
    "isThirdParty", 
    "hasUUID", 
    "status", 
    "mimeType", 
    "hassizeBytes", 
    "isAttachedToDom"
]

NUMERIC_COLS = [
    "domainEntropy", 
    "urlLength", 
    "urlEntropy", 
    'latency'
]

# ─── Persistent Graph Storage ─────────────────────────────────────────────────
# Structure: { "tabId_mainPageUrl": { dom_graph_list, network_graph (nx.DiGraph), all_requests (list) } }
graph_store = {}
graph_store_lock = threading.Lock()


def get_store_key(tab_id, main_page_url):
    print("geting store key")
    """Create a unique key for storing graphs per tab+page combination."""
    return f"{tab_id}_{main_page_url}"


def predict_rows(requests_list, dom_graph_list, df_requests):
    print("predict rows")
    """
    Core prediction logic shared between /predict and /predict_after.
    Takes pre-built dom_graph_list and df_requests (containing ALL historical requests for network graph).
    Returns list of blocked items.
    """
    blocked = []

    for row in requests_list:
        processed_dict = {}
        
        direct_conn, is_attached, chain_len, uniq_doms, consec_doms = extractDOMAndChainFeatures(
            graph=dom_graph_list,
            row=row,
            df_requests=df_requests
        )

        row['directDomConnections'] = direct_conn
        row['isAttachedToDom'] = is_attached
        row['chainLength'] = chain_len
        row['uniqueDomainsInChain'] = min(uniq_doms, 4)
        row['consecutiveSameDomainTrack'] = consec_doms

        parsedUrl = urlparse(row["url"]).query
        row["queryParamsCount"] = len(parsedUrl.split("&")) if parsedUrl else 0

        row["suspiciousResHeaders"] = row.get("resHeader")
        row["suspiciousReqHeaders"] = row.get("reqHeader")

        for col in FEATURE_ORDER:                
            val = prepareData(row.get(col), col)
            if col in CATEG_COLS:
                col_encoder = encoder[col]
                if val not in col_encoder.classes_:
                    val = col_encoder.classes_[0]
                val = col_encoder.transform([val])[0]
            processed_dict[col] = val

        input_df = pd.DataFrame([processed_dict])
        input_df[NUMERIC_COLS] = scaler.transform(input_df[NUMERIC_COLS])

        pred = model.predict(input_df[FEATURE_ORDER])[0]

        # Save to evaluate.csv for thesis comparison
        input_df['url'] = row.get('url')
        input_df['mainPageUrl'] = row.get('mainPageUrl')
        input_df['resourceType'] = row.get('resourceType')
        input_df['predictedLabel'] = int(pred)

        input_df.to_csv('evaluate.csv', mode='a', index=False, header=False)

        print("URL: ", row.get('url'))
        print("PREDICT:", pred)

        if pred == 1:
            blocked.append({
                'url': row['url'],
                'mainPageUrl': row.get('mainPageUrl'),
                'resourceType': row.get('resourceType')
            })

    return blocked


@app.route('/predict', methods=['POST'])
def predict():
    print("predicting")
    """
    Initial batch prediction on page load.
    Builds and PERSISTS both DOM graph and network graph for later /predict_after calls.
    """
    try:
        data = request.json
        tab_id = data.get('tabId')
        dom_graph_payload = data.get('domGraph', {})  # { mainPageUrl, graph: {nodes, edges} }
        requests_list = data.get('requests', [])

        if not requests_list:
            return jsonify({'error': 'No request data'}), 400

        main_page_url = dom_graph_payload.get('mainPageUrl', '') if dom_graph_payload else ''
        if not main_page_url and requests_list:
            main_page_url = requests_list[0].get('mainPageUrl', '')

        # Pre-process headers before making DataFrame
        for row in requests_list:
            row['resHeader'] = prepareData(row.get('resHeader', []), 'resHeader')
            row['reqHeader'] = prepareData(row.get('reqHeader', []), 'reqHeader')

        df_requests = pd.DataFrame(requests_list)

        # Wrap domGraph in a list so DOM.py's `next()` lookup works
        dom_graph_list = [dom_graph_payload] if dom_graph_payload else []

        # ─── Persist graphs for this tab+page ─────────────────────────────────
        store_key = get_store_key(tab_id, main_page_url)
        with graph_store_lock:
            graph_store[store_key] = {
                'dom_graph_list': dom_graph_list,
                'all_requests': list(requests_list),  # keep a copy of all requests seen
                'tab_id': tab_id,
                'main_page_url': main_page_url
            }

        # Run predictions
        blocked = predict_rows(requests_list, dom_graph_list, df_requests)

        return jsonify({'tabId': tab_id, 'blocked': blocked})

    except Exception as e:
        print("ERROR in /predict:", e)
        return jsonify({'error': str(e)}), 402


@app.route('/predict_after', methods=['POST'])
def predict_after():
    print("predict after")
    """
    Incremental prediction for requests that arrive after initial page load.
    Adds new requests to the persisted network graph and uses the existing DOM graph.
    This ensures chain features are computed with full historical context.
    """
    try:
        data = request.json
        tab_id = data.get('tabId')
        main_page_url = data.get('mainPageUrl', '')
        requests_list = data.get('requests', [])
        # Optional: updated DOM graph (page may have changed via JS)
        dom_graph_payload = data.get('domGraph', None)

        if not requests_list:
            return jsonify({'error': 'No request data'}), 400

        # If no mainPageUrl provided, try to infer from first request
        if not main_page_url and requests_list:
            main_page_url = requests_list[0].get('mainPageUrl', '')

        store_key = get_store_key(tab_id, main_page_url)

        # Pre-process headers
        for row in requests_list:
            row['resHeader'] = prepareData(row.get('resHeader', []), 'resHeader')
            row['reqHeader'] = prepareData(row.get('reqHeader', []), 'reqHeader')

        with graph_store_lock:
            stored = graph_store.get(store_key)

            if stored is None:
                # No prior context — fall back to treating this as a fresh batch
                # (This can happen if the extension restarts or first request missed /predict)
                dom_graph_list = [dom_graph_payload] if dom_graph_payload else []
                df_all_requests = pd.DataFrame(requests_list)
                # Store it now for future calls
                graph_store[store_key] = {
                    'dom_graph_list': dom_graph_list,
                    'all_requests': list(requests_list),
                    'tab_id': tab_id,
                    'main_page_url': main_page_url
                }
            else:
                # Update DOM graph if a new one was provided
                if dom_graph_payload:
                    stored['dom_graph_list'] = [dom_graph_payload]

                # Add new requests to historical list
                stored['all_requests'].extend(requests_list)

                dom_graph_list = stored['dom_graph_list']
                # Build df from ALL historical requests so network graph has full context
                df_all_requests = pd.DataFrame(stored['all_requests'])

        # Run predictions using FULL historical context
        blocked = predict_rows(requests_list, dom_graph_list, df_all_requests)

        return jsonify({'tabId': tab_id, 'blocked': blocked})

    except Exception as e:
        print("ERROR in /predict_after:", e)
        return jsonify({'error': str(e)}), 402


@app.route('/clear', methods=['POST'])
def clear():
    """
    Clear stored graphs for a specific tab (when tab closes or navigates to new page).
    Accepts: { tabId, mainPageUrl (optional) }
    If mainPageUrl is not provided, clears ALL entries for that tabId.
    """
    try:
        data = request.json
        tab_id = data.get('tabId')
        main_page_url = data.get('mainPageUrl', None)

        if tab_id is None:
            return jsonify({'error': 'tabId is required'}), 400

        removed_keys = []
        with graph_store_lock:
            if main_page_url:
                # Clear specific tab+page combination
                store_key = get_store_key(tab_id, main_page_url)
                if store_key in graph_store:
                    del graph_store[store_key]
                    removed_keys.append(store_key)
            else:
                # Clear ALL entries for this tabId
                keys_to_remove = [k for k in graph_store if k.startswith(f"{tab_id}_")]
                for k in keys_to_remove:
                    del graph_store[k]
                    removed_keys.append(k)

        print(f"Cleared graph data for tab {tab_id}: {removed_keys}")
        return jsonify({'status': 'ok', 'cleared': len(removed_keys)})

    except Exception as e:
        print("ERROR in /clear:", e)
        return jsonify({'error': str(e)}), 500
