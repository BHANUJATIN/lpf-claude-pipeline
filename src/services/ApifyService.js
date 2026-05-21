/**
 * Apify integration — used in Stage 2 to scrape company websites
 * for additional enrichment data (descriptions, office locations, tech hints).
 */
const axios = require('axios');

const APIFY_BASE = 'https://api.apify.com/v2';

class ApifyService {
    async scrapeCompanyWebsite(url, timeoutSecs = 60) {
        if (!process.env.APIFY_API_KEY) return null;
        if (!url || !url.startsWith('http')) return null;

        const input = {
            startUrls:     [{ url }],
            maxCrawlPages: 1,
            maxCrawlDepth: 0,
            crawlerType:   'cheerio',
            maxResults:    1,
        };

        const res = await axios.post(
            `${APIFY_BASE}/acts/apify~website-content-crawler/run-sync-get-dataset-items`,
            input,
            {
                params:  { token: process.env.APIFY_API_KEY, timeout: timeoutSecs, memory: 256 },
                timeout: (timeoutSecs + 15) * 1000,
            }
        );

        const items = Array.isArray(res.data) ? res.data : [];
        if (!items.length) return null;

        // Prefer markdown (cleaner), fall back to raw text
        return items[0]?.markdown || items[0]?.text || null;
    }
}

module.exports = new ApifyService();
