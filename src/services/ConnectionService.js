/**
 * ConnectionService — the canonical way to read/write user-configured integrations.
 *
 * Three integration types live in lpf_connections:
 *
 *   1. api_key          → arbitrary provider keys (OpenAI, Apollo, Findymail, …)
 *   2. google_sheet     → a single Google Sheet + column mapping for one purpose
 *   3. google_drive     → a Drive account + optional default folder
 *
 * Each row has a `purpose` tag that anchors it to a usage site so the pipeline
 * can pick the right config without the operator picking it manually every run.
 *
 *   purpose values in active use:
 *     'company_enrich'   — Stage 2 lookup + save-back (google_sheet)
 *     'people_email'     — Stage 5 LinkedIn-username → email lookup + save-back (google_sheet)
 *     'sap_jobs_write'   — pipeline end: write the SAP job row (google_sheet, write-only)
 *     'cv_save_back'     — CV PDF: write the public Drive URL back to a row (google_sheet)
 *     'cv_drive'         — Drive account + folder that stores the CV PDFs (google_drive)
 *     '<provider>'       — for api_key rows (e.g. 'openai', 'apollo')
 */
const DatabaseClass = require('../database/Database');

function pool() { return DatabaseClass.getInstance().pool; }

async function listAll() {
    const r = await pool().query(
        `SELECT id, type, purpose, name, config, is_default, status,
                last_check_at, last_check_msg, created_at, updated_at
         FROM lpf_connections
         ORDER BY type, purpose NULLS LAST, name`
    );
    return r.rows.map(_redact);
}

async function getById(id) {
    const r = await pool().query(`SELECT * FROM lpf_connections WHERE id = $1`, [id]);
    return r.rows[0] || null;
}

/**
 * Return the default connection for a (type, purpose) pair, or the first one
 * matching if no default is set. Used by every pipeline integration point.
 */
async function getDefault(type, purpose = null) {
    const r = await pool().query(
        `SELECT * FROM lpf_connections
         WHERE type = $1
           AND (purpose = $2 OR ($2 IS NULL AND purpose IS NULL))
         ORDER BY is_default DESC, created_at ASC
         LIMIT 1`,
        [type, purpose]
    );
    return r.rows[0] || null;
}

async function create({ type, purpose, name, config, is_default }) {
    if (!type)  throw new Error('type required');
    if (!name)  throw new Error('name required');
    const cfg = config && typeof config === 'object' ? config : {};

    // If marking this as default for its (type, purpose) slot, clear the other defaults first
    if (is_default) {
        await pool().query(
            `UPDATE lpf_connections SET is_default = FALSE
             WHERE type = $1 AND (purpose = $2 OR ($2 IS NULL AND purpose IS NULL))`,
            [type, purpose || null]
        );
    }

    const r = await pool().query(
        `INSERT INTO lpf_connections (type, purpose, name, config, is_default, status, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'untested', NOW())
         RETURNING *`,
        [type, purpose || null, name, JSON.stringify(cfg), !!is_default]
    );
    if (type === 'google_oauth_app') {
        try { require('./GoogleOAuthService').invalidateOauthAppCache(); } catch (_) {}
    }
    return _redact(r.rows[0]);
}

async function update(id, fields) {
    const existing = await getById(id);
    if (!existing) throw new Error(`Connection ${id} not found`);

    const allowed = ['name', 'purpose', 'config', 'is_default'];
    const sets    = [];
    const params  = [id];

    for (const [k, v] of Object.entries(fields)) {
        if (!allowed.includes(k)) continue;
        if (k === 'config') {
            // Merge — never blow away keys the operator didn't touch
            const merged = { ...(existing.config || {}), ...(v || {}) };
            sets.push(`config = $${params.length + 1}::jsonb`);
            params.push(JSON.stringify(merged));
        } else {
            sets.push(`${k} = $${params.length + 1}`);
            params.push(v);
        }
    }
    if (!sets.length) return _redact(existing);

    if (fields.is_default) {
        await pool().query(
            `UPDATE lpf_connections SET is_default = FALSE
             WHERE type = $1 AND (purpose = $2 OR ($2 IS NULL AND purpose IS NULL)) AND id <> $3`,
            [existing.type, existing.purpose, id]
        );
    }

    sets.push(`updated_at = NOW()`);
    const r = await pool().query(
        `UPDATE lpf_connections SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
    );
    if (existing.type === 'google_oauth_app') {
        try { require('./GoogleOAuthService').invalidateOauthAppCache(); } catch (_) {}
    }
    return _redact(r.rows[0]);
}

async function remove(id) {
    const row = await getById(id);
    await pool().query(`DELETE FROM lpf_connections WHERE id = $1`, [id]);
    if (row?.type === 'google_oauth_app') {
        try { require('./GoogleOAuthService').invalidateOauthAppCache(); } catch (_) {}
    }
}

/**
 * Test a connection. Dispatches by type.
 * Stores the result on the row (status + last_check_msg).
 */
async function test(id) {
    const row = await getById(id);
    if (!row) throw new Error(`Connection ${id} not found`);

    let result;
    try {
        if (row.type === 'google_sheet') {
            const { testSheet } = require('./GoogleSheetsServiceV2');
            // For OAuth connections without a spreadsheet picked yet, do a softer check
            if (row.config?.auth_method === 'oauth' && !row.config?.spreadsheet_id) {
                if (!row.config?.oauth?.access_token) {
                    result = { ok: false, msg: 'OAuth not connected yet — click "Connect Google account"' };
                } else {
                    result = { ok: true, msg: `OAuth connected as ${row.config.oauth.user_email || '(no email)'} — pick a spreadsheet to enable read/write` };
                }
            } else if (!row.config?.spreadsheet_id) {
                result = { ok: false, msg: 'No spreadsheet_id configured' };
            } else {
                const t = await testSheet(row.config);
                result = { ok: true, msg: `OK — sheet "${row.config.sheet_name || 'Sheet1'}" has ${t.row_count} data rows, ${t.headers.length} columns: ${t.headers.slice(0, 5).join(', ')}${t.headers.length > 5 ? '…' : ''}` };
            }
        } else if (row.type === 'google_drive') {
            // Mirror the sheet flow — actionable message when OAuth is selected but not yet connected
            if (row.config?.auth_method === 'oauth' && !row.config?.oauth?.access_token) {
                result = { ok: false, msg: 'OAuth not connected yet — click "Connect Google account"' };
            } else {
                const { testDrive } = require('./GoogleDriveService');
                const t = await testDrive(row.config);
                result = { ok: true, msg: `OK — authenticated as ${t.user_email || t.user_name || 'service account'}` };
            }
        } else if (row.type === 'google_oauth_app') {
            // Singleton config that holds the GCP OAuth Web client credentials.
            // We just sanity-check the fields are present; the real verification
            // happens on the first OAuth round-trip.
            const c = row.config || {};
            if (!c.client_id || !c.client_secret) {
                result = { ok: false, msg: 'Missing client_id or client_secret' };
            } else if (!/\.apps\.googleusercontent\.com$/.test(c.client_id)) {
                result = { ok: false, msg: `client_id must end in .apps.googleusercontent.com (got: ${c.client_id})` };
            } else {
                // Invalidate the OAuth setup cache so the new credentials take effect immediately
                try { require('./GoogleOAuthService').invalidateOauthAppCache(); } catch (_) {}
                result = { ok: true, msg: `OAuth client ready (${c.client_id.slice(0, 16)}…). Redirect URI: ${c.redirect_uri || '(default)'}` };
            }
        } else if (row.type === 'google_doc' || row.type === 'google_presentation') {
            // OAuth-only; verifies the account works against the matching API
            if (!row.config?.oauth?.access_token) {
                result = { ok: false, msg: 'OAuth not connected yet — click "Connect Google account"' };
            } else {
                const Oauth = require('./GoogleOAuthService');
                try {
                    await Oauth.getValidAccessToken(row);
                    result = { ok: true, msg: `OAuth connected as ${row.config.oauth.user_email || '(no email)'}` };
                } catch (err) { result = { ok: false, msg: err.message }; }
            }
        } else if (row.type === 'api_key') {
            const provider = (row.purpose || '').toLowerCase();
            const schema = PROVIDER_SCHEMA[provider];
            if (!schema) {
                result = { ok: false, msg: `Unknown provider "${provider}" — add it to PROVIDER_SCHEMA` };
            } else if (!row.config?.key) {
                result = { ok: false, msg: `Missing API key for "${schema.label}"` };
            } else {
                // Actually call the provider — no more lying about "ok" when the key is junk.
                const probe = await _probeApiKey(provider, row.config);
                result = probe;
            }
        } else {
            result = { ok: false, msg: `Unknown connection type: ${row.type}` };
        }
    } catch (err) {
        // Bubble up the full Google error chain when available
        const detail = err.httpStatus
            ? `HTTP ${err.httpStatus}: ${err.message}${err.googleError?.errors?.[0]?.reason ? ` (reason=${err.googleError.errors[0].reason})` : ''}`
            : err.message;
        result = { ok: false, msg: detail };
    }

    await pool().query(
        `UPDATE lpf_connections SET status = $2, last_check_at = NOW(), last_check_msg = $3 WHERE id = $1`,
        [id, result.ok ? 'ok' : 'error', result.msg]
    );
    return result;
}

/**
 * Internal helper used by the OAuth callback handler — atomically merges the
 * tokens returned by Google into the connection's config.oauth blob.
 */
async function attachOAuthTokens(connId, oauth) {
    const existing = await getById(connId);
    if (!existing) throw new Error(`Connection ${connId} not found`);

    // Preserve a refresh_token if Google didn't return a new one (only first consent yields it)
    const merged = { ...(existing.config?.oauth || {}), ...oauth };
    if (!merged.refresh_token && existing.config?.oauth?.refresh_token) {
        merged.refresh_token = existing.config.oauth.refresh_token;
    }

    const cfg = { ...(existing.config || {}), auth_method: 'oauth', oauth: merged };
    await pool().query(
        `UPDATE lpf_connections SET config = $2::jsonb, status = 'ok', last_check_at = NOW(),
                                    last_check_msg = $3, updated_at = NOW()
         WHERE id = $1`,
        [connId, JSON.stringify(cfg), `OAuth connected as ${merged.user_email || '(no email)'}`]
    );
    return getById(connId);
}

/**
 * Persist a refreshed access token after a transparent refresh during a request.
 * Called by middleware-style code after getValidAccessToken mutates the token.
 */
async function saveRefreshedTokens(connId, oauth) {
    const existing = await getById(connId);
    if (!existing) return;
    const merged = { ...(existing.config?.oauth || {}), ...oauth };
    const cfg = { ...(existing.config || {}), oauth: merged };
    await pool().query(
        `UPDATE lpf_connections SET config = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [connId, JSON.stringify(cfg)]
    );
}

// Strip the most sensitive fields before sending to the dashboard. Only the
// password-typed fields are masked; identifiers (campaign IDs, list IDs, user
// IDs) are returned in full so the operator can verify them.
function _redact(row) {
    if (!row) return row;
    const out = { ...row };
    if (out.config) {
        const c = { ...out.config };
        if (c.service_account_json) {
            try {
                const parsed = JSON.parse(c.service_account_json);
                c.service_account_json = '<configured — ' + (parsed.client_email || 'no client_email') + '>';
            } catch (_) {
                c.service_account_json = '<configured>';
            }
        }
        if (c.private_key) c.private_key = '<configured>';
        if (c.oauth?.access_token)  c.oauth = { ...c.oauth, access_token:  '<configured>' };
        if (c.oauth?.refresh_token) c.oauth = { ...c.oauth, refresh_token: '<configured>' };
        // Mask the secret on the OAuth-app row — client_id stays visible (it's public-ish, ends in .apps.googleusercontent.com)
        if (out.type === 'google_oauth_app' && c.client_secret) {
            c.client_secret = `${c.client_secret.slice(0, 4)}…${c.client_secret.slice(-2)}`;
        }
        if (out.type === 'api_key') {
            const schema = PROVIDER_SCHEMA[(out.purpose || '').toLowerCase()];
            const passwordFields = new Set(schema?.fields?.filter(f => f.type === 'password').map(f => f.name) || ['key']);
            for (const fname of passwordFields) {
                const v = c[fname];
                if (v && typeof v === 'string') c[fname] = v.length > 6 ? `${v.slice(0, 4)}…${v.slice(-2)}` : '<set>';
            }
        }
        out.config = c;
    }
    return out;
}

/**
 * Per-provider config schema — what extra fields the Connections UI shows and
 * which env vars they hydrate into. Every entry's `key` is the api-key value;
 * additional fields (e.g. heyreach.list_id, instantly.campaign_id) are pushed
 * into their matching env var so existing services see them without code
 * changes.
 *
 * To add a provider: append a row here, then the connection editor + the env
 * hydrate path picks it up automatically.
 */
const PROVIDER_SCHEMA = {
    openai:        { label: 'OpenAI',         fields: [{ name: 'key',     env: 'OPENAI_API_KEY',     label: 'API key',       type: 'password' }] },
    apollo:        { label: 'Apollo',         fields: [{ name: 'key',     env: 'APOLLO_API_KEY',     label: 'API key',       type: 'password' }] },
    findymail:     { label: 'Findymail',      fields: [{ name: 'key',     env: 'FINDYMAIL_API_KEY',  label: 'API key',       type: 'password' }] },
    proxycurl:     { label: 'Proxycurl',      fields: [{ name: 'key',     env: 'PROXYCURL_API_KEY',  label: 'API key',       type: 'password' }] },
    serper:        { label: 'Serper',         fields: [{ name: 'key',     env: 'SERPER_API_KEY',     label: 'API key',       type: 'password' }] },
    harvest:       { label: 'Harvest API',    fields: [{ name: 'key',     env: 'HARVEST_API_KEY',    label: 'API key',       type: 'password' }] },
    trykitt:       { label: 'Trykitt.ai',     fields: [{ name: 'key',     env: 'TRYKITT_API_KEY',    label: 'API key',       type: 'password' }] },
    apify:         { label: 'Apify',          fields: [{ name: 'key',     env: 'APIFY_API_KEY',      label: 'API token',     type: 'password' }] },
    clearbit:      { label: 'Clearbit',       fields: [{ name: 'key',     env: 'CLEARBIT_API_KEY',   label: 'API key',       type: 'password' }] },
    recruiterflow: {
        label: 'RecruiterFlow',
        fields: [
            { name: 'key',     env: 'RECRUITERFLOW_API_KEY', label: 'RF-Api-Key header', type: 'password' },
            { name: 'user_id', env: 'RECRUITERFLOW_USER_ID', label: 'Owner user ID',     type: 'text',     placeholder: 'e.g. 264375' },
        ],
    },
    instantly: {
        label: 'Instantly',
        fields: [
            { name: 'key',                env: 'INSTANTLY_API_KEY',           label: 'API key',              type: 'password' },
            { name: 'campaign_id',        env: 'INSTANTLY_CAMPAIGN_ID',       label: 'Default campaign ID',  type: 'text',     placeholder: 'campaign UUID Stage 8 sends to' },
            { name: 'clay_campaign_name', env: 'INSTANTLY_CLAY_CAMPAIGN_NAME',label: 'Legacy Clay campaign name', type: 'text', placeholder: 'Skip if lead already in this campaign' },
        ],
    },
    heyreach: {
        label: 'HeyReach',
        fields: [
            { name: 'key',                    env: 'HEYREACH_API_KEY',                 label: 'X-API-KEY',                    type: 'password' },
            { name: 'list_id',                env: 'HEYREACH_LIST_ID',                 label: 'Default lead list ID',         type: 'text', placeholder: 'numeric list ID for addLead' },
            { name: 'campaign_free_inmail',   env: 'HEYREACH_CAMPAIGN_FREE_INMAIL',    label: 'Free InMail campaign ID',      type: 'text', placeholder: 'e.g. 145461 — used for free_inmail route' },
            { name: 'campaign_conreq_inmail', env: 'HEYREACH_CAMPAIGN_CONREQ_INMAIL',  label: 'ConReq + InMail campaign ID',  type: 'text', placeholder: 'used for conreq_plus_inmail route' },
            { name: 'campaign_connect_only',  env: 'HEYREACH_CAMPAIGN_CONNECT_ONLY',   label: 'Connect-only campaign ID',     type: 'text', placeholder: 'used for connect_only route' },
        ],
    },
};

const PROVIDER_LIST = Object.keys(PROVIDER_SCHEMA);

/**
 * Back-compat alias used by older code paths that just want provider→key env var.
 * (e.g. `process.env[PROVIDER_ENV_MAP[purpose]]`)
 */
const PROVIDER_ENV_MAP = Object.fromEntries(
    Object.entries(PROVIDER_SCHEMA).map(([p, s]) => [p, s.fields.find(f => f.name === 'key')?.env])
);

/**
 * Push api_key connections into process.env, but ONLY for env vars that are
 * empty — anything the operator already set in .env wins.
 *
 * Reasoning: an empty `OPENAI_API_KEY` in .env is a strong signal the operator
 * wants the connection to drive it. A real key in .env signals "this is the
 * source of truth" and we must not silently overwrite it with a stale row.
 *
 * If you want to swap a key, edit/delete the .env line OR remove the env-var
 * entirely.
 */
async function hydrateApiKeysToEnv() {
    try {
        const r = await pool().query(
            `SELECT purpose, config FROM lpf_connections
             WHERE type = 'api_key' AND is_default = TRUE`
        );
        let filled = 0;
        for (const row of r.rows) {
            const schema = PROVIDER_SCHEMA[(row.purpose || '').toLowerCase()];
            if (!schema) continue;
            for (const field of schema.fields) {
                const value = row.config?.[field.name];
                if (value == null || value === '') continue;
                // .env wins — never overwrite a value the operator typed there
                if (process.env[field.env] && String(process.env[field.env]).length > 0) continue;
                process.env[field.env] = String(value);
                filled++;
            }
        }
        return filled;
    } catch (_) {
        return 0;
    }
}

// ── Provider key probing — real auth checks ─────────────────────────────────
const axios = require('axios');

/**
 * Hit a cheap, authenticated endpoint per provider to PROVE the key works.
 * Never returns "ok" without verification — if the key is invalid, the operator
 * sees the actual provider error (401, 403, etc.) before the pipeline burns
 * tokens on it.
 */
async function _probeApiKey(provider, config) {
    const k = config.key;
    const ok  = (msg)        => ({ ok: true,  msg });
    const bad = (msg, extra) => ({ ok: false, msg: extra ? `${msg} (${extra})` : msg });
    const wrapAxios = async (call, label) => {
        try { await call(); return ok(label); }
        catch (err) {
            const s = err.response?.status;
            const m = err.response?.data?.error?.message
                   || err.response?.data?.message
                   || err.response?.data?.error
                   || err.message;
            const detail = typeof m === 'string' ? m : JSON.stringify(m).slice(0, 200);
            return bad(`${label.split(' ')[0]} auth failed`, `HTTP ${s || '???'}: ${detail}`);
        }
    };

    switch (provider) {
        case 'openai':
            return wrapAxios(
                () => axios.get('https://api.openai.com/v1/models', {
                    headers: { Authorization: `Bearer ${k}` }, timeout: 10000,
                }),
                'OpenAI auth verified',
            );

        case 'apollo':
            return wrapAxios(
                () => axios.get('https://api.apollo.io/v1/auth/health', {
                    headers: { 'X-Api-Key': k }, timeout: 10000,
                }),
                'Apollo auth verified',
            );

        case 'findymail':
            return wrapAxios(
                () => axios.get('https://app.findymail.com/api/credits', {
                    headers: { Authorization: `Bearer ${k}`, Accept: 'application/json' }, timeout: 10000,
                }),
                'Findymail auth verified',
            );

        case 'proxycurl':
            return wrapAxios(
                () => axios.get('https://nubela.co/proxycurl/api/credit-balance', {
                    headers: { Authorization: `Bearer ${k}` }, timeout: 10000,
                }),
                'Proxycurl auth verified',
            );

        case 'serper':
            return wrapAxios(
                () => axios.post('https://google.serper.dev/search',
                    { q: 'test', num: 1 },
                    { headers: { 'X-API-KEY': k, 'Content-Type': 'application/json' }, timeout: 10000 }),
                'Serper auth verified',
            );

        case 'apify':
            return wrapAxios(
                () => axios.get('https://api.apify.com/v2/users/me', {
                    headers: { Authorization: `Bearer ${k}` }, timeout: 10000,
                }),
                'Apify auth verified',
            );

        case 'clearbit':
            return wrapAxios(
                () => axios.get('https://person-stream.clearbit.com/v2/people/find?email=test@example.com', {
                    headers: { Authorization: `Bearer ${k}` }, timeout: 10000,
                }),
                'Clearbit auth verified',
            );

        case 'harvest':
            return wrapAxios(
                () => axios.get('https://api.harvest-api.com/health', {
                    headers: { 'X-API-Key': k }, timeout: 10000,
                }),
                'Harvest auth verified',
            );

        case 'trykitt':
            return wrapAxios(
                () => axios.get('https://app.trykitt.ai/api/me', {
                    headers: { Authorization: `Bearer ${k}` }, timeout: 10000,
                }),
                'Trykitt auth verified',
            );

        case 'instantly': {
            // Instantly's v2 API uses Bearer auth. Listing campaigns is the cheapest verified read.
            const probe = await wrapAxios(
                () => axios.get('https://api.instantly.ai/api/v2/campaigns?limit=1', {
                    headers: { Authorization: `Bearer ${k}` }, timeout: 12000,
                }),
                'Instantly auth verified',
            );
            if (!probe.ok) return probe;
            const missing = [];
            if (!config.campaign_id)        missing.push('campaign_id');
            if (!config.clay_campaign_name) missing.push('clay_campaign_name');
            return { ok: true, msg: `${probe.msg}${missing.length ? ' · ⚠ missing: ' + missing.join(', ') : ' · campaign_id + clay_campaign_name set'}` };
        }

        case 'heyreach': {
            const probe = await wrapAxios(
                () => axios.post('https://api.heyreach.io/api/public/campaign/GetAll',
                    { limit: 1 },
                    { headers: { 'X-API-KEY': k, 'Content-Type': 'application/json' }, timeout: 12000 }),
                'HeyReach auth verified',
            );
            if (!probe.ok) return probe;
            const missing = [];
            if (!config.list_id)                missing.push('list_id');
            if (!config.campaign_free_inmail)   missing.push('campaign_free_inmail');
            if (!config.campaign_conreq_inmail) missing.push('campaign_conreq_inmail');
            if (!config.campaign_connect_only)  missing.push('campaign_connect_only');
            return { ok: true, msg: `${probe.msg}${missing.length ? ' · ⚠ missing: ' + missing.join(', ') : ' · list + all 3 campaigns set'}` };
        }

        case 'recruiterflow':
            return wrapAxios(
                () => axios.get('https://recruiterflow.com/api/external/job/list?page=1&items_per_page=1', {
                    headers: { 'RF-Api-Key': k }, timeout: 10000,
                }),
                'RecruiterFlow auth verified',
            );

        default:
            // Fallback — accept the key if we don't know how to probe this provider yet
            return ok(`${provider}: key present (no live probe wired)`);
    }
}

module.exports = {
    listAll,
    getById,
    getDefault,
    create,
    update,
    remove,
    test,
    attachOAuthTokens,
    saveRefreshedTokens,
    hydrateApiKeysToEnv,
    PROVIDER_ENV_MAP,
    PROVIDER_SCHEMA,
    PROVIDER_LIST,
};
