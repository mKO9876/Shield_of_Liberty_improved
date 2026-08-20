module.exports = async function autoScroll(page) {
    try {
        // We use Promise.race to set a hard limit (e.g., 10 seconds).
        // Whichever finishes first (the scrolling OR the 10-second timer) wins.
        await Promise.race([
            page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;

                        // If we've reached the bottom, wait a moment to see if more content loads
                        if (totalHeight >= scrollHeight) {
                            setTimeout(() => {
                                if (totalHeight >= document.body.scrollHeight) {
                                    clearInterval(timer);
                                    resolve();
                                }
                            }, 500);
                        }
                    }, 150);
                });
            }),
            // Safety fuse: 10,000 milliseconds (10 seconds) maximum scroll time
            new Promise((_, reject) => setTimeout(() => reject(new Error('Scroll Timeout Limit Reached')), 50000))
        ]);
    } catch (err) {
        // If the context is destroyed or our safety timer goes off, we catch it here.
        // It won't freeze the scraper; it will just print this warning and continue collecting data!
        if (err.message.includes('Execution context was destroyed')) {
            console.log(`⚠️ Auto-scroll interrupted (Page redirected or reloaded). Moving on safely...`);
        } else {
            console.log(`⚠️ Auto-scroll stopped: ${err.message}. Moving on safely...`);
        }
    }
};