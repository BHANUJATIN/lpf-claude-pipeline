/**
 * Findymail — email finding + verification.
 * Account: carl.ct@core-tech-recruitment.com — 4279 finder credits, 9917 verifier credits
 *
 * Endpoints (all POST):
 *   /api/search/name             — find by full name + domain
 *   /api/search/business-profile — find by LinkedIn URL
 *   /api/verify                  — verify an email (only for emails NOT found via Findymail)
 */
const axios = require('axios');

const BASE = 'https://app.findymail.com/api';

function headers() {
    if (!process.env.FINDYMAIL_API_KEY) throw new Error('FINDYMAIL_API_KEY not set');
    return {
        Authorization:  `Bearer ${process.env.FINDYMAIL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
    };
}

const Logger = require('../Logger');
const logger = new Logger('FindymailService');

/**
 * Find email by full name + company domain.
 * Returns { email, verified: true } or { error: '...', status } on failure.
 * Findymail already verifies emails internally — no second verify call needed.
 *
 * NOTE: errors used to be swallowed silently — they now propagate as
 * { error, status } so Stage 5 can persist a skip_reason on the contact.
 */
async function findEmail(firstName, lastName, domain) {
    if (!process.env.FINDYMAIL_API_KEY) return { error: 'FINDYMAIL_API_KEY not set' };
    if (!firstName || !lastName || !domain) return { error: 'missing first_name/last_name/domain' };

    try {
        const res = await axios.post(`${BASE}/search/name`, {
            name:   `${firstName} ${lastName}`.trim(),
            domain: domain.replace(/^https?:\/\/(www\.)?/, ''),
        }, { headers: headers(), timeout: 15000 });

        const contact = res.data?.contact;
        if (!contact?.email) return { error: 'Findymail returned no match', status: res.status };

        return {
            email:    contact.email,
            verified: true,
            result:   'findymail',
        };
    } catch (err) {
        const status = err.response?.status;
        const body   = err.response?.data;
        const msg    = body?.message || body?.error || err.message;
        logger.warn(`Findymail /search/name failed`, { firstName, lastName, domain, status, msg });
        return { error: msg, status };
    }
}

/**
 * Find email by LinkedIn profile URL.
 */
async function findEmailByLinkedIn(linkedinUrl) {
    if (!process.env.FINDYMAIL_API_KEY) return { error: 'FINDYMAIL_API_KEY not set' };
    if (!linkedinUrl) return { error: 'no linkedin url' };

    try {
        const res = await axios.post(`${BASE}/search/business-profile`, {
            url: linkedinUrl,
        }, { headers: headers(), timeout: 15000 });

        const contact = res.data?.contact;
        if (!contact?.email) return { error: 'Findymail returned no match', status: res.status };

        return {
            email:    contact.email,
            verified: true,
            result:   'findymail',
        };
    } catch (err) {
        const status = err.response?.status;
        const body   = err.response?.data;
        const msg    = body?.message || body?.error || err.message;
        logger.warn(`Findymail /search/business-profile failed`, { linkedinUrl, status, msg });
        return { error: msg, status };
    }
}

/**
 * Verify an externally-sourced email (Apollo, JD text, etc.).
 * Returns { valid, result } or null (null = undeliverable, discard).
 * Do NOT call this for emails already found via Findymail.
 */
async function verifyEmail(email) {
    if (!process.env.FINDYMAIL_API_KEY) return { valid: false, result: 'skipped' };
    if (!email) return null;

    try {
        const res = await axios.post(`${BASE}/verify`, { email }, {
            headers: headers(),
            timeout: 15000,
        });

        const result = res.data?.result || 'unknown';
        if (result === 'undeliverable') return null;
        return { valid: result === 'deliverable', result };
    } catch (_) {
        return { valid: false, result: 'unknown' };
    }
}

/**
 * Check account credits.
 */
async function getCredits() {
    if (!process.env.FINDYMAIL_API_KEY) return null;
    const res = await axios.get(`${BASE}/credits`, { headers: headers(), timeout: 5000 });
    return res.data;
}

module.exports = { findEmail, findEmailByLinkedIn, verifyEmail, getCredits };
