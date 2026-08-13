document.addEventListener('DOMContentLoaded', function () {
    const loadBlockedContentBtn = document.getElementById('loadBlockedContentBtn');
    const blockedContentDiv = document.getElementById('blockedContentDiv');
    loadBlockedContentBtn.innerText = 'Show content';
    var isShowingBlockedContent = false;

    loadBlockedContentBtn.addEventListener('click', async () => {
        try {
            if (!isShowingBlockedContent) {
                isShowingBlockedContent = true;
                loadBlockedContentBtn.innerText = 'Hide content';

                // 1. Get the current active tab in the focused window
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

                if (!activeTab) {
                    blockedContentDiv.innerHTML = '<p>Unable to detect active tab.</p>';
                    return;
                }

                // 2. Pass activeTab.id along with the message
                const response = await chrome.runtime.sendMessage({ 
                    action: "getBlockedContent",
                    tabId: activeTab.id 
                });
                
                const blockedContent = response ? response.blockedContent : [];

                if (blockedContent.length === 0) {
                    blockedContentDiv.innerHTML = '<p>No content blocked for this tab.</p>';
                    return;
                }

                const p = document.createElement("p");
                p.textContent = blockedContent.length;
                p.style.margin = '10px';
                p.style.textAlign = "center";
                p.style.fontSize = "30px";
                blockedContentDiv.appendChild(p);

                const ul = document.createElement('ul');
                ul.style.listStyle = 'none';
                ul.style.padding = '0';

                blockedContent.forEach(ad => {
                    const li = document.createElement('li');
                    li.style.marginBottom = '10px';
                    li.style.padding = '10px';
                    li.style.backgroundColor = '#f5f5f5';
                    li.style.borderRadius = '4px';

                    const url = document.createElement('div');
                    url.style.display = 'block';
                    url.style.width = '300px';
                    url.style.overflow = 'hidden';
                    url.style.textOverflow = 'ellipsis';
                    url.style.whiteSpace = 'nowrap';
                    url.textContent = `URL: ${ad.url}`;
                    url.style.marginBottom = '5px';
                    url.title = ad.url;

                    const type = document.createElement('div');
                    type.textContent = `Tip: ${ad.type}`;
                    type.style.fontSize = '0.8em';
                    type.style.color = '#666';

                    li.appendChild(url);
                    li.appendChild(type);
                    ul.appendChild(li);
                });

                blockedContentDiv.appendChild(ul);
            } else {
                isShowingBlockedContent = false;
                loadBlockedContentBtn.innerText = 'Show content';
                blockedContentDiv.innerHTML = "";
            }

        } catch (error) {
            console.error('Error loading blocked content:', error);
            blockedContentDiv.innerHTML = '<p>Error while loading list.</p>';
        }
    });
});