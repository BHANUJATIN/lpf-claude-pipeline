/**
 * TrykittService — email finding via Trykitt.ai API
 *
 * Trykitt finds professional email addresses using LinkedIn URLs or
 * first name + last name + domain.
 *
 * Usage in email waterfall (Stage 5):
 *   1. findByLinkedIn(linkedinUrl)  → email or null
 *   2. findByNameDomain(first, last, domain) → email or null
 *
 * Emails returned by Trykitt should be verified with Findymail before use.
 */
const axios  = require('axios');
const Logger = require('../Logger');

const logger = new Logger('TrykittService');

const BASE_URL = 'https://app.trykitt.ai/api';

function headers() {
    return {
        Authorization: `Bearer ${process.env.TRYKITT_API_KEY}`,
        'Content-Type': 'application/json',
    };
}

/**
 * Find email by LinkedIn profile URL.
 * @param {string} linkedinUrl  Full LinkedIn profile URL
 * @returns {Promise<string|null>}  Email address or null if not found
 */
async function findByLinkedIn(linkedinUrl) {
    if (!process.env.TRYKITT_API_KEY || !linkedinUrl) return null;
    try {
        const resp = await axios.post(
            `${BASE_URL}/find-email`,
            { linkedin_url: linkedinUrl },
            { headers: headers(), timeout: 15000 }
        );
        const email = resp.data?.email || resp.data?.data?.email || null;
        if (email) logger.debug('Trykitt email found via LinkedIn', { linkedin: linkedinUrl, email });
        return email || null;
    } catch (err) {
        if (err.response?.status === 404 || err.response?.status === 422) return null;
        logger.warn('Trykitt findByLinkedIn failed', { error: err.message, linkedin: linkedinUrl });
        return null;
    }
}

/**
 * Find email by first name + last name + domain.
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain  Company domain without protocol (e.g. "acme.com")
 * @returns {Promise<string|null>}
 */
async function findByNameDomain(firstName, lastName, domain) {
    if (!process.env.TRYKITT_API_KEY || !firstName || !lastName || !domain) return null;
    try {
        const resp = await axios.post(
            `${BASE_URL}/find-email`,
            { first_name: firstName, last_name: lastName, domain },
            { headers: headers(), timeout: 15000 }
        );
        const email = resp.data?.email || resp.data?.data?.email || null;
        if (email) logger.debug('Trykitt email found via name+domain', { firstName, lastName, domain, email });
        return email || null;
    } catch (err) {
        if (err.response?.status === 404 || err.response?.status === 422) return null;
        logger.warn('Trykitt findByNameDomain failed', { error: err.message, firstName, lastName, domain });
        return null;
    }
}

module.exports = { findByLinkedIn, findByNameDomain };
