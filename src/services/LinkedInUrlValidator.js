/**
 * LinkedIn URL validator.
 *
 * Used by Stage 4 / Stage 5 / Stage 7 to drop fabricated or 404 LinkedIn URLs
 * BEFORE persisting a contact to lpf_contacts. The validator runs two checks:
 *
 *   1. Static — shape check + reject known fabrication patterns
 *        - must match https://(www.)linkedin.com/in/<slug>/
 *        - reject URLs ending in `-\d{8,}$` (sequential-digit hallucinations)
 *        - reject all-numeric slugs or slugs < 3 chars
 *
 *   2. Live   — HEAD request to the URL. LinkedIn returns 200/301/302 for
 *        valid public profiles and 404 / 999 for missing / blocked ones.
 *        Times out at 5s so it can't stall the pipeline. Results are cached
 *        in-memory for the lifetime of the process to avoid redundant calls.
 *
 * Live checks can be disabled by setting LINKEDIN_LIVE_CHECK=false (the
 * static check still runs).
 *
 * Returns one of:
 *   { ok: true,  reason: 'static_pass' | 'live_pass' }
 *   { ok: false, reason: 'shape' | 'fabricated' | '404' | 'blocked' | 'live_error' }
 */
const axios  = require('axios');
const Logger = require('../Logger');

const logger = new Logger('LinkedInUrlValidator');

// Cache so we don't re-HEAD the same URL within a pipeline run
const _cache = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 min

// Patterns commonly seen on hallucinated URLs (Stage 7 web search used to fabricate these)
const FABRICATION_RE   = /\/in\/[a-z0-9-]+-\d{8,}\/?$/i;
const ALL_DIGITS_SLUG  = /\/in\/\d+\/?$/;
const VALID_SHAPE      = /^https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_\-%]+\/?$/i;

/**
 * @param {string} url
 * @returns {Promise<{ok: boolean, reason: string, status?: number}>}
 */
async function validate(url) {
    if (!url || typeof url !== 'string') return { ok: false, reason: 'shape' };

    const clean = url.trim().replace(/\/+$/, '');

    // ── 1. Static shape check ────────────────────────────────────────────────
    if (!VALID_SHAPE.test(clean))           return { ok: false, reason: 'shape' };
    if (FABRICATION_RE.test(clean))         return { ok: false, reason: 'fabricated' };
    if (ALL_DIGITS_SLUG.test(clean))        return { ok: false, reason: 'fabricated' };

    const slug = clean.split('/in/')[1]?.replace(/\/$/, '');
    if (!slug || slug.length < 3)           return { ok: false, reason: 'shape' };

    // ── 2. Live HEAD check (optional, default ON) ────────────────────────────
    if (process.env.LINKEDIN_LIVE_CHECK === 'false') {
        return { ok: true, reason: 'static_pass' };
    }

    // Cache hit?
    const cached = _cache.get(clean);
    if (cached && cached.expires > Date.now()) return cached.result;

    try {
        const res = await axios.head(clean, {
            timeout: 5000,
            maxRedirects: 3,
            // LinkedIn often rejects scrapers; pretend to be a regular browser
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LPF-LinkedInChecker/1.0)' },
            validateStatus: () => true, // we evaluate status ourselves
        });
        const status = res.status || 0;
        let result;
        if (status >= 200 && status < 400) {
            result = { ok: true, reason: 'live_pass', status };
        } else if (status === 404 || status === 410) {
            result = { ok: false, reason: '404', status };
        } else if (status === 999 || status === 403 || status === 429) {
            // LinkedIn anti-scrape; we can't verify either way — fail open to avoid
            // throwing away potentially valid leads, but record the indeterminate state
            result = { ok: true, reason: 'blocked_indeterminate', status };
        } else {
            result = { ok: false, reason: 'live_error', status };
        }
        _cache.set(clean, { result, expires: Date.now() + TTL_MS });
        return result;
    } catch (err) {
        // Network/timeout — fail open (don't lose a contact because LinkedIn was slow)
        logger.debug('LinkedIn HEAD failed (fail-open)', { url: clean, error: err.message });
        const result = { ok: true, reason: 'live_unreachable_failopen' };
        _cache.set(clean, { result, expires: Date.now() + 60_000 }); // shorter TTL on errors
        return result;
    }
}

/**
 * Filter an array of contact objects, returning only those with valid LinkedIn URLs.
 * Contacts WITHOUT a LinkedIn URL pass through unchanged (we can still email them).
 */
async function filterValid(contacts, { linkedinKey = 'linkedin_url' } = {}) {
    const kept    = [];
    const dropped = [];
    for (const c of contacts) {
        const url = c[linkedinKey] || c.li_merged || c.linkedin_url_merged || c.person_linkedin_url;
        if (!url) { kept.push(c); continue; } // no LI URL is OK (email-only contact)
        const v = await validate(url);
        if (v.ok) kept.push(c);
        else dropped.push({ contact: c, reason: v.reason, status: v.status });
    }
    return { kept, dropped };
}

module.exports = { validate, filterValid };
