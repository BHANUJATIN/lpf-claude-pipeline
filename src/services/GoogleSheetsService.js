/**
 * GoogleSheetsService — QC email lookup and write-back
 *
 * Reads/writes the QC Google Sheet:
 *   https://docs.google.com/spreadsheets/d/1e482q70qot-uE7BzFC7tjkKypdpJHiavcMleQ0U_Ac8/
 *
 * Columns: A = LinkedIn Username (slug), B = Email
 *
 * Auth: Uses a Google Service Account JSON key file.
 * Set GOOGLE_SERVICE_ACCOUNT_JSON env var to the path of your service account key,
 * OR set GOOGLE_SERVICE_ACCOUNT_KEY to the raw JSON string.
 *
 * The service account must have "Editor" access to the sheet.
 *
 * Fallback: If no service account is configured, reads via public CSV export (read-only).
 */
const axios  = require('axios');
const Logger = require('../Logger');

const logger = new Logger('GoogleSheetsService');

const SHEET_ID     = process.env.QC_SHEET_ID || '1e482q70qot-uE7BzFC7tjkKypdpJHiavcMleQ0U_Ac8';
const SHEET_RANGE  = process.env.QC_SHEET_RANGE || 'Sheet1!A:B';
const API_KEY      = process.env.GOOGLE_SHEETS_API_KEY;

// In-memory cache (TTL: 10 minutes) to avoid hammering the API for the same slug
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// Normalise a LinkedIn URL or handle to a plain slug for comparison
function toSlug(input) {
    if (!input) return null;
    return input
        .toLowerCase()
        .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '')
        .replace(/^https?:\/\/[a-z]{2}\.linkedin\.com\/in\//i, '')
        .replace(/\/$/, '')
        .trim();
}

/**
 * Look up an email by LinkedIn username/slug in the QC sheet.
 * No verification needed (per spec — QC emails are already verified).
 *
 * @param {string} linkedinUrlOrSlug  Full LinkedIn URL or just the slug/username
 * @returns {Promise<string|null>}  Email or null if not found
 */
async function lookupEmail(linkedinUrlOrSlug) {
    const slug = toSlug(linkedinUrlOrSlug);
    if (!slug) return null;

    // Cache hit
    const cached = cache.get(slug);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.email;

    try {
        const rows = await _fetchAllRows();
        const match = rows.find(r => toSlug(r[0]) === slug);
        const email = match?.[1]?.trim() || null;
        cache.set(slug, { email, ts: Date.now() });
        if (email) logger.debug('QC sheet email found', { slug, email });
        return email;
    } catch (err) {
        logger.warn('QC sheet lookup failed', { error: err.message, slug });
        return null;
    }
}

/**
 * Write (append) a new LinkedIn username + email pair to the QC sheet,
 * or update the email if the slug already exists.
 *
 * @param {string} linkedinUrlOrSlug
 * @param {string} email
 */
async function writeEmail(linkedinUrlOrSlug, email) {
    const slug = toSlug(linkedinUrlOrSlug);
    if (!slug || !email) return;

    // Update cache
    cache.set(slug, { email, ts: Date.now() });

    if (!API_KEY && !_hasServiceAccount()) {
        logger.warn('No Google Sheets write credentials — cannot write back to QC sheet');
        return;
    }

    try {
        const rows = await _fetchAllRows();
        const rowIndex = rows.findIndex(r => toSlug(r[0]) === slug);

        if (rowIndex >= 0) {
            // Update existing row
            const range = `Sheet1!A${rowIndex + 1}:B${rowIndex + 1}`;
            await _sheetsUpdate(range, [[slug, email]]);
            logger.debug('QC sheet row updated', { slug, email });
        } else {
            // Append new row
            await _sheetsAppend([[slug, email]]);
            logger.debug('QC sheet row appended', { slug, email });
        }
    } catch (err) {
        logger.warn('QC sheet write-back failed', { error: err.message, slug, email });
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _fetchAllRows() {
    if (API_KEY) {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}?key=${API_KEY}`;
        const resp = await axios.get(url, { timeout: 10000 });
        return resp.data?.values || [];
    }

    if (_hasServiceAccount()) {
        const token = await _getServiceAccountToken();
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}`;
        const resp = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000,
        });
        return resp.data?.values || [];
    }

    // Public CSV fallback (read-only, works only if sheet is publicly accessible)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
    const resp = await axios.get(csvUrl, { timeout: 10000 });
    return _parseCsv(resp.data);
}

async function _sheetsUpdate(range, values) {
    const token = await _getServiceAccountToken();
    await axios.put(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
        { values },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
}

async function _sheetsAppend(values) {
    const token = await _getServiceAccountToken();
    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
}

// JWT-based service account token (no googleapis dependency needed)
let _tokenCache = null;
async function _getServiceAccountToken() {
    if (_tokenCache && _tokenCache.expires > Date.now()) return _tokenCache.token;

    const keyJson = _hasServiceAccount();
    if (!keyJson) throw new Error('No Google service account credentials configured');

    const key = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;

    const now   = Math.floor(Date.now() / 1000);
    const claim = {
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    };

    const jwt = await _signJwt(claim, key.private_key);
    const resp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
    });

    _tokenCache = { token: resp.data.access_token, expires: Date.now() + 55 * 60 * 1000 };
    return _tokenCache.token;
}

function _hasServiceAccount() {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (raw) return raw;
    const file = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (file) {
        try { return require('fs').readFileSync(file, 'utf8'); } catch (_) {}
    }
    return null;
}

// Minimal RS256 JWT signing without external libraries (Node 18+ crypto)
async function _signJwt(payload, privateKeyPem) {
    const { createSign } = require('crypto');
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signing = `${header}.${body}`;
    const sign    = createSign('RSA-SHA256');
    sign.update(signing);
    const sig = sign.sign(privateKeyPem, 'base64url');
    return `${signing}.${sig}`;
}

function _parseCsv(text) {
    return text.split('\n').filter(Boolean).map(line =>
        line.split(',').map(v => v.replace(/^"|"$/g, '').trim())
    );
}

module.exports = { lookupEmail, writeEmail, toSlug };
