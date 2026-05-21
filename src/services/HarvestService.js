const axios       = require('axios');
const costTracker = require('./CostTrackerService');

const BASE_URL = 'https://api.harvest-api.com';

/**
 * Find email for a LinkedIn profile URL using Harvest API.
 * Returns { email } or null.
 */
async function findEmailByLinkedIn(linkedinUrl, opts = {}) {
    if (!process.env.HARVEST_API_KEY) return null;
    if (!linkedinUrl) return null;

    const params = new URLSearchParams({ url: linkedinUrl, findEmail: 'true' });

    const res = await axios.get(`${BASE_URL}/linkedin/profile?${params.toString()}`, {
        headers: { 'X-API-Key': process.env.HARVEST_API_KEY },
        timeout: 20000,
    });

    const data  = res.data;
    const email = data?.email || (Array.isArray(data?.emails) ? data.emails[0] : null) || null;

    costTracker.logApollo({
        jobId:     opts.jobId     || null,
        operation: opts.operation || 'harvest_linkedin',
        credits:   email ? 1 : 0,
        metadata:  { linkedinUrl, hasEmail: !!email },
    }).catch(() => {});

    return email ? { email } : null;
}

module.exports = { findEmailByLinkedIn };
