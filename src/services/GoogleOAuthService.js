/**
 * GoogleOAuthService — three-legged OAuth 2.0 flow for the Connections tab.
 *
 * Replaces the service-account-only auth path with a user-friendly "Connect via
 * Google" button: the operator signs in once and we save refresh + access tokens
 * directly onto the connection's config JSONB.
 *
 * After auth, the same service drives the resource pickers shown in the
 * Connections drawer:
 *    • listDrives      — My Drive + every Shared Drive the user can see
 *    • listFiles       — spreadsheets / docs / presentations / folders
 *    • listSheetTabs   — tab names inside a spreadsheet
 *    • listSheetHeaders — header-row cells for column-mapping dropdowns
 *
 * Required env vars:
 *    GOOGLE_OAUTH_CLIENT_ID
 *    GOOGLE_OAUTH_CLIENT_SECRET
 *    GOOGLE_OAUTH_REDIRECT_URI  (default: http://localhost:3000/oauth/google/callback)
 *
 * The "state" parameter is an opaque short-lived token that maps back to the
 * connection row being authorised. Stored in-memory with a 10-minute TTL —
 * enough time for the user to click through the consent screen.
 */
const axios = require('axios');
const crypto = require('crypto');
const Logger = require('../Logger');

const logger = new Logger('GoogleOAuth');

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/userinfo.email',
    'openid',
];

// ─── State store (in-memory, 10-minute TTL) ─────────────────────────────────

const _stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function _putState(state, payload) {
    _stateStore.set(state, { payload, expires: Date.now() + STATE_TTL_MS });
}
function _takeState(state) {
    const entry = _stateStore.get(state);
    if (!entry) return null;
    _stateStore.delete(state);
    if (entry.expires < Date.now()) return null;
    return entry.payload;
}
// Periodic sweep
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _stateStore.entries()) {
        if (v.expires < now) _stateStore.delete(k);
    }
}, 60_000).unref();

// ─── Config helpers ──────────────────────────────────────────────────────────

// Cache for the dashboard-saved OAuth-app row so we don't hit the DB on every call
let _oauthAppRow = null;
let _oauthAppRowAt = 0;
const OAUTH_APP_CACHE_MS = 5_000;

async function _loadOauthAppFromDb() {
    if (_oauthAppRow && (Date.now() - _oauthAppRowAt) < OAUTH_APP_CACHE_MS) return _oauthAppRow;
    try {
        const DatabaseClass = require('../database/Database');
        const pool = DatabaseClass.getInstance().pool;
        const r = await pool.query(
            `SELECT config FROM lpf_connections
             WHERE type = 'google_oauth_app' AND is_default = TRUE
             ORDER BY updated_at DESC LIMIT 1`
        );
        _oauthAppRow   = r.rows[0]?.config || null;
        _oauthAppRowAt = Date.now();
        return _oauthAppRow;
    } catch (_) {
        return null;
    }
}

function invalidateOauthAppCache() {
    _oauthAppRow = null;
    _oauthAppRowAt = 0;
}

/**
 * Resolve OAuth-client credentials from (in priority order):
 *   1. process.env (operator's .env)
 *   2. The default `google_oauth_app` connection row (set via Connections tab)
 *
 * Redirect-URI resolution order (within each source):
 *   1. GOOGLE_OAUTH_REDIRECT_URI env var (full override)
 *   2. The google_oauth_app row's `redirect_uri` field
 *   3. APP_PUBLIC_URL env var + /oauth/google/callback        ← canonical deployment override
 *   4. The current request's protocol + host (when `req` is provided)
 *   5. http://localhost:${PORT}/oauth/google/callback         ← dev fallback
 *
 * Returns { clientId, clientSecret, redirectUri, source }.
 */
async function _oauthSetup(req = null) {
    const envClientId     = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    const envClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

    if (envClientId && envClientSecret) {
        return {
            clientId:     envClientId,
            clientSecret: envClientSecret,
            redirectUri:  _resolveRedirectUri({ req }),
            source:       'env',
        };
    }

    const row = await _loadOauthAppFromDb();
    if (row?.client_id && row?.client_secret) {
        return {
            clientId:     row.client_id,
            clientSecret: row.client_secret,
            redirectUri:  _resolveRedirectUri({ req, rowOverride: row.redirect_uri }),
            source:       'dashboard',
        };
    }

    return {
        clientId:     '',
        clientSecret: '',
        redirectUri:  _resolveRedirectUri({ req }),
        source:       'none',
    };
}

/**
 * Build the redirect URI the OAuth flow should use right now.
 *   • envOverride wins (GOOGLE_OAUTH_REDIRECT_URI) — set this when you want a
 *     hard-coded canonical URL regardless of where the dashboard is accessed from.
 *   • Otherwise, rowOverride (from the google_oauth_app config) wins.
 *   • Otherwise, APP_PUBLIC_URL + /oauth/google/callback (operator's deploy URL).
 *   • Otherwise, derive from req.protocol + req.get('host') (with trust proxy ON
 *     this respects X-Forwarded-Proto from Render/Heroku/Fly/etc.).
 *   • Otherwise, localhost dev default.
 */
function _resolveRedirectUri({ req = null, rowOverride = null } = {}) {
    const envOverride = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (envOverride) return envOverride.replace(/\/$/, '');
    if (rowOverride) return rowOverride.replace(/\/$/, '');

    const publicUrl = process.env.APP_PUBLIC_URL;
    if (publicUrl) return publicUrl.replace(/\/$/, '') + '/oauth/google/callback';

    if (req) {
        try {
            const host = req.get?.('host') || req.headers?.host;
            const proto = req.protocol || (req.headers?.['x-forwarded-proto']?.split(',')[0] || 'http');
            if (host) return `${proto}://${host}/oauth/google/callback`;
        } catch (_) {}
    }

    const port = process.env.PORT || '3000';
    return `http://localhost:${port}/oauth/google/callback`;
}

async function setupOk(req = null) {
    const s = await _oauthSetup(req);
    return Boolean(s.clientId && s.clientSecret);
}

async function setupErrorMessage(req = null) {
    const s = await _oauthSetup(req);
    if (s.clientId && s.clientSecret) return null;
    return `Google OAuth client is not set up. Open Connections → ＋ New → "google_oauth_app" and paste the Client ID + Secret from a Web OAuth client (created at https://console.cloud.google.com/apis/credentials with redirect URI "${s.redirectUri}").`;
}

/**
 * Returns just the redirect URI — useful for the UI to display the value the
 * operator must register in GCP Console. Pass `req` to get the URI for the
 * current request (deployment-aware via X-Forwarded-Proto).
 */
async function getRedirectUri(req = null) {
    const s = await _oauthSetup(req);
    return s.redirectUri;
}

// ─── Step 1: generate auth URL ──────────────────────────────────────────────

/**
 * Build the Google consent screen URL for a specific connection.
 * The `connId` is bound to a state token so the callback knows which row to
 * write the tokens into.
 */
async function generateAuthUrl({ connId, req = null }) {
    const { clientId, redirectUri } = await _oauthSetup(req);
    if (!clientId) throw new Error(await setupErrorMessage(req));

    const state = crypto.randomBytes(24).toString('base64url');
    // Bind the redirect URI used here into the state so exchangeCode() can use
    // the EXACT same value — Google requires byte-perfect match between
    // auth step and code-exchange step.
    _putState(state, { connId, at: Date.now(), redirectUri });

    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         SCOPES.join(' '),
        access_type:   'offline',
        prompt:        'consent',                 // force refresh_token issuance even on re-auth
        include_granted_scopes: 'true',
        state,
    });
    return `${AUTH_URL}?${params.toString()}`;
}

// ─── Step 2: callback — exchange code for tokens ────────────────────────────

async function exchangeCode({ code, state, req = null }) {
    const { clientId, clientSecret, redirectUri: fallbackUri } = await _oauthSetup(req);
    if (!clientId || !clientSecret) throw new Error(await setupErrorMessage(req));

    const payload = _takeState(state);
    if (!payload) throw new Error('Invalid or expired state token — restart the connection flow');

    // Always use the exact redirect URI that was sent during the auth step.
    // Google rejects the code exchange if the value differs by even one character.
    const redirectUri = payload.redirectUri || fallbackUri;

    const body = new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
    }).toString();

    let tokenRes;
    try {
        tokenRes = await axios.post(TOKEN_URL, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
        });
    } catch (err) {
        const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
        throw new Error(`OAuth code exchange failed: ${detail}`);
    }
    const tokens = tokenRes.data;

    // Fetch user email so the UI can label the connected account
    let email = null;
    try {
        const u = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            timeout: 15000,
        });
        email = u.data?.email || null;
    } catch (_) { /* non-fatal */ }

    const expiresAt = Date.now() + Math.max(0, (tokens.expires_in || 3600) - 60) * 1000;

    return {
        connId: payload.connId,
        oauth: {
            access_token:      tokens.access_token,
            refresh_token:     tokens.refresh_token || null, // may be null on re-auth — keep the old one
            scope:             tokens.scope         || SCOPES.join(' '),
            token_type:        tokens.token_type    || 'Bearer',
            expires_at:        expiresAt,
            user_email:        email,
            connected_at:      Date.now(),
        },
    };
}

// ─── Step 3: refresh access tokens transparently ────────────────────────────

async function _refreshAccessToken(refreshToken) {
    const { clientId, clientSecret } = await _oauthSetup();
    const body = new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
    }).toString();

    let r;
    try {
        r = await axios.post(TOKEN_URL, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
        });
    } catch (err) {
        const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
        throw new Error(`OAuth refresh failed: ${detail}`);
    }
    return {
        access_token: r.data.access_token,
        expires_at:   Date.now() + Math.max(0, (r.data.expires_in || 3600) - 60) * 1000,
    };
}

/**
 * Returns a valid access token for the given connection config.
 * - If the connection holds OAuth tokens and the access token is still valid → return it.
 * - If expired → refresh using the stored refresh token AND mutate the config in place
 *   (caller is responsible for persisting the updated config back to lpf_connections
 *    via Connections.update).
 */
async function getValidAccessToken(connRow) {
    const oauth = connRow?.config?.oauth;
    if (!oauth?.access_token) throw new Error('Connection is not OAuth-authorised yet');
    if ((oauth.expires_at || 0) > Date.now() + 30_000) return oauth.access_token;
    if (!oauth.refresh_token)  throw new Error('Access token expired but no refresh token — reconnect the Google account');

    const refreshed = await _refreshAccessToken(oauth.refresh_token);
    oauth.access_token = refreshed.access_token;
    oauth.expires_at   = refreshed.expires_at;
    return refreshed.access_token;
}

// ─── Authed GET helper with full error surface ───────────────────────────────

async function _get(url, token, params = {}) {
    try {
        const r = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            params,
            timeout: 20000,
        });
        return r.data;
    } catch (err) {
        const status = err.response?.status;
        const body   = err.response?.data;
        const detail = body?.error?.message || body?.error_description || body?.error || err.message;
        throw Object.assign(
            new Error(`Google API ${url.split('/').slice(-2).join('/')} failed (HTTP ${status || '???'}): ${detail}`),
            { httpStatus: status, googleError: body?.error, rawBody: body }
        );
    }
}

// ─── Resource pickers ───────────────────────────────────────────────────────

/**
 * Returns [{ id, name, isShared }] — My Drive is always first (id='my-drive').
 */
async function listDrives(connRow) {
    const token = await getValidAccessToken(connRow);
    const out = [{ id: 'my-drive', name: 'My Drive', isShared: false }];
    let pageToken = null;
    do {
        const data = await _get('https://www.googleapis.com/drive/v3/drives', token, {
            pageSize: 100,
            pageToken: pageToken || undefined,
        });
        for (const d of (data.drives || [])) out.push({ id: d.id, name: d.name, isShared: true });
        pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
}

const MIME_TYPES = {
    spreadsheet:  'application/vnd.google-apps.spreadsheet',
    document:     'application/vnd.google-apps.document',
    presentation: 'application/vnd.google-apps.presentation',
    folder:       'application/vnd.google-apps.folder',
};

/**
 * List files of a given Google type within (optionally) a specific drive.
 * Returns [{ id, name, mimeType, modifiedTime, webViewLink, owners }].
 *
 *   filter.type        — 'spreadsheet'|'document'|'presentation'|'folder'|'any'
 *   filter.driveId     — 'my-drive' or a shared drive id (omit for all)
 *   filter.q           — substring filter on name
 *   filter.pageSize    — default 100
 */
async function listFiles(connRow, filter = {}) {
    const token = await getValidAccessToken(connRow);
    const clauses = ['trashed = false'];
    if (filter.type && filter.type !== 'any' && MIME_TYPES[filter.type]) {
        clauses.push(`mimeType = '${MIME_TYPES[filter.type]}'`);
    }
    if (filter.q) {
        clauses.push(`name contains '${String(filter.q).replace(/'/g, "\\'")}'`);
    }
    const params = {
        q:             clauses.join(' and '),
        pageSize:      filter.pageSize || 100,
        fields:        'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress)),nextPageToken',
        orderBy:       'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    };
    if (filter.driveId && filter.driveId !== 'my-drive') {
        params.corpora    = 'drive';
        params.driveId    = filter.driveId;
    } else if (filter.driveId === 'my-drive') {
        params.corpora    = 'user';
    }
    const data = await _get('https://www.googleapis.com/drive/v3/files', token, params);
    return data.files || [];
}

/**
 * List tab names inside a spreadsheet.
 * Returns [{ sheetId, title, gid, gridProperties }].
 */
async function listSheetTabs(connRow, spreadsheetId) {
    const token = await getValidAccessToken(connRow);
    const data = await _get(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
        token,
        { fields: 'sheets.properties' }
    );
    return (data.sheets || []).map(s => ({
        sheetId:        s.properties?.sheetId,
        title:          s.properties?.title,
        gridProperties: s.properties?.gridProperties,
    }));
}

/**
 * Read the header row of a sheet tab and return the headers (cell strings).
 *   headerRow defaults to 1 (1-indexed).
 */
async function listSheetHeaders(connRow, { spreadsheetId, tabName, headerRow = 1 }) {
    const token = await getValidAccessToken(connRow);
    const range = `${tabName || 'Sheet1'}!${headerRow}:${headerRow}`;
    const data = await _get(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        token
    );
    return (data.values?.[0] || []).map(h => String(h || '').trim()).filter(Boolean);
}

module.exports = {
    SCOPES,
    setupOk,
    setupErrorMessage,
    getRedirectUri,
    invalidateOauthAppCache,
    generateAuthUrl,
    exchangeCode,
    getValidAccessToken,
    listDrives,
    listFiles,
    listSheetTabs,
    listSheetHeaders,
    MIME_TYPES,
};
