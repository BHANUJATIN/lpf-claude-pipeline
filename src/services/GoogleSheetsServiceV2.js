/**
 * GoogleSheetsServiceV2 — generic multi-sheet lookup / append / update.
 *
 * Powers the user-configurable Google Sheet integrations from the Connections tab:
 *   - Company enrichment lookup + write-back
 *   - People email lookup (by LinkedIn username) + write-back
 *   - SAP jobs sheet (write-only)
 *   - CV PDF public-URL save-back
 *
 * Every method accepts an explicit connection config — the service is stateless
 * so multiple sheets can be used in the same pipeline run.
 *
 * Connection config shape (from lpf_connections.config):
 *   {
 *     spreadsheet_id:        '1abc…',                // required
 *     sheet_name:            'Sheet1',               // tab name (default: 'Sheet1')
 *     header_row:            1,                       // 1-indexed
 *     lookup_column:         'linkedin_username',    // header label to match against
 *     output_columns:        ['email','verified_at'], // headers to read on hit
 *     column_mapping:        { email: 'Email Found', linkedin_username: 'LinkedIn URL' },
 *                                // logical → header for both lookup AND write-back
 *     service_account_json:  '{"client_email":…,"private_key":…}'  // either inline
 *     service_account_key_env: 'GOOGLE_SERVICE_ACCOUNT_KEY'         // or env-var name
 *   }
 *
 * Auth: a service-account JSON is required (read AND write). Falls back to the
 * GOOGLE_SERVICE_ACCOUNT_KEY env var if the connection doesn't carry one.
 */
const axios  = require('axios');
const Logger = require('../Logger');

const logger = new Logger('GoogleSheetsV2');

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
].join(' ');

// In-process token cache keyed by service-account client_email
const _tokenCache = new Map();

// ─── Service-account helpers ─────────────────────────────────────────────────

function _resolveServiceAccount(config = {}) {
    let raw = config.service_account_json;
    if (!raw && config.service_account_key_env) raw = process.env[config.service_account_key_env];
    if (!raw) raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!raw && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try { raw = require('fs').readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'utf8'); } catch (_) {}
    }
    if (!raw) throw new Error('No Google service account credentials — set service_account_json on the connection or GOOGLE_SERVICE_ACCOUNT_KEY in .env');
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Resolve a usable access token from any of three sources, in order:
 *   1. OAuth tokens stored on the connection (config.oauth) — refreshed transparently
 *   2. Service-account JSON on the connection (config.service_account_json)
 *   3. Service-account JSON in the env (GOOGLE_SERVICE_ACCOUNT_KEY)
 *
 * Service-account path keeps the existing JWT bearer flow; OAuth path delegates
 * to GoogleOAuthService.getValidAccessToken which handles refresh.
 */
async function _accessToken(config) {
    // ── OAuth path ─────────────────────────────────────────────────────────
    if (config?.oauth?.access_token) {
        // Lazy import to avoid circular require with GoogleDriveService
        const Oauth = require('./GoogleOAuthService');
        return await Oauth.getValidAccessToken({ config });
    }

    // ── Service-account path ───────────────────────────────────────────────
    const key = _resolveServiceAccount(config);
    const cacheKey = key.client_email;
    const cached = _tokenCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss:   key.client_email,
        scope: SCOPES,
        aud:   'https://oauth2.googleapis.com/token',
        iat:   now,
        exp:   now + 3600,
    };
    const jwt = await _signJwt(claim, key.private_key);

    let resp;
    try {
        resp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion:  jwt,
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
        });
    } catch (err) {
        // Surface Google's actual error rather than swallowing it as a vague "auth failed"
        const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
        throw new Error(`Service-account auth failed: ${detail} (client_email=${key.client_email})`);
    }
    const token = resp.data.access_token;
    _tokenCache.set(cacheKey, { token, expires: Date.now() + 55 * 60 * 1000 });
    return token;
}

async function _signJwt(payload, privateKeyPem) {
    const { createSign } = require('crypto');
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sign    = createSign('RSA-SHA256');
    sign.update(`${header}.${body}`);
    return `${header}.${body}.${sign.sign(privateKeyPem, 'base64url')}`;
}

// ─── Sheet reading ───────────────────────────────────────────────────────────

function _googleErr(prefix, err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const detail = body?.error?.message || body?.error_description || body?.error || err.message;
    return Object.assign(
        new Error(`${prefix} (HTTP ${status || '???'}): ${detail}`),
        { httpStatus: status, googleError: body?.error, rawBody: body }
    );
}

/**
 * Fetch every row of the configured sheet.range as a 2-D array (raw values).
 */
async function _fetchAll(config) {
    const token = await _accessToken(config);
    const range = config.range || `${config.sheet_name || 'Sheet1'}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheet_id}/values/${encodeURIComponent(range)}`;
    try {
        const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
        return r.data?.values || [];
    } catch (err) {
        throw _googleErr(`Sheets read failed (id=${config.spreadsheet_id} range="${range}")`, err);
    }
}

/**
 * Parse the sheet into { headers, rows } using the configured header_row.
 * `rows` are objects keyed by header label.
 */
async function readSheet(config) {
    const values = await _fetchAll(config);
    const headerRow = (config.header_row || 1) - 1;
    const headers = (values[headerRow] || []).map(h => String(h || '').trim());
    const rows = values.slice(headerRow + 1).map(arr => {
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = arr[i] != null ? String(arr[i]) : ''; });
        return obj;
    });
    return { headers, rows, raw: values, headerRowIndex: headerRow };
}

/**
 * Look up a single row by matching one sheet column against a value.
 *
 * The sheet column to search in is resolved with this priority (most explicit wins):
 *   1. config.lookup_sheet_column — the literal sheet-header string the operator picked
 *   2. config.column_mapping[config.lookup_pipeline_field] — translation via mapping
 *   3. config.column_mapping[config.lookup_column] — legacy single-key behavior
 *   4. config.lookup_column — last-resort: treat as a direct header
 *
 * Returns { found, row, rowNumber (1-based) } — rowNumber lets callers run
 * a follow-up updateRow.
 */
async function lookupRow(config, value) {
    if (!value) return { found: false };
    const needle = String(value).trim().toLowerCase();

    const lookupHeader =
        (config.lookup_sheet_column || '').trim() ||
        config.column_mapping?.[config.lookup_pipeline_field] ||
        config.column_mapping?.[config.lookup_column] ||
        config.lookup_column ||
        '';

    if (!lookupHeader) throw new Error('lookup_sheet_column (or column_mapping[lookup_pipeline_field]) required');

    const { headers, rows, headerRowIndex } = await readSheet(config);
    const idx = headers.findIndex(h => h.toLowerCase() === lookupHeader.toLowerCase());
    if (idx < 0) {
        logger.debug('Lookup column not found on sheet', { lookupHeader, headers });
        return { found: false };
    }

    for (let i = 0; i < rows.length; i++) {
        const cell = (rows[i][headers[idx]] || '').toString().trim().toLowerCase();
        if (cell === needle) {
            return {
                found:     true,
                row:       rows[i],
                rowNumber: headerRowIndex + 2 + i,
                headers,
            };
        }
    }
    return { found: false };
}

/**
 * Append a logical record (keyed by logical field name) to the sheet, applying
 * the connection's column_mapping to translate to sheet headers.
 */
async function appendRow(config, record) {
    const { headers } = await readSheet(config);
    const arr = headers.map(h => '');
    for (const [logical, value] of Object.entries(record)) {
        const header = config.column_mapping?.[logical] || logical;
        const idx = headers.findIndex(h => h.toLowerCase() === header.toLowerCase());
        if (idx >= 0) arr[idx] = value != null ? String(value) : '';
    }

    const token = await _accessToken(config);
    const range = `${config.sheet_name || 'Sheet1'}!A:${_colLetter(headers.length || 1)}`;
    try {
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheet_id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
            { values: [arr] },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
    } catch (err) {
        throw _googleErr(`Sheets append failed (id=${config.spreadsheet_id} range="${range}")`, err);
    }
    logger.debug('GSheet row appended', { sheet: config.name || config.spreadsheet_id, fields: Object.keys(record) });
}

/**
 * Update the cells of an existing row (1-based) with the given logical fields.
 * Only the fields present in column_mapping (or matching a header by name) get written —
 * other cells are untouched.
 */
async function updateRow(config, rowNumber, record) {
    if (!rowNumber) throw new Error('rowNumber required for updateRow');
    const { headers } = await readSheet(config);
    const data = [];
    for (const [logical, value] of Object.entries(record)) {
        const header = config.column_mapping?.[logical] || logical;
        const idx = headers.findIndex(h => h.toLowerCase() === header.toLowerCase());
        if (idx < 0) continue;
        const cell = `${config.sheet_name || 'Sheet1'}!${_colLetter(idx + 1)}${rowNumber}`;
        data.push({ range: cell, values: [[value != null ? String(value) : '']] });
    }
    if (!data.length) return;

    const token = await _accessToken(config);
    try {
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheet_id}/values:batchUpdate`,
            { valueInputOption: 'RAW', data },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
    } catch (err) {
        throw _googleErr(`Sheets batchUpdate failed (id=${config.spreadsheet_id} row=${rowNumber})`, err);
    }
    logger.debug('GSheet row updated', { sheet: config.name || config.spreadsheet_id, rowNumber, fields: Object.keys(record) });
}

/**
 * Upsert by lookup_column — useful for the "save back after enrichment" flows.
 */
async function upsertRow(config, lookupValue, record) {
    const hit = await lookupRow(config, lookupValue);
    if (hit.found) {
        await updateRow(config, hit.rowNumber, record);
        return { mode: 'updated', rowNumber: hit.rowNumber };
    }
    await appendRow(config, record);
    return { mode: 'appended' };
}

/**
 * Quick read-only ping — used by /api/connections/:id/test.
 * Returns the first row + the header list.
 */
async function testSheet(config) {
    const { headers, rows } = await readSheet(config);
    return {
        ok:           true,
        headers,
        row_count:    rows.length,
        sample_row:   rows[0] || null,
    };
}

function _colLetter(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

module.exports = {
    readSheet,
    lookupRow,
    appendRow,
    updateRow,
    upsertRow,
    testSheet,
    _accessToken,           // exported for GoogleDriveService to reuse the JWT flow
    _resolveServiceAccount,
};
