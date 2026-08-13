import networkx as nx
from urllib.parse import urlparse

def getDomain(url):
    if not url: 
        return ""
    try:
        return urlparse(url).netloc
    except:
        return ""

def extractDOMAndChainFeatures(graph, row, df_requests=None):
    """
    Extracts both DOM attachment features and Network Chain/Initiator features for a single request row.
    """
    page_url = row.get('mainPageUrl')
    req_url = row.get('url')
    
    # Defaults
    direct_connections = 0
    is_attached = False
    chain_length = 0
    unique_domains = 0
    consecutive_same_domain = 0

    if not page_url or not req_url:
        return direct_connections, is_attached, chain_length, unique_domains, consecutive_same_domain

    # ---------------------------------------------------------
    # PART 1: DOM Attachment Features (DOM Tree)
    # ---------------------------------------------------------
    dom_item = next((item for item in graph if item.get('mainPageUrl') == page_url), None)
    
    if dom_item and 'graph' in dom_item:
        graph_data = dom_item['graph']

        dom_G = nx.DiGraph()
        matched_node_ids = []

        for node in graph_data.get('nodes', []):
            dom_G.add_node(node['id'])
            # Save node ID if resolvedUrl matches the request URL
            if node.get('resolvedUrl') == req_url:
                matched_node_ids.append(node['id'])

        for edge in graph_data.get('edges', []):
            if edge.get('relation') == 'CHILD_OF':
                dom_G.add_edge(edge['source'], edge['target'])

        direct_connections = len(matched_node_ids)
        is_attached = direct_connections > 0

    # ---------------------------------------------------------
    # PART 2: Network Initiator & Chain Features (Network Graph)
    # ---------------------------------------------------------
    if df_requests is not None and not df_requests.empty:
        # Build the global request/initiator network graph
        net_G = nx.DiGraph()
        for _, req in df_requests.iterrows():
            initiator = req.get('initiatorUrl')
            target = req.get('url')
            
            if initiator and target:
                net_G.add_edge(initiator, target)
            elif target:
                net_G.add_node(target)

        # Trace the chain backwards starting from target_node
        chain = []
        current = req_url
        visited = set()  # Avoid infinite loop cycles

        while current and current in net_G and current not in visited:
            visited.add(current)
            chain.append(current)
            
            # Find the predecessor/initiator
            predecessors = list(net_G.predecessors(current))
            current = predecessors[0] if predecessors else None

        # Reverse order: [Root -> ... -> Script -> Target URL]
        chain.reverse()

        # Feature A: Chain Length
        chain_length = len(chain)

        # Feature B: Unique domains in chain
        chain_domains = [getDomain(url) for url in chain if url]
        unique_domains = len(set(chain_domains))

        # Feature C: Consecutive same-domain requests
        consecutive_count = 0
        for i in range(len(chain_domains) - 1):
            if chain_domains[i] == chain_domains[i+1] and chain_domains[i] != "":
                consecutive_count += 1
        
        consecutive_same_domain = consecutive_count

    return (
        direct_connections,
        is_attached,
        chain_length,
        unique_domains,
        consecutive_same_domain
    )