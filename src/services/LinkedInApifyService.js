/**
 * LinkedIn Profile Enrichment via Apify actor.
 * Actor: anchor/linkedin-profile-enrichment
 * No cookies required — cheap, high-quality, live data.
 *
 * Used in Stage 5 (EnrichContacts) and Stage 6 (JobPoster) as a
 * no-cost replacement for Proxycurl person enrichment.
 */
const axios = require('axios');

const ACTOR_ID  = 'anchor~linkedin-profile-enrichment';
const BASE      = 'https://api.apify.com/v2';
const POLL_MS   = 3000;
const MAX_POLLS = 30;

function token() {
    if (!process.env.APIFY_API_KEY) throw new Error('APIFY_API_KEY not set');
    return process.env.APIFY_API_KEY;
}

/**
 * Enrich a single LinkedIn profile URL.
 * Returns normalised profile object or null.
 */
async function enrichProfile(linkedinUrl) {
    if (!process.env.APIFY_API_KEY) return null;
    if (!linkedinUrl) return null;

    const url = normaliseLinkedInUrl(linkedinUrl);
    if (!url) return null;

    try {
        // Start run
        const run = await axios.post(
            `${BASE}/acts/${ACTOR_ID}/runs?token=${token()}`,
            { linkedinUrls: [url] },
            { timeout: 15000 }
        );
        const runId = run.data?.data?.id;
        if (!runId) return null;

        // Poll until SUCCEEDED / FAILED
        for (let i = 0; i < MAX_POLLS; i++) {
            await sleep(POLL_MS);
            const status = await axios.get(`${BASE}/actor-runs/${runId}?token=${token()}`);
            const s = status.data?.data?.status;
            if (s === 'SUCCEEDED') {
                const items = await axios.get(
                    `${BASE}/actor-runs/${runId}/dataset/items?token=${token()}`
                );
                const profile = items.data?.[0];
                if (!profile) return null;
                return normalise(profile, linkedinUrl);
            }
            if (s === 'FAILED' || s === 'ABORTED' || s === 'TIMED-OUT') return null;
        }
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Batch enrich multiple LinkedIn URLs in one actor run (more cost-efficient).
 * Returns map: linkedinUrl → profile
 */
async function enrichProfiles(linkedinUrls) {
    if (!process.env.APIFY_API_KEY || !linkedinUrls?.length) return {};

    const urls = linkedinUrls.map(normaliseLinkedInUrl).filter(Boolean);
    if (!urls.length) return {};

    try {
        const run = await axios.post(
            `${BASE}/acts/${ACTOR_ID}/runs?token=${token()}`,
            { linkedinUrls: urls },
            { timeout: 15000 }
        );
        const runId = run.data?.data?.id;
        if (!runId) return {};

        for (let i = 0; i < MAX_POLLS; i++) {
            await sleep(POLL_MS);
            const status = await axios.get(`${BASE}/actor-runs/${runId}?token=${token()}`);
            const s = status.data?.data?.status;
            if (s === 'SUCCEEDED') {
                const items = await axios.get(
                    `${BASE}/actor-runs/${runId}/dataset/items?token=${token()}`
                );
                const result = {};
                for (const p of items.data || []) {
                    const key = `https://www.linkedin.com/in/${p.public_identifier}`;
                    result[key] = normalise(p, key);
                }
                return result;
            }
            if (s === 'FAILED' || s === 'ABORTED' || s === 'TIMED-OUT') return {};
        }
        return {};
    } catch (_) {
        return {};
    }
}

function normalise(profile, sourceUrl) {
    if (!profile) return null;
    const exp = (profile.experiences || []).find(e => !e.ends_at) || profile.experiences?.[0];
    return {
        first_name:   profile.first_name  || null,
        last_name:    profile.last_name   || null,
        full_name:    profile.full_name   || null,
        title:        exp?.title          || profile.headline || null,
        city:         profile.city        || null,
        country:      profile.country     || null,
        linkedin_url: sourceUrl           || null,
        summary:      profile.summary     || null,
        skills:       (profile.skills || []).slice(0, 20).join(', ') || null,
    };
}

function normaliseLinkedInUrl(url) {
    if (!url) return null;
    try {
        const u = url.includes('linkedin.com') ? url : `https://www.linkedin.com/in/${url}`;
        const parsed = new URL(u.startsWith('http') ? u : 'https://' + u);
        if (!parsed.hostname.includes('linkedin.com')) return null;
        return parsed.href.replace(/\/$/, '');
    } catch (_) {
        return null;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { enrichProfile, enrichProfiles };
