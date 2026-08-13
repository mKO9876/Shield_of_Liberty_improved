from flask import Flask, request, jsonify
import joblib
import pandas as pd
from prepareData import prepareData
from DOM import extractDOMAndChainFeatures
from urllib.parse import urlparse

# Load model into memory at startup
model = joblib.load('model.pkl')
scaler = joblib.load('scaler.pkl')
encoder = joblib.load('label_encoders.pkl')


app = Flask(__name__)

FEATURE_ORDER=[
    'method', 
    'resourceType', 
    'initiatorType', 
    'domainEntropy', 
    'urlEntropy', 
    'isThirdParty', 
    'hasUUID', 
    'urlLength', 
    'status', 
    'mimeType', 
    'latency', 
    'hassizeBytes', 
    'directDomConnections', #GRAF
    'isAttachedToDom', #GRAF
    'suspiciousResHeaders',
    'suspiciousReqHeaders',
    'chainLength', #GRAF
    'uniqueDomainsInChain', #GRAF
    'consecutiveSameDomainTrack', #GRAF
    'queryParamsCount' 
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


@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.json
        #print("DATA: ", data)
        tab_id = data.get('tabId')
        #print("TAB ID: ", tab_id)
        dom_graph_payload = data.get('domGraph', {})  # { mainPageUrl, graph: {nodes, edges} }
        #print("dom graph payload: ", dom_graph_payload)
        requests_list = data.get('requests', [])
        #print("request list: ", requests_list)
        

        if not requests_list:
            return jsonify({'error': 'No request data'}), 400

        # Build network graph ONCE from all requests (replicates notebook cell exactly)
        # Pre-process headers before making DataFrame
        for row in requests_list:
            row['resHeader'] = prepareData(row.get('resHeader', []), 'resHeader')
            row['reqHeader'] = prepareData(row.get('reqHeader', {}), 'reqHeader')

        df_requests = pd.DataFrame(requests_list)
        #print("DF REQUESTS: ", df_requests.shape)

        # Wrap domGraph in a list so DOM.py's `next()` lookup works (matches training format)
        dom_graph_list = [dom_graph_payload] if dom_graph_payload else []

        blocked = []

        for row in requests_list:
            print("LETS GO")
            processed_dict = {}
            # extractDOMAndChainFeatures builds network graph internally from df_requests
            # and matches DOM nodes using dom_graph_list
            direct_conn, is_attached, chain_len, uniq_doms, consec_doms = extractDOMAndChainFeatures(
                graph=dom_graph_list,
                row=row,
                df_requests=df_requests
            )

            # print("STILL WORKING")

            row['directDomConnections'] = direct_conn
            row['isAttachedToDom'] = is_attached
            row['chainLength'] = chain_len
            row['uniqueDomainsInChain'] = min(uniq_doms, 4)
            row['consecutiveSameDomainTrack'] = consec_doms


            parsedUrl = urlparse(row["url"]).query
            row["queryParamsCount"] = len(parsedUrl.split("&"))

            row["suspiciousResHeaders"] = row.get("resHeader")
            row["suspiciousReqHeaders"] = row.get("reqHeader")

            for col in FEATURE_ORDER:                
                # print("col: ", col)
                val = prepareData(row.get(col), col)
                if col in CATEG_COLS:
                    col_encoder = encoder[col]
                    if val not in col_encoder.classes_:
                        val = col_encoder.classes_[0]
                    val = col_encoder.transform([val])[0]
                # print("val: ", val)
                processed_dict[col] = val

            input_df = pd.DataFrame([processed_dict])
            input_df[NUMERIC_COLS] = scaler.transform(input_df[NUMERIC_COLS])
            input_df.rename(columns={'resHeader': "suspiciousResHeadersCount", 'reqHeader': "suspiciousReqHeadersCount"})

            pred = model.predict(input_df[FEATURE_ORDER])[0]

            # Save to evaluate.csv for thesis comparison
            input_df['url'] = row.get('url')
            input_df['mainPageUrl'] = row.get('mainPageUrl')
            input_df['resourceType'] = row.get('resourceType')
            input_df['predictedLabel'] = int(pred)
            input_df.to_csv('evaluate.csv', mode='a', index=False, header=False)

            print("URL: ", input_df["url"])
            print("PREDICT:", pred)

            if pred == 1:
                blocked.append({
                    'url': row['url'],
                    'mainPageUrl': row.get('mainPageUrl'),
                    'resourceType': row.get('resourceType')
                })

        return jsonify({'tabId': tab_id, 'blocked': blocked})

    except Exception as e:
        print("ERROR happened")
        return jsonify({'error': str(e)}), 402