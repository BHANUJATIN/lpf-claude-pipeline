const express = require('express');
const DatabaseService  = require('../database/DatabaseService');
const pipelineEmitter  = require('../pipeline/PipelineEmitter');
const costTracker      = require('../services/CostTrackerService');

const router = express.Router();
const db = new DatabaseService();

router.get('/health', (_req, res) => {
    let apollo = { tripped: false, tripped_at: null };
    try { apollo = require('../services/ApolloService').getBreakerStatus(); } catch (_) {}
    res.json({
        status: 'ok',
        ts: new Date().toISOString(),
        providers: {
            apollo: {
                credit_breaker: apollo,
                message: apollo.tripped
                    ? 'Apollo account is OUT OF CREDITS. People search + company enrich are disabled until the account is topped up.'
                    : 'ok',
            },
        },
    });
});

// Dedicated provider-status endpoint the dashboard polls to render banners.
router.get('/providers/status', (_req, res) => {
    let apollo = { tripped: false, tripped_at: null };
    try { apollo = require('../services/ApolloService').getBreakerStatus(); } catch (_) {}
    res.json({
        apollo: {
            credit_breaker_tripped: apollo.tripped,
            tripped_at:             apollo.tripped_at,
            message:                apollo.tripped
                ? 'Apollo: insufficient credits. Top up your Apollo account to re-enable people search.'
                : null,
        },
    });
});

// Manual reset (e.g. after topping up Apollo) so the operator doesn't need to restart the server
router.post('/providers/apollo/reset-breaker', (_req, res) => {
    try {
        require('../services/ApolloService').resetCreditBreaker();
        res.json({ ok: true, message: 'Apollo credit breaker reset — next call will hit the API again.' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /jobs/:id/sap-sheet-preview
// Returns the EXACT row that the pipeline would have written to the SAP-jobs
// Google Sheet — useful for verifying end-to-end data readiness even before a
// google_sheet/sap_jobs_write connection has been wired up. Mirrors the
// `record` object built in Pipeline._writeSapJobToSheet so what you see here
// is what gets appended once OAuth is configured.
router.get('/jobs/:id/sap-sheet-preview', async (req, res) => {
    try {
        const job = await db.getJobById(parseInt(req.params.id));
        if (!job) return res.status(404).json({ ok: false, error: 'job not found' });

        const record = {
            // Always present
            job_id:                 String(job.id),
            job_url:                job.job_url || '',
            job_title:              job.job_title || '',
            company_name:           job.company_name || '',
            country:                job.country || '',
            source:                 job.source || '',
            received_at:            job.received_at ? new Date(job.received_at).toISOString() : '',
            written_at:             new Date().toISOString(),
            // Stage 1
            seniority:              job.seniority || '',
            quality_score:          job.quality_score != null ? String(job.quality_score) : '',
            ctr_fit:                job.ctr_fit || '',
            // Stage 3
            sap_modules:            job.sap_modules || '',
            top_job_tech_comma:     job.top_job_tech_comma || '',
            tech_longer:            job.tech_longer || '',
            dev_or_eng:             job.dev_or_eng || '',
            imagined_city:          job.imagined_city || '',
            imagined_industry:      job.imagined_industry || '',
            // Optional / conditional
            company_url:            job.company_url || '',
            company_linkedin_url:   job.company_linkedin_url || '',
            company_domain:         job.company_domain || '',
            city:                   job.city || '',
            company_hq_city:        job.company_hq_city || '',
            company_employee_count: job.company_employee_count != null ? String(job.company_employee_count) : '',
            imagined_nearby_city:   job.imagined_nearby_city || '',
            job_poster_name:        job.job_poster_name || '',
            job_poster_email:       job.job_poster_email || '',
            job_poster_linkedin:    job.job_poster_linkedin || '',
            cv_pdf_url_english:     job.cv_pdf_url_english || '',
            cv_pdf_url_german:      job.cv_pdf_url_german  || '',
            cv_eligible:            job.cv_eligible == null ? '' : (job.cv_eligible ? 'TRUE' : 'FALSE'),
        };

        let conn = null;
        let connReady = false;
        try {
            const Connections = require('../services/ConnectionService');
            conn = await Connections.getDefault('google_sheet', 'sap_jobs_write');
            connReady = !!(conn && conn.config?.oauth?.refresh_token);
        } catch (_) {}

        const blank  = Object.entries(record).filter(([, v]) => v === '' || v == null).map(([k]) => k);
        const filled = Object.entries(record).filter(([, v]) => v !== '' && v != null).map(([k]) => k);

        res.json({
            ok:           true,
            job_id:       job.id,
            connection: {
                configured:  !!conn,
                oauth_ready: connReady,
                name:        conn?.name || null,
                spreadsheet_id: conn?.config?.spreadsheet_id || null,
                hint: connReady ? null
                    : 'No google_sheet/sap_jobs_write connection with OAuth tokens exists yet. Either (a) configure one via the Connections tab, or (b) deploy an Apps Script and POST a spreadsheet_id to /providers/sap-sheet/register.',
            },
            row_to_write: record,
            summary: {
                total_fields:  Object.keys(record).length,
                filled_count:  filled.length,
                blank_count:   blank.length,
                blank_fields:  blank,
            },
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Retention / cooldown — 30-day people purge + company stale-cache check
// ─────────────────────────────────────────────────────────────────────────────

router.get('/admin/retention/status', async (_req, res) => {
    try {
        const Retention = require('../services/RetentionService');
        res.json(await Retention.previewCounts());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/retention/run', async (req, res) => {
    try {
        const Retention = require('../services/RetentionService');
        const dryRun = req.query.dry === 'true';
        res.json(await Retention.runCleanup({ dryRun }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/resume-inflight
// Triggers the same boot-resume hook that runs at server startup. Useful when
// you've manually unblocked a job + want it picked back up without restarting.
router.post('/admin/resume-inflight', async (_req, res) => {
    try {
        const r = await require('../pipeline/BootResume').resumeInFlightJobs();
        res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/sweep-sends            — actually send stranded contacts now
// POST /admin/sweep-sends?dry=true   — preview without sending
// Scans every 'completed' job within retention window for contacts that have an
// email but were never sent to Instantly (e.g. bug-era inserts, late-stage
// adds). Re-runs Stage 8 for those jobs — idempotent thanks to
// `sent_to_instantly` + Instantly's `skip_if_in_workspace`.
router.post('/admin/sweep-sends', async (req, res) => {
    try {
        const Pipeline = require('../pipeline/Pipeline');
        const dryRun   = req.query.dry === 'true' || req.body?.dryRun === true;
        const r = await new Pipeline().sweepStrandedContacts({ dryRun });
        res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection helpers — fetch campaigns + custom variables + save mapping
// ─────────────────────────────────────────────────────────────────────────────
//
// These let the Connections UI:
//   1. Verify the API key works (existing /api/connections/:id/test endpoint)
//   2. Pull the operator's live campaign list from the provider
//   3. Pull the campaign's declared custom-variable names (Instantly)
//   4. Render an editor where the operator maps every variable / standard field
//      to either a pipeline source ("contact.first_name") or a literal value
//   5. Save the mapping into the connection row's config.field_mapping JSONB
//
// At send time, Stage 8's send-Instantly + send-HeyReach paths read
// `config.field_mapping` for the default connection of that purpose and pass
// it to the payload builder. No mapping saved → defaults are used (current
// behaviour, unchanged).

// GET /api/connections/:id/campaigns
// Returns the live list of campaigns from the provider linked to this conn.
router.get('/api/connections/:id/campaigns', async (req, res) => {
    try {
        const Connections = require('../services/ConnectionService');
        const conn = await Connections.getById(parseInt(req.params.id));
        if (!conn) return res.status(404).json({ error: 'connection not found' });

        const purpose = (conn.purpose || '').toLowerCase();
        const apiKey  = conn.config?.key;
        if (!apiKey) return res.status(412).json({ error: 'connection has no api key configured' });

        let campaigns;
        if (purpose === 'instantly') {
            const Instantly = require('../services/InstantlyService');
            campaigns = await Instantly.fetchCampaigns(apiKey);
        } else if (purpose === 'heyreach') {
            const HeyReach = require('../services/HeyReachService');
            campaigns = await HeyReach.fetchCampaigns(apiKey);
        } else {
            return res.status(400).json({ error: `purpose "${purpose}" doesn't support campaign discovery` });
        }
        res.json({ ok: true, count: campaigns.length, campaigns });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/connections/:id/custom-fields
// Returns the variable/field schema the mapping editor should render. For
// Instantly: fetched from the campaign + merged with our DEFAULTS. For
// HeyReach: the fixed lead schema (no per-campaign customisation on their side).
//
// Query: ?campaignId=… (Instantly only — uses to pull declared variables)
router.get('/api/connections/:id/custom-fields', async (req, res) => {
    try {
        const Connections = require('../services/ConnectionService');
        const conn = await Connections.getById(parseInt(req.params.id));
        if (!conn) return res.status(404).json({ error: 'connection not found' });

        const purpose = (conn.purpose || '').toLowerCase();
        const apiKey  = conn.config?.key;

        if (purpose === 'instantly') {
            const Instantly = require('../services/InstantlyService');
            const campaignId = req.query.campaignId || conn.config?.campaign_id;
            const customVariables = campaignId
                ? await Instantly.fetchCustomVariables(campaignId, apiKey).catch(() => Instantly.DEFAULT_CUSTOM_VARIABLE_KEYS)
                : Instantly.DEFAULT_CUSTOM_VARIABLE_KEYS;
            return res.json({
                ok:               true,
                provider:         'instantly',
                standard_fields:  Instantly.STANDARD_FIELDS,
                custom_variables: customVariables,
                // Pipeline sources the operator can map FROM — useful for the
                // dropdown on the right-hand side of the editor.
                pipeline_sources: Object.keys(Instantly.DEFAULT_RESOLVERS),
                // Current saved mapping (so the editor can prefill the form)
                field_mapping:    conn.config?.field_mapping || null,
            });
        }
        if (purpose === 'heyreach') {
            const HeyReach = require('../services/HeyReachService');
            const schema   = HeyReach.getLeadSchema();
            return res.json({
                ok:               true,
                provider:         'heyreach',
                standard_fields:  schema.standard,
                custom_variables: schema.customFields,
                pipeline_sources: Object.keys(HeyReach.HEYREACH_DEFAULT_RESOLVERS),
                field_mapping:    conn.config?.field_mapping || null,
            });
        }
        res.status(400).json({ error: `purpose "${purpose}" doesn't support field-mapping` });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// PUT /api/connections/:id/field-mapping
// Body: { field_mapping: { "Instantly field": "contact.first_name", ... },
//         custom_variable_keys?: ["job_url", "First Name", ...],
//         campaign_id?: "abc123" }
// Persists into config.field_mapping (+ optional campaign_id / custom_variable_keys).
router.put('/api/connections/:id/field-mapping', async (req, res) => {
    try {
        const Connections = require('../services/ConnectionService');
        const id = parseInt(req.params.id);
        const conn = await Connections.getById(id);
        if (!conn) return res.status(404).json({ error: 'connection not found' });

        const newConfig = { ...(conn.config || {}) };
        if (req.body.field_mapping !== undefined)        newConfig.field_mapping        = req.body.field_mapping;
        if (req.body.custom_variable_keys !== undefined) newConfig.custom_variable_keys = req.body.custom_variable_keys;
        if (req.body.campaign_id !== undefined)          newConfig.campaign_id          = req.body.campaign_id;

        const updated = await Connections.update(id, { config: newConfig });
        res.json({ ok: true, connection: updated });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /admin/resume-inflight/preview
// Lists jobs in non-terminal stages without triggering anything.
router.get('/admin/resume-inflight/preview', async (_req, res) => {
    try {
        const pool = require('../database/Database').getInstance().pool;
        const r = await pool.query(
            `SELECT id, stage, job_title, company_name, received_at
             FROM lpf_jobs
             WHERE stage NOT IN ('received','completed','rejected')
             ORDER BY received_at ASC`
        );
        res.json({ count: r.rowCount, jobs: r.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Payload preview — see EXACTLY what gets sent to Instantly + HeyReach
// before / instead of the actual send. The most user-trust-building visibility
// in the whole pipeline: every custom variable, every mapping, what's blank,
// what's missing.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/contacts/:contactId/instantly-preview', async (req, res) => {
    try {
        const contactId = parseInt(req.params.contactId);
        const Database  = require('../database/Database');
        const pool      = Database.getInstance().pool;
        const Instantly = require('../services/InstantlyService');

        const cr = await pool.query('SELECT * FROM lpf_contacts WHERE id = $1', [contactId]);
        const contact = cr.rows[0];
        if (!contact) return res.status(404).json({ error: 'contact not found' });

        const jr = await pool.query('SELECT * FROM lpf_jobs WHERE id = $1', [contact.job_id]);
        const job = jr.rows[0];
        if (!job) return res.status(404).json({ error: 'job not found' });

        const payload    = Instantly.buildInstantlyPayload(process.env.INSTANTLY_CAMPAIGN_ID, contact, job);
        const validation = Instantly.validatePayload(contact, job);

        // Audit: which custom variables are blank? Owner needs to know what would
        // render as empty in the email.
        const cv = payload.custom_variables || {};
        const blank  = Object.entries(cv).filter(([, v]) => v == null || v === '').map(([k]) => k);
        const filled = Object.entries(cv).filter(([, v]) => v != null && v !== '').map(([k]) => k);

        res.json({
            ok: true,
            contact: {
                id: contact.id, name: contact.full_name, email: contact.email,
                title: contact.title, linkedin_url: contact.linkedin_url,
            },
            job: { id: job.id, title: job.job_title, company: job.company_name },
            payload,                                  // exactly what we'd POST to Instantly
            validation,                               // { valid, missing: [field, …] }
            custom_variable_audit: {
                total:  Object.keys(cv).length,
                filled: filled.length,
                blank:  blank.length,
                blank_keys: blank,
            },
            api_endpoint: 'POST https://api.instantly.ai/api/v2/leads',
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/contacts/:contactId/heyreach-preview', async (req, res) => {
    try {
        const contactId = parseInt(req.params.contactId);
        const Database  = require('../database/Database');
        const pool      = Database.getInstance().pool;

        const cr = await pool.query('SELECT * FROM lpf_contacts WHERE id = $1', [contactId]);
        const contact = cr.rows[0];
        if (!contact) return res.status(404).json({ error: 'contact not found' });

        const liUrl = contact.person_linkedin_url || contact.linkedin_url_merged
                   || contact.li_merged          || contact.linkedin_url || null;

        const route = contact.heyreach_route || 'free_inmail';
        const lead = {
            firstName:          contact.first_name  || '',
            lastName:           contact.last_name   || '',
            email:              contact.email       || '',
            linkedInUrl:        liUrl               || '',
            companyName:        contact.company_name || '',
            position:           contact.title        || '',
            connectionRequest:  contact.connection_req || '',
            inMailMessage:      contact.inmail_body_de || '',
            customFields: [
                { key: 'job_url',       value: contact.job_url || '' },
                { key: 'salutation',    value: contact.salutation || '' },
                { key: 'created',       value: contact.created_at ? String(contact.created_at) : '' },
            ],
        };

        // Gates the pipeline applies before send
        const blockers = [];
        if (!liUrl)                       blockers.push('no LinkedIn URL');
        if (!contact.connection_req)      blockers.push('no connection_req generated');
        if (!contact.inmail_body_de && route !== 'connect_only') blockers.push('no inmail_body_de generated');
        if (contact.heyreach_dach_check !== 'yes') blockers.push(`DACH check = "${contact.heyreach_dach_check || 'not run'}" (must be "yes")`);
        if (contact.sent_to_heyreach)     blockers.push('already sent');

        // Char-count for connection request (HeyReach hard-caps at 300)
        const connReqLen = (contact.connection_req || '').length;

        res.json({
            ok: true,
            contact: {
                id: contact.id, name: contact.full_name, email: contact.email,
                title: contact.title, linkedin_url: liUrl,
            },
            route,                                    // free_inmail | conreq_plus_inmail | connect_only
            payload: {
                campaignId: process.env[`HEYREACH_CAMPAIGN_${route.toUpperCase()}`] || process.env.HEYREACH_CAMPAIGN_ID || null,
                leads:      [lead],
            },
            content_lengths: {
                connection_req:  connReqLen,
                connection_req_limit: 300,
                connection_req_over_limit: connReqLen > 299,
                inmail_body_de_chars: (contact.inmail_body_de || '').length,
            },
            blockers,                                 // ordered list of reasons we *won't* send
            api_endpoint: 'POST https://api.heyreach.io/api/public/campaign/AddLeadsToCampaign',
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /providers/sap-sheet/configure-apps-script
// Body: { url }
// Persists the SAP Sheets Apps Script URL into the running process env so the
// next pipeline run uses it. (Persists to .env too if .env is writable.)
// The Apps Script-based writer is the no-OAuth fallback — see
// docs/sap-sheet-apps-script.md for the deployment steps.
router.post('/providers/sap-sheet/configure-apps-script', async (req, res) => {
    try {
        const url = (req.body?.url || '').trim();
        if (!url || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
            return res.status(400).json({
                ok: false,
                error: 'Expected a Google Apps Script Web App URL like https://script.google.com/macros/s/<id>/exec',
            });
        }
        process.env.SAP_SHEET_APPS_SCRIPT_URL = url;

        // Best-effort .env append so the URL survives restarts. Silent on failure.
        try {
            const fs   = require('fs');
            const path = require('path');
            const envPath = path.resolve(process.cwd(), '.env');
            let env = '';
            try { env = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
            if (/^SAP_SHEET_APPS_SCRIPT_URL=/m.test(env)) {
                env = env.replace(/^SAP_SHEET_APPS_SCRIPT_URL=.*$/m, `SAP_SHEET_APPS_SCRIPT_URL=${url}`);
            } else {
                env = (env.length && !env.endsWith('\n') ? env + '\n' : env) + `SAP_SHEET_APPS_SCRIPT_URL=${url}\n`;
            }
            fs.writeFileSync(envPath, env);
        } catch (_) { /* not fatal */ }

        res.json({ ok: true, url, note: 'Saved to process env (and .env if writable). Next pipeline run will use it.' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /providers/sap-sheet/test-write
// Smoke-test the Apps Script writer by appending a synthetic row.
router.post('/providers/sap-sheet/test-write', async (_req, res) => {
    try {
        const SapSheetWriter = require('../services/SapSheetWriterService');
        if (!SapSheetWriter.isConfigured()) {
            return res.status(412).json({
                ok: false,
                error: 'SAP_SHEET_APPS_SCRIPT_URL not configured. POST the URL to /providers/sap-sheet/configure-apps-script first.',
            });
        }
        const result = await SapSheetWriter.appendJobRow({
            job_id:      `test-${Date.now()}`,
            job_title:   '[SMOKE TEST] from LPF-Claude',
            company_name: 'LPF Smoke Test',
            country:     'Germany',
            source:      'sap-sheet-smoke-test',
            written_at:  new Date().toISOString(),
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /providers/sap-sheet/status — quick read of which writer paths are available
router.get('/providers/sap-sheet/status', async (_req, res) => {
    try {
        const SapSheetWriter = require('../services/SapSheetWriterService');
        const Connections    = require('../services/ConnectionService');
        const conn = await Connections.getDefault('google_sheet', 'sap_jobs_write').catch(() => null);
        res.json({
            apps_script: {
                configured: SapSheetWriter.isConfigured(),
                url_set:    !!process.env.SAP_SHEET_APPS_SCRIPT_URL,
            },
            native_oauth: {
                configured: !!conn,
                name:       conn?.name || null,
                has_oauth:  !!(conn?.config?.oauth?.refresh_token),
            },
            usable: SapSheetWriter.isConfigured() || !!(conn?.config?.oauth?.refresh_token),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /providers/sap-sheet/register
// Body: { spreadsheet_id, sheet_name?, oauth_from_conn_id?, column_mapping? }
// Quick programmatic way to register a google_sheet/sap_jobs_write connection
// when the operator already has a sheet ID. If oauth_from_conn_id is supplied
// AND that connection has OAuth tokens, they're cloned onto the new connection.
router.post('/providers/sap-sheet/register', async (req, res) => {
    try {
        const { spreadsheet_id, sheet_name = 'Sheet1', oauth_from_conn_id, column_mapping } = req.body || {};
        if (!spreadsheet_id) return res.status(400).json({ ok: false, error: 'spreadsheet_id required' });

        const Connections = require('../services/ConnectionService');
        const Database    = require('../database/Database');
        const pool        = Database.getInstance().pool;

        let oauth = null;
        if (oauth_from_conn_id) {
            const r = await pool.query('SELECT config FROM lpf_connections WHERE id = $1', [parseInt(oauth_from_conn_id)]);
            oauth = r.rows[0]?.config?.oauth || null;
            if (!oauth?.refresh_token) {
                return res.status(412).json({ ok: false, error: `Connection ${oauth_from_conn_id} has no OAuth tokens to clone` });
            }
        }

        // Identity mapping — sheet header names == logical field names. The
        // operator can rename later via the Connections UI's column-mapping editor.
        const defaultMapping = {
            job_id:'job_id', job_url:'job_url', job_title:'job_title', company_name:'company_name',
            country:'country', source:'source', received_at:'received_at', written_at:'written_at',
            seniority:'seniority', quality_score:'quality_score', ctr_fit:'ctr_fit',
            sap_modules:'sap_modules', top_job_tech_comma:'top_job_tech_comma', tech_longer:'tech_longer',
            dev_or_eng:'dev_or_eng', imagined_city:'imagined_city', imagined_industry:'imagined_industry',
            company_url:'company_url', company_linkedin_url:'company_linkedin_url',
            company_domain:'company_domain', city:'city', company_hq_city:'company_hq_city',
            company_employee_count:'company_employee_count', imagined_nearby_city:'imagined_nearby_city',
            job_poster_name:'job_poster_name', job_poster_email:'job_poster_email',
            job_poster_linkedin:'job_poster_linkedin', cv_pdf_url_english:'cv_pdf_url_english',
            cv_pdf_url_german:'cv_pdf_url_german', cv_eligible:'cv_eligible',
        };

        const created = await Connections.create({
            type:     'google_sheet',
            purpose:  'sap_jobs_write',
            name:     `SAP jobs write (sheet ${spreadsheet_id.slice(0, 8)}…)`,
            is_default: true,
            config: {
                spreadsheet_id,
                sheet_name,
                header_row: 1,
                column_mapping: column_mapping || defaultMapping,
                ...(oauth ? { oauth } : {}),
            },
        });

        res.json({ ok: true, connection_id: created.id, has_oauth: !!oauth, name: created.name });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Smoke-test endpoint — confirms the credit-free /v1/contacts/search harvest path
// is wired and reachable. Useful for verifying after deploy without running the pipeline.
//   curl -s -X POST http://localhost:3000/providers/apollo/test-harvest \
//        -H "Content-Type: application/json" \
//        -d '{"companyName":"SAP","perPage":3}'
router.post('/providers/apollo/test-harvest', async (req, res) => {
    try {
        const Apollo = require('../services/ApolloService');
        const { companyName, domain, perPage = 3, personTitles, personLocations } = req.body || {};
        if (!companyName && !domain) {
            return res.status(400).json({ ok: false, error: 'companyName or domain required' });
        }
        const t0   = Date.now();
        const rows = await Apollo.harvestContacts({
            companyName,
            domain,
            personTitles:    personTitles    || ['CTO', 'Head of IT', 'Engineering Manager'],
            personLocations: personLocations || ['Germany', 'Austria', 'Switzerland'],
            perPage,
        });
        res.json({
            ok:           true,
            endpoint:     '/v1/contacts/search',
            credit_free:  true,
            duration_ms:  Date.now() - t0,
            breaker:      Apollo.getBreakerStatus(),
            harvested:    rows.length,
            sample:       rows.slice(0, 5).map(c => ({
                name:    c.name,
                title:   c.title,
                email:   c.email,
                status:  c.email_status,
                country: c.country,
                org:     c.organization_name,
            })),
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message, status: err.status, body: err.providerBody });
    }
});

router.get('/status', async (_req, res) => {
    try {
        const [jobs, contacts] = await Promise.all([
            db.countJobs(),
            db.countContacts(),
        ]);
        res.json({ status: 'ok', jobs, contacts });
    } catch (err) {
        res.status(503).json({ status: 'db_error', error: err.message, jobs: {}, contacts: {} });
    }
});

router.get('/jobs', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const jobs = await db.getRecentJobs(parseInt(limit));
        res.json({ count: jobs.length, jobs });
    } catch (err) { res.status(503).json({ error: err.message, jobs: [] }); }
});

// These MUST be before /jobs/:id so Express doesn't match the literal path as an id
router.get('/jobs/all', async (req, res) => {
    try {
        const { limit = 500 } = req.query;
        const jobs = await db.db.queryAll(
            `SELECT * FROM lpf_jobs ORDER BY received_at DESC LIMIT $1`,
            [parseInt(limit)]
        );
        res.json({ count: jobs.length, jobs });
    } catch (err) {
        res.status(503).json({ error: err.message, jobs: [] });
    }
});

router.get('/jobs/unprocessed', async (req, res) => {
    try {
        const { limit = 50, maxAge } = req.query;
        let sinceDate = null;
        if (maxAge) {
            const units = { d: 86400000, w: 604800000, m: 2592000000 };
            const match = String(maxAge).match(/^(\d+)([dwm])$/);
            if (match) sinceDate = new Date(Date.now() - parseInt(match[1]) * units[match[2]]);
        }
        const jobs = await db.getUnprocessedJobs(
            limit === 'all' ? 9999 : parseInt(limit),
            sinceDate
        );
        res.json({ count: jobs.length, jobs });
    } catch (err) { res.status(503).json({ error: err.message, jobs: [] }); }
});

router.get('/jobs/processed', async (req, res) => {
    try {
        const { limit = 2000, stage } = req.query;
        const validStages = ['review', 'completed', 'rejected'];
        const stageFilter = validStages.includes(stage) ? stage : null;
        const jobs = await db.getProcessedJobs(parseInt(limit), stageFilter);
        res.json({ count: jobs.length, jobs });
    } catch (err) { res.status(503).json({ error: err.message, jobs: [] }); }
});

router.get('/jobs/:id', async (req, res) => {
    try {
        const job = await db.getJobById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Not found' });
        const contacts   = await db.getContactsForJob(job.id);
        const stageLogs  = await db.getStageLogs(job.id);
        res.json({ job, contacts, stage_logs: stageLogs });
    } catch (err) { res.status(503).json({ error: err.message }); }
});

router.get('/logs', async (req, res) => {
    const { limit = 100, level, module, offset = 0 } = req.query;
    const logs = await db.getLogs({ limit: parseInt(limit), level, module, offset: parseInt(offset) });
    res.json({ count: logs.length, logs });
});

// GET /pipeline/events — Server-Sent Events stream for real-time pipeline visibility
router.get('/pipeline/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial ping so client knows it's connected
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);

    const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch (_) {}
    }, 15000);

    const handler = (evt) => {
        try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch (_) {}
    };

    pipelineEmitter.on('event', handler);

    req.on('close', () => {
        clearInterval(heartbeat);
        pipelineEmitter.off('event', handler);
    });
});

// POST /pipeline/stop — request graceful stop
router.post('/pipeline/stop', (req, res) => {
    const ctrl = require('../pipeline/PipelineController');
    ctrl.stop();
    pipelineEmitter.emit('event', { type: 'pipeline_stopping', ts: Date.now() });
    res.json({ ok: true, message: 'Stop requested' });
});

// POST /pipeline/run-batch — process a specific list of job IDs concurrently
router.post('/pipeline/run-batch', async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });

    const jobIds = ids.map(Number).filter(n => !isNaN(n));
    if (!jobIds.length) return res.status(400).json({ error: 'No valid IDs' });

    res.json({ ok: true, message: `Processing ${jobIds.length} selected job${jobIds.length > 1 ? 's' : ''}…` });

    Promise.all(jobIds.map(id => db.getJobById(id)))
        .then(jobs => jobs.filter(Boolean))
        .then(jobs => {
            const Pipeline = require('../pipeline/Pipeline');
            return new Pipeline().runJobs(jobs);
        })
        .catch(err => {
            const Logger = require('../Logger');
            new Logger('PipelineAPI').error('Batch run error', { error: err.message });
        });
});

// POST /pipeline/run — trigger pipeline run for ALL pending jobs
// Body (optional): { autoApprove: true } → skip review and auto-send to Instantly
router.post('/pipeline/run', async (req, res) => {
    const autoApprove = req.body?.autoApprove === true;
    res.json({ ok: true, message: autoApprove ? 'Pipeline starting — auto-approve mode' : 'Pipeline starting — processing all pending jobs' });
    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline().run(9999, { autoApprove }).catch(err => {
        const Logger = require('../Logger');
        new Logger('PipelineAPI').error('Pipeline run error', { error: err.message });
    });
});

// POST /pipeline/run/:jobId — process a single specific job
router.post('/pipeline/run/:jobId', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const job = await db.getJobById(jobId).catch(() => null);
    if (!job) return res.status(404).json({ error: `Job ${jobId} not found` });

    res.json({ ok: true, message: `Processing job ${jobId}: ${job.job_title}` });

    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline().runJobs([job]).catch(err => {
        const Logger = require('../Logger');
        new Logger('PipelineAPI').error('Single job error', { job_id: jobId, error: err.message });
    });
});

// ── Review endpoints ──────────────────────────────────────────────────────────

// GET /review — jobs waiting for manual send approval
router.get('/review', async (_req, res) => {
    const jobs = await db.getJobsForReview(100);
    res.json({ count: jobs.length, jobs });
});

// PATCH /contacts/:id — update send_decision / send_destination / send_campaign_id
router.patch('/contacts/:id', async (req, res) => {
    try {
        await db.updateContact(parseInt(req.params.id), req.body);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /review/:jobId/approve-all — approve all pending contacts to a destination
router.post('/review/:jobId/approve-all', async (req, res) => {
    const { destination = 'instantly', campaign_id = null } = req.body;
    try {
        await db.approveAllContacts(parseInt(req.params.jobId), destination, campaign_id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /review/:jobId/send — trigger Stage 8 for approved contacts
router.post('/review/:jobId/send', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    res.json({ ok: true, message: `Sending job ${jobId}…` });

    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline().sendJob(jobId).catch(err => {
        const Logger = require('../Logger');
        new Logger('ReviewAPI').error('Send failed', { job_id: jobId, error: err.message });
    });
});

// DELETE /jobs/:id — remove job and all related data
router.delete('/jobs/:id', async (req, res) => {
    try {
        const jobId = parseInt(req.params.id);
        await db.db.query('DELETE FROM lpf_sends          WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_contacts       WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_pipeline_log   WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_cell_state     WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_cell_runs      WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_api_costs      WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_jobs           WHERE id     = $1', [jobId]);
        res.json({ ok: true, message: `Job ${jobId} deleted` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /jobs/:id/comment — save rejection comment
router.patch('/jobs/:id/comment', async (req, res) => {
    try {
        await db.updateJobComment(parseInt(req.params.id), req.body.comment);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /jobs/:id/reprocess — reset a rejected job back to received
router.post('/jobs/:id/reprocess', async (req, res) => {
    try {
        const jobId = parseInt(req.params.id);
        await db.db.query('DELETE FROM lpf_pipeline_log WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_contacts WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_cell_state WHERE job_id = $1', [jobId]);
        await db.db.query('DELETE FROM lpf_cell_runs WHERE job_id = $1', [jobId]);
        await db.reprocessJob(jobId);
        res.json({ ok: true, message: `Job ${jobId} reset to received` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /contacts — all contacts with LinkedIn URLs (paginated)
router.get('/contacts', async (req, res) => {
    try {
        const { limit = 200, offset = 0, job_id, job_stage } = req.query;
        const validStages = ['review', 'completed', 'rejected'];
        const contacts = await db.getAllContacts({
            limit:    parseInt(limit),
            offset:   parseInt(offset),
            jobId:    job_id ? parseInt(job_id) : null,
            jobStage: validStages.includes(job_stage) ? job_stage : null,
        });
        res.json({ count: contacts.length, contacts });
    } catch (err) { res.status(503).json({ error: err.message, contacts: [] }); }
});

// GET /companies — distinct companies from jobs
router.get('/companies', async (req, res) => {
    try {
        const { limit = 200, offset = 0 } = req.query;
        const companies = await db.getAllCompanies({ limit: parseInt(limit), offset: parseInt(offset) });
        res.json({ count: companies.length, companies });
    } catch (err) { res.status(503).json({ error: err.message, companies: [] }); }
});

// POST /test/job — inject a test job directly into the pipeline
router.post('/test/job', async (req, res) => {
    const body = req.body;

    if (!body.job_title && !body.job_url) {
        return res.status(400).json({ error: 'job_title or job_url is required' });
    }

    try {
        const inserted = await db.upsertJob({
            job_url:              body.job_url              || `test://manual/${Date.now()}`,
            job_title:            body.job_title            || 'Test Job',
            job_description:      body.job_description      || '',
            city:                 body.city                 || null,
            country:              body.country              || null,
            company_url:          body.company_url          || null,
            company_linkedin_url: body.company_linkedin_url || null,
            company_name:         body.company_name         || null,
            job_poster_url:       body.job_poster_url       || null,
            source:               body.source               || 'manual_test',
            applicant_count:      body.applicant_count      || null,
            search_term:          body.search_term          || null,
        });

        const runNow = body.run_pipeline === true || body.run_pipeline === 'true';
        if (runNow) {
            const Pipeline = require('../pipeline/Pipeline');
            new Pipeline().run(1).catch(() => {});
        }

        res.json({
            ok:      true,
            job_id:  inserted?.id || null,
            message: `Test job inserted${runNow ? ' — pipeline triggered' : ''}`,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/costs — aggregate API cost totals for the cost bar
router.get('/api/costs', async (_req, res) => {
    try {
        const totals = await costTracker.getTotals();
        res.json(totals);
    } catch (err) {
        res.status(503).json({ error: err.message });
    }
});

// GET /api/job-costs — per-job cost summary (all jobs, grouped)
router.get('/api/job-costs', async (_req, res) => {
    try {
        const pool = require('../database/Database').getInstance().pool;
        const result = await pool.query(`
            SELECT job_id,
                   SUM(input_tokens)  AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd::numeric ELSE 0 END) AS cost_usd
            FROM lpf_api_costs
            WHERE job_id IS NOT NULL
            GROUP BY job_id
        `);
        res.json({ costs: result.rows });
    } catch (err) {
        res.status(503).json({ error: err.message, costs: [] });
    }
});

// GET /jobs/:id/costs — per-job API cost breakdown
router.get('/jobs/:id/costs', async (req, res) => {
    try {
        const costs = await costTracker.getJobCosts(parseInt(req.params.id));
        res.json({ costs });
    } catch (err) {
        res.status(503).json({ error: err.message, costs: [] });
    }
});

// ── Per-prompt GPT cost ──────────────────────────────────────────────────────

/**
 * GET /api/ai-costs?jobId=X&operation=Y
 * Returns every recorded OpenAI call (one row per prompt run) with the
 * provider-reported token count + USD cost. Powers the AI Detail panel and
 * any per-stage cost bubble in the dashboard.
 */
router.get('/api/ai-costs', async (req, res) => {
    try {
        const { jobId, operation, limit = 50 } = req.query;
        const conds  = [`service = 'openai'`];
        const params = [];
        if (jobId)     { params.push(parseInt(jobId)); conds.push(`job_id = $${params.length}`); }
        if (operation) { params.push(operation);       conds.push(`operation = $${params.length}`); }
        params.push(parseInt(limit));
        const pool = require('../database/Database').getInstance().pool;
        const r = await pool.query(
            `SELECT id, job_id, operation, model, input_tokens, output_tokens,
                    cost_usd, metadata, created_at
             FROM lpf_api_costs
             WHERE ${conds.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT $${params.length}`,
            params
        );
        const total = r.rows.reduce((acc, row) => {
            acc.usd    += parseFloat(row.cost_usd || 0);
            acc.input  += parseInt(row.input_tokens  || 0);
            acc.output += parseInt(row.output_tokens || 0);
            return acc;
        }, { usd: 0, input: 0, output: 0 });
        res.json({ count: r.rows.length, total, costs: r.rows });
    } catch (err) {
        res.status(503).json({ error: err.message, costs: [] });
    }
});

// ── Connections (API keys + Google Sheets + Google Drive) ────────────────────

const Connections = require('../services/ConnectionService');

/** GET /api/connections — list every connection (config redacted) */
router.get('/api/connections', async (_req, res) => {
    try {
        const rows = await Connections.listAll();
        res.json({ count: rows.length, connections: rows });
    } catch (err) {
        res.status(503).json({ error: err.message, connections: [] });
    }
});

/** GET /api/connections/provider-schema — per-provider field shape for the UI */
router.get('/api/connections/provider-schema', (_req, res) => {
    res.json({ providers: Connections.PROVIDER_SCHEMA });
});

/** POST /api/connections — create. Body: { type, purpose, name, config, is_default } */
router.post('/api/connections', async (req, res) => {
    try {
        const row = await Connections.create(req.body || {});
        // Push new api_key into process.env immediately so existing services see it without a restart
        if (row.type === 'api_key' && row.is_default) await Connections.hydrateApiKeysToEnv().catch(() => {});
        res.json({ ok: true, connection: row });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** PATCH /api/connections/:id — partial update */
router.patch('/api/connections/:id', async (req, res) => {
    try {
        const row = await Connections.update(parseInt(req.params.id), req.body || {});
        if (row.type === 'api_key') await Connections.hydrateApiKeysToEnv().catch(() => {});
        res.json({ ok: true, connection: row });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** DELETE /api/connections/:id */
router.delete('/api/connections/:id', async (req, res) => {
    try {
        await Connections.remove(parseInt(req.params.id));
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** POST /api/connections/:id/test — ping the connection, persist the result */
router.post('/api/connections/:id/test', async (req, res) => {
    try {
        const result = await Connections.test(parseInt(req.params.id));
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /api/connections/:id/ai-suggest-mapping
 * Body: { purpose, logical_fields: [{name, description, optional}], lookup_pipeline_field }
 *
 * Reads the sheet headers via the connection's auth (OAuth or service-account),
 * sends them + the logical field list to GPT-4o-mini, and returns a one-shot
 * column mapping suggestion: { mapping: {logical: header}, lookup_sheet_column, notes }.
 *
 * No mutations — the operator reviews the suggestion in the drawer and clicks Save.
 */
router.post('/api/connections/:id/ai-suggest-mapping', async (req, res) => {
    try {
        const conn = await Connections.getById(parseInt(req.params.id));
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        if (conn.type !== 'google_sheet') return res.status(400).json({ error: 'AI mapping only supported on google_sheet connections' });

        const { logical_fields = [], lookup_pipeline_field, purpose } = req.body || {};
        if (!logical_fields.length) return res.status(400).json({ error: 'logical_fields array required' });

        // Read headers via whichever auth method is wired
        let headers;
        try {
            if (conn.config?.auth_method === 'oauth' && conn.config?.oauth?.access_token) {
                headers = await Oauth.listSheetHeaders(conn, {
                    spreadsheetId: conn.config.spreadsheet_id,
                    tabName:       conn.config.sheet_name || 'Sheet1',
                    headerRow:     conn.config.header_row || 1,
                });
            } else {
                const { readSheet } = require('../services/GoogleSheetsServiceV2');
                const r = await readSheet(conn.config);
                headers = r.headers;
            }
        } catch (err) {
            return res.status(503).json({ error: `Could not read sheet headers: ${err.message}` });
        }
        if (!headers || !headers.length) {
            return res.status(400).json({ error: 'Sheet has no headers in the configured tab — add a header row first' });
        }

        const { askJSON } = require('../services/OpenAIService');
        const fieldsTable = logical_fields.map(f =>
            `  • ${f.name}${f.optional ? ' (OPTIONAL)' : ''}${f.description ? ' — ' + f.description : ''}`
        ).join('\n');

        const userPrompt = `You are mapping a pipeline's internal field names to the actual columns of a Google Sheet.

The sheet's HEADER ROW contains exactly these columns (in order, case-sensitive):
${headers.map((h, i) => `  ${i + 1}. ${JSON.stringify(h)}`).join('\n')}

The pipeline can write these logical fields (purpose=${JSON.stringify(purpose || 'unknown')}):
${fieldsTable}

Your task:
1. For EACH logical field, decide which sheet header (from the list above) is the best match. Use:
   • exact word overlap
   • semantic match (e.g. "Domain" ↔ company_domain, "Email Found" ↔ email)
   • the field's description to disambiguate
2. If no header is a confident match for a field, omit it from "mapping" (do NOT guess).
3. If a sheet header has no matching pipeline field, list it under "unmapped_headers".
4. The "lookup_sheet_column" should be the sheet header that best matches the lookup pipeline field ${JSON.stringify(lookup_pipeline_field || '(unspecified)')}. If unspecified, pick the header that looks most like a primary key.

Respond as JSON ONLY with this shape:
{
  "mapping": { "<logical_field>": "<sheet_header>", ... },
  "lookup_sheet_column": "<sheet_header or empty>",
  "unmapped_headers": ["<header>", ...],
  "notes": "<one-line summary>"
}`;

        const sys = 'You are precise at matching column names. Output ONLY valid JSON. Never invent headers that are not in the supplied list.';
        const result = await askJSON(sys, userPrompt, 'gpt-4o-mini', {
            operation: 'connection_ai_mapping',
        });

        // Sanitise — guard against the model inventing headers
        const headerSet = new Set(headers);
        const cleanMapping = {};
        for (const [k, v] of Object.entries(result?.mapping || {})) {
            if (typeof v === 'string' && headerSet.has(v)) cleanMapping[k] = v;
        }
        const cleanLookup = headerSet.has(result?.lookup_sheet_column) ? result.lookup_sheet_column : '';
        res.json({
            ok:                  true,
            mapping:             cleanMapping,
            lookup_sheet_column: cleanLookup,
            unmapped_headers:    Array.isArray(result?.unmapped_headers) ? result.unmapped_headers : [],
            notes:               result?.notes || '',
            headers,
        });
    } catch (err) {
        res.status(503).json({ error: err.message });
    }
});

/** GET /api/connections/:id/sheet-headers — preview headers for column mapping UI */
router.get('/api/connections/:id/sheet-headers', async (req, res) => {
    try {
        const conn = await Connections.getById(parseInt(req.params.id));
        if (!conn) return res.status(404).json({ error: 'Not found' });
        if (conn.type !== 'google_sheet') return res.status(400).json({ error: 'Only google_sheet supports sheet-headers' });
        const { readSheet } = require('../services/GoogleSheetsServiceV2');
        const { headers, rows } = await readSheet(conn.config);
        res.json({ headers, row_count: rows.length, sample: rows[0] || null });
    } catch (err) {
        res.status(503).json({ error: err.message, http_status: err.httpStatus, google_error: err.googleError });
    }
});

// ── Google OAuth flow ───────────────────────────────────────────────────────

const Oauth = require('../services/GoogleOAuthService');

/** GET /api/google/oauth-setup — probe whether OAuth credentials are available (env OR dashboard) */
router.get('/api/google/oauth-setup', async (req, res) => {
    try {
        const [ok, message, redirectUri] = await Promise.all([
            Oauth.setupOk(req),
            Oauth.setupErrorMessage(req),
            Oauth.getRedirectUri(req),
        ]);
        res.json({
            ok,
            message,
            redirect_uri: redirectUri,
            scopes:       Oauth.SCOPES,
            // Helpful diagnostic the setup banner can show
            request_origin: `${req.protocol}://${req.get('host')}`,
            app_public_url: process.env.APP_PUBLIC_URL || null,
        });
    } catch (err) {
        res.status(503).json({ ok: false, message: err.message });
    }
});

/**
 * GET /oauth/google/start/:connId
 * Kicks off the OAuth consent screen for an existing connection.
 * Redirects the user to Google's auth URL — they come back to /oauth/google/callback.
 */
router.get('/oauth/google/start/:connId', async (req, res) => {
    try {
        const connId = parseInt(req.params.connId);
        if (isNaN(connId)) return res.status(400).send('Invalid connId');
        if (!(await Oauth.setupOk(req))) {
            return res.status(503).send(`<pre>${await Oauth.setupErrorMessage(req)}</pre>`);
        }
        const conn = await Connections.getById(connId);
        if (!conn) return res.status(404).send('Connection not found');
        const url = await Oauth.generateAuthUrl({ connId, req });
        res.redirect(302, url);
    } catch (err) {
        res.status(500).send(`<pre>OAuth start failed: ${err.message}</pre>`);
    }
});

/**
 * GET /oauth/google/callback
 * Google sends the user back here with ?code=...&state=...
 * We exchange the code, persist tokens onto the connection, then close the
 * popup window with a postMessage so the parent UI can refresh.
 */
router.get('/oauth/google/callback', async (req, res) => {
    const { code, state, error: oauthErr, error_description: oauthErrDesc } = req.query;
    if (oauthErr) {
        const detail = oauthErrDesc ? `${oauthErr} — ${oauthErrDesc}` : oauthErr;
        return _renderOAuthClose(res, false, `Google returned error: ${detail}`, oauthErr);
    }
    if (!code || !state) return _renderOAuthClose(res, false, 'Missing code or state parameter');

    try {
        const { connId, oauth } = await Oauth.exchangeCode({ code, state, req });
        const row = await Connections.attachOAuthTokens(connId, oauth);
        _renderOAuthClose(res, true, `Connected as ${row.config?.oauth?.user_email || 'Google user'}`);
    } catch (err) {
        _renderOAuthClose(res, false, err.message);
    }
});

/**
 * Render the OAuth popup landing page. When the auth failed, recognise the
 * common Google error codes and inline the actionable fix so the operator
 * doesn't have to read Google's docs.
 */
function _renderOAuthClose(res, ok, msg, errorCode = null) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const escMsg   = String(msg).replace(/[<>]/g, c => ({'<': '&lt;', '>': '&gt;'}[c]));
    const guidance = ok ? '' : _oauthErrorGuidance(errorCode, msg);

    // Don't auto-close on errors — the user needs time to read the fix.
    const autoClose = ok ? 1800 : 0;

    res.send(`<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:28px;background:#0f1117;color:#e8eaed;max-width:640px;margin:0 auto;line-height:1.5">
      <h2 style="margin:0 0 12px;color:${ok ? '#10b981' : '#ef4444'};text-align:center">${ok ? '✓ Connected' : '✗ Connection failed'}</h2>
      <p style="color:#9aa0a6;font-size:13px;margin:8px 0;text-align:center">${escMsg}</p>
      ${guidance}
      <p style="color:#6c7280;font-size:11px;margin-top:24px;text-align:center">
        ${ok ? 'This window will close automatically.' : '<button onclick="window.close()" style="background:#1f2937;border:1px solid #374151;color:#e8eaed;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px">Close window</button>'}
      </p>
      <script>
        try { window.opener && window.opener.postMessage({ type: 'google-oauth', ok: ${ok}, msg: ${JSON.stringify(msg)}, errorCode: ${JSON.stringify(errorCode || null)} }, '*'); } catch(_) {}
        ${autoClose ? `setTimeout(() => { try { window.close(); } catch(_) {} }, ${autoClose});` : ''}
      </script>
    </body></html>`);
}

/**
 * Map Google's standard OAuth error codes (and our most-seen exchange errors)
 * to a labelled "what this means / how to fix" block.
 *
 *   • access_denied        → app in Testing mode + tester not whitelisted, OR user cancelled
 *   • redirect_uri_mismatch → registered URI in GCP doesn't match the one we sent
 *   • invalid_client       → wrong client_id/secret pair
 *   • admin_policy_enforced → Workspace admin blocked third-party access
 *   • org_internal         → user signed in with an account outside the GCP org
 *   • disallowed_useragent → embedded webview blocked (use a real browser)
 */
function _oauthErrorGuidance(errorCode, msg) {
    const wrap = (title, body) => `
      <div style="margin:16px 0;padding:14px 16px;background:#1f2937;border:1px solid #374151;border-radius:6px">
        <div style="font-size:13px;font-weight:600;color:#fbbf24;margin-bottom:8px">${title}</div>
        <div style="font-size:12px;color:#cbd5e1">${body}</div>
      </div>
    `;

    const lowerMsg = String(msg || '').toLowerCase();

    if (errorCode === 'access_denied' || lowerMsg.includes('access_denied') || lowerMsg.includes('has not completed') || lowerMsg.includes('developer-approved testers')) {
        return wrap('Your account is not a registered test user', `
          The OAuth app is in <b>Testing</b> publishing status, which means only emails on the test-users list can sign in. Two ways to fix:
          <ol style="padding-left:18px;margin:8px 0 6px;line-height:1.7">
            <li><b>Add yourself as a test user (30 seconds):</b><br>
              Go to <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" style="color:#7dd3fc">console.cloud.google.com/apis/credentials/consent</a> → scroll to <b>Test users</b> → <b>+ ADD USERS</b> → paste your Google email → Save.<br>
              Then close this window and click "↗ Connect Google account" again.
            </li>
            <li><b>Publish the app to production (no verification needed for personal use):</b><br>
              On the same page, click <b>PUBLISH APP</b> → confirm. Verification is only required when you exceed 100 unique users; for internal/recruiter use this is fine to leave unverified.
            </li>
          </ol>
          <div style="font-size:11px;color:#9aa0a6;margin-top:8px">
            If you clicked "Cancel" on Google's consent screen, that also lands here as <code>access_denied</code> — just retry.
          </div>
        `);
    }

    if (errorCode === 'redirect_uri_mismatch' || lowerMsg.includes('redirect_uri_mismatch')) {
        return wrap('Redirect URI not registered in your GCP OAuth client', `
          Google requires the redirect URI to match exactly what's listed under your OAuth client's <b>Authorized redirect URIs</b>.
          <ol style="padding-left:18px;margin:8px 0 6px;line-height:1.7">
            <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#7dd3fc">console.cloud.google.com/apis/credentials</a>.</li>
            <li>Click your Web OAuth client.</li>
            <li>Under <b>Authorized redirect URIs</b>, add the exact URL the dashboard is using (visible in the Connections setup card). No trailing slash; <code>http</code> vs <code>https</code> matters.</li>
            <li>Save → retry the Connect button.</li>
          </ol>
        `);
    }

    if (errorCode === 'invalid_client' || lowerMsg.includes('invalid_client')) {
        return wrap('Client ID or Client Secret is wrong', `
          Open Connections → edit the <code>google_oauth_app</code> row → paste the exact values from the same OAuth client in GCP. The Client ID ends in <code>.apps.googleusercontent.com</code>; the secret starts with <code>GOCSPX-</code>.
        `);
    }

    if (errorCode === 'admin_policy_enforced' || lowerMsg.includes('admin_policy_enforced')) {
        return wrap('Your Workspace admin blocked third-party app access', `
          The Google Workspace account you signed in with has a policy that disallows this app. Ask your admin to allowlist it, or sign in with a different Google account.
        `);
    }

    if (errorCode === 'org_internal' || lowerMsg.includes('org_internal')) {
        return wrap('Account is outside the GCP org', `
          Your OAuth consent screen is set to <b>Internal</b>, which only allows accounts in the same Google Workspace organization as the GCP project. Either sign in with a Workspace account, or switch the consent screen to <b>External</b> at <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" style="color:#7dd3fc">credentials/consent</a>.
        `);
    }

    if (errorCode === 'disallowed_useragent' || lowerMsg.includes('disallowed_useragent')) {
        return wrap('Open this URL in a real browser, not an embedded webview', `
          Google blocks OAuth from embedded webviews. Open the dashboard URL directly in Chrome / Safari / Firefox.
        `);
    }

    if (lowerMsg.includes('invalid_grant')) {
        return wrap('Code already used or expired — just retry', `
          The authorization code from Google can only be exchanged once. Close this window and click Connect again.
        `);
    }

    // Generic fallback — show the raw error code if we have one
    return errorCode ? wrap('Google error: ' + errorCode, `
      No specific guidance is wired for this code yet. Check <a href="https://developers.google.com/identity/protocols/oauth2/web-server#handlingerrors" target="_blank" style="color:#7dd3fc">Google's OAuth error reference</a>, then retry.
    `) : '';
}

// ── Google resource pickers (used by the Connections drawer dropdowns) ──────

/** GET /api/google/drives?conn_id=N — list drives the connected user can see */
router.get('/api/google/drives', async (req, res) => {
    try {
        const conn = await Connections.getById(parseInt(req.query.conn_id));
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        const drives = await Oauth.listDrives(conn);
        res.json({ count: drives.length, drives });
    } catch (err) {
        res.status(503).json({ error: err.message, http_status: err.httpStatus, google_error: err.googleError });
    }
});

/** GET /api/google/files?conn_id=N&type=spreadsheet|document|presentation|folder&drive_id=&q= */
router.get('/api/google/files', async (req, res) => {
    try {
        const conn = await Connections.getById(parseInt(req.query.conn_id));
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        const files = await Oauth.listFiles(conn, {
            type:    req.query.type,
            driveId: req.query.drive_id,
            q:       req.query.q,
            pageSize: parseInt(req.query.limit || '100'),
        });
        res.json({ count: files.length, files });
    } catch (err) {
        res.status(503).json({ error: err.message, http_status: err.httpStatus, google_error: err.googleError });
    }
});

/** GET /api/google/sheet-tabs?conn_id=N&sheet_id=… */
router.get('/api/google/sheet-tabs', async (req, res) => {
    try {
        const conn = await Connections.getById(parseInt(req.query.conn_id));
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        const tabs = await Oauth.listSheetTabs(conn, req.query.sheet_id);
        res.json({ count: tabs.length, tabs });
    } catch (err) {
        res.status(503).json({ error: err.message, http_status: err.httpStatus, google_error: err.googleError });
    }
});

/** GET /api/google/sheet-headers?conn_id=N&sheet_id=…&tab=Sheet1&header_row=1 */
router.get('/api/google/sheet-headers', async (req, res) => {
    try {
        const conn = await Connections.getById(parseInt(req.query.conn_id));
        if (!conn) return res.status(404).json({ error: 'Connection not found' });
        const headers = await Oauth.listSheetHeaders(conn, {
            spreadsheetId: req.query.sheet_id,
            tabName:       req.query.tab || 'Sheet1',
            headerRow:     parseInt(req.query.header_row || '1'),
        });
        res.json({ count: headers.length, headers });
    } catch (err) {
        res.status(503).json({ error: err.message, http_status: err.httpStatus, google_error: err.googleError });
    }
});

/** POST /api/connections/:id/oauth-disconnect — clear stored tokens but keep the row */
router.post('/api/connections/:id/oauth-disconnect', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const conn = await Connections.getById(id);
        if (!conn) return res.status(404).json({ error: 'Not found' });
        const cfg = { ...(conn.config || {}) };
        delete cfg.oauth;
        const pool = require('../database/Database').getInstance().pool;
        await pool.query(
            `UPDATE lpf_connections SET config = $2::jsonb, status = 'untested', last_check_msg = 'OAuth disconnected', updated_at = NOW() WHERE id = $1`,
            [id, JSON.stringify(cfg)]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Send-detail endpoint — powers the "Sent ✅" drawer in People + HeyReach ──

/**
 * GET /api/contacts/:id/send-detail
 * Returns everything the dashboard needs to show the post-send detail drawer:
 *   • Latest lpf_sends row for Instantly (payload + response + success + error)
 *   • All historical Instantly sends for this contact (for retry audit)
 *   • HeyReach state from lpf_contacts (lead_id, response, error, sent_at)
 *
 * The UI renders the JSON pretty + colours red on error / green on success.
 */
router.get('/api/contacts/:id/send-detail', async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid contact id' });

    try {
        const contact = await db.db.queryOne(
            `SELECT id, full_name, first_name, last_name, email, title, job_id, company_name,
                    sent_to_instantly, instantly_lead_id, sent_at,
                    sent_to_heyreach, heyreach_lead_id, heyreach_sent_at,
                    heyreach_route, heyreach_error, heyreach_response,
                    heyreach_skip_reason, heyreach_dach_check
             FROM lpf_contacts WHERE id = $1`,
            [id]
        );
        if (!contact) return res.status(404).json({ error: 'Contact not found' });

        const sends = await db.db.queryAll(
            `SELECT id, campaign_id, payload, instantly_response, success, error_message, sent_at
             FROM lpf_sends WHERE contact_id = $1 ORDER BY sent_at DESC LIMIT 10`,
            [id]
        );

        const instantly = {
            sent:           !!contact.sent_to_instantly,
            lead_id:        contact.instantly_lead_id || null,
            sent_at:        contact.sent_at || null,
            attempts:       sends.length,
            latest:         sends[0] || null,
            history:        sends,
        };
        const heyreach = {
            sent:           !!contact.sent_to_heyreach,
            lead_id:        contact.heyreach_lead_id || null,
            sent_at:        contact.heyreach_sent_at || null,
            route:          contact.heyreach_route || null,
            error:          contact.heyreach_error || null,
            response:       contact.heyreach_response || null,
            skip_reason:    contact.heyreach_skip_reason || null,
            dach_check:     contact.heyreach_dach_check || null,
        };

        res.json({
            contact: {
                id:           contact.id,
                full_name:    contact.full_name,
                first_name:   contact.first_name,
                last_name:    contact.last_name,
                email:        contact.email,
                title:        contact.title,
                job_id:       contact.job_id,
                company_name: contact.company_name,
            },
            instantly,
            heyreach,
        });
    } catch (err) {
        res.status(503).json({ error: err.message });
    }
});

// ── Email-finder endpoints (Harvest + Trykitt) ────────────────────────────────

/**
 * POST /api/contacts/:id/find-email
 * Runs the email waterfall (Harvest → Trykitt → Findymail) for a single contact.
 * Useful when a contact came in without an email and you want to retry without
 * re-running the full pipeline. Returns the discovered email + the provider that
 * found it. Saves the result back to lpf_contacts.
 *
 * Body (optional): { providers: ['harvest','trykitt','findymail'] } — restricts the
 * waterfall. Defaults to all three in that order.
 */
router.post('/api/contacts/:id/find-email', async (req, res) => {
    const contactId = parseInt(req.params.id);
    if (isNaN(contactId)) return res.status(400).json({ error: 'Invalid contact ID' });

    const contact = await db.db.queryOne('SELECT * FROM lpf_contacts WHERE id = $1', [contactId]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const wantedProviders = Array.isArray(req.body?.providers) && req.body.providers.length
        ? req.body.providers
        : ['harvest', 'trykitt', 'findymail'];

    const Harvest   = require('../services/HarvestService');
    const Trykitt   = require('../services/TrykittService');
    const Findymail = require('../services/FindymailService');

    const li     = contact.linkedin_url || contact.li_merged || contact.person_linkedin_url || null;
    const first  = contact.first_name || null;
    const last   = contact.last_name  || null;

    // Resolve company domain from the job
    let domain = null;
    if (contact.job_id) {
        const job = await db.getJobById(contact.job_id);
        domain = cleanDomain(job?.company_domain || job?.company_url || null);
    }

    const tried = [];
    let email = null, provider = null;

    const tryProvider = async (name, fn) => {
        if (email || !wantedProviders.includes(name)) return;
        try {
            const result = await fn();
            tried.push({ provider: name, found: !!result });
            if (result) { email = typeof result === 'string' ? result : (result.email || null); provider = name; }
        } catch (err) {
            tried.push({ provider: name, found: false, error: err.message });
        }
    };

    // Harvest (LinkedIn URL only)
    await tryProvider('harvest', async () => {
        if (!li) return null;
        const r = await Harvest.findEmailByLinkedIn(li, { jobId: contact.job_id, operation: 'manual_find_email' });
        return r?.email || null;
    });

    // Trykitt (LinkedIn URL → name+domain)
    await tryProvider('trykitt', async () => {
        if (li) { const e = await Trykitt.findByLinkedIn(li); if (e) return e; }
        if (first && last && domain) return Trykitt.findByNameDomain(first, last, domain);
        return null;
    });

    // Findymail (LinkedIn URL → name+domain)
    await tryProvider('findymail', async () => {
        if (li) { const r = await Findymail.findEmailByLinkedIn(li); if (r?.email) return r.email; }
        if (first && last && domain) {
            const r = await Findymail.findEmail(first, last, domain);
            return r?.email || null;
        }
        return null;
    });

    // Verify if we found something (Harvest + Trykitt outputs are unverified)
    let verified = provider === 'findymail';
    if (email && !verified) {
        try {
            const v = await Findymail.verifyEmail(email);
            verified = !!v?.valid;
            if (!v) { email = null; provider = null; }   // Findymail returned undeliverable
        } catch (_) {}
    }

    if (email) {
        await db.db.query(
            `UPDATE lpf_contacts SET email = $2, email_source = $3, email_validated = $4 WHERE id = $1`,
            [contactId, email, provider, verified]
        );
    }

    res.json({
        ok: true,
        email_found: !!email,
        email,
        provider,
        verified,
        tried,
    });
});

function cleanDomain(str) {
    if (!str) return null;
    try {
        const url = str.includes('://') ? str : 'https://' + str;
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch (_) {
        return str.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '').toLowerCase() || null;
    }
}

// ── CV Generation endpoints ───────────────────────────────────────────────────

/**
 * GET /api/cvs
 * List jobs with their CV-generation status — eligibility flag, both Drive PDF
 * URLs (EN + DE), GPT cost, and timestamps. Powers the CV Generator tab.
 */
router.get('/api/cvs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '200');
        const rows = await db.db.queryAll(`
            SELECT id AS job_id, job_title, company_name, country, city,
                   company_domain, company_linkedin_url,
                   stage, received_at,
                   cv_eligible, cv_eligibility,
                   english_cv_text, cv_german_text,
                   english_cv_json, german_cv_json,
                   cv_pdf_url_english, cv_pdf_url_german,
                   cv_pdf_doc_id_english, cv_pdf_doc_id_german,
                   cv_generated_at, cv_error, cv_cost_usd, cv_cost_breakdown
            FROM lpf_jobs
            WHERE stage NOT IN ('rejected')
            ORDER BY received_at DESC
            LIMIT $1
        `, [limit]);
        res.json({ count: rows.length, jobs: rows });
    } catch (err) {
        res.status(503).json({ error: err.message, jobs: [] });
    }
});

/**
 * GET /api/cvs/:jobId
 * Full CV state for one job — structured JSON + PDF URLs + cost breakdown.
 */
router.get('/api/cvs/:jobId', async (req, res) => {
    try {
        const jobId = parseInt(req.params.jobId);
        const row = await db.db.queryOne(`
            SELECT id AS job_id, job_title, company_name, country, city,
                   company_domain, company_linkedin_url,
                   cv_eligible, cv_eligibility,
                   english_cv_text, cv_german_text,
                   english_cv_json, german_cv_json,
                   cv_pdf_url_english, cv_pdf_url_german,
                   cv_pdf_doc_id_english, cv_pdf_doc_id_german,
                   cv_generated_at, cv_error, cv_cost_usd, cv_cost_breakdown
            FROM lpf_jobs WHERE id = $1
        `, [jobId]);
        if (!row) return res.status(404).json({ error: 'Job not found' });
        res.json(row);
    } catch (err) {
        res.status(503).json({ error: err.message });
    }
});

/**
 * POST /api/cvs/:jobId/generate
 * Trigger the full CV pipeline for one job:
 *   1. Eligibility check against the Render endpoint
 *   2. (if eligible) English structured JSON via OpenAI
 *   3. German translation via OpenAI
 *   4. Two PDFs via Google Apps Script
 *
 * The work runs in the background; the response returns immediately. Poll
 * GET /api/cvs/:jobId for the result.
 */
router.post('/api/cvs/:jobId/generate', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const job = await db.getJobById(jobId).catch(() => null);
    if (!job)              return res.status(404).json({ error: 'Job not found' });
    if (!job.job_title)    return res.status(400).json({ error: 'Job has no job_title — cannot generate CV' });

    res.json({ ok: true, message: `CV pipeline started for job ${jobId} — poll /api/cvs/${jobId}` });

    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline()._runCVGeneration(jobId).catch(err => {
        const Logger = require('../Logger');
        new Logger('CVGen').error(`CV trigger failed for job ${jobId}`, { error: err.message });
    });
});

/**
 * POST /api/cvs/eligibility-check
 * Body: { domain, linkedinUrl } — proxies the external Render eligibility endpoint
 * so the dashboard can probe without needing CORS / API-key plumbing.
 */
router.post('/api/cvs/eligibility-check', async (req, res) => {
    try {
        const CV = require('../services/CVGenerationService');
        const r = await CV.checkEligibility(req.body || {});
        res.json(r);
    } catch (err) {
        res.status(503).json({ error: err.message });
    }
});

// Note: The old in-app pdfkit + Drive upload path was removed. PDFs are now
// rendered by the Google Apps Script endpoint (see CVGenerationService.renderPdf)
// which returns public Drive URLs directly. The two URLs are persisted onto the
// job row + written into the SAP jobs sheet via column mapping.

/**
 * POST /api/cvs/generate-batch
 * Body: { ids: [1,2,3] } — generates CVs for many jobs in series (rate-limit friendly).
 */
router.post('/api/cvs/generate-batch', async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const jobIds = ids.map(Number).filter(n => !isNaN(n));

    res.json({ ok: true, message: `CV generation queued for ${jobIds.length} jobs` });

    const CV = require('../services/CVGenerationService');
    const Logger = require('../Logger');
    const log = new Logger('CVGen');

    (async () => {
        for (const jobId of jobIds) {
            try {
                const job = await db.getJobById(jobId);
                if (!job?.job_title) continue;
                const result = await CV.generateAll(job);
                const errs = Object.values(result.errors).filter(Boolean);
                await db.updateJobFields(jobId, {
                    english_cv_text:    result.english_cv_text    || null,
                    english_cv_v2_text: result.english_cv_v2_text || null,
                    cv_german_text:     result.cv_german_text     || null,
                    cv_generated_at:    new Date(),
                    cv_error:           errs.length ? errs.join(' | ') : null,
                    cv_cost_usd:        result.costs.total.usd.toFixed(6),
                    cv_cost_breakdown:  result.costs,
                });
                log.info(`Batch CV done`, { job_id: jobId, cost_usd: result.costs.total.usd.toFixed(4) });
            } catch (err) {
                log.warn(`Batch CV failed for job ${jobId}`, { error: err.message });
            }
        }
    })();
});

/**
 * GET /api/cvs/:jobId/pdf?variant=english|german
 * Redirect to the externally-rendered Drive PDF URL. The in-app PDF renderer was
 * replaced by the Google Apps Script renderer — the URL is already on the row.
 */
router.get('/api/cvs/:jobId/pdf', async (req, res) => {
    const jobId   = parseInt(req.params.jobId);
    const variant = (req.query.variant || 'english').toLowerCase();
    if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const row = await db.db.queryOne(
        `SELECT cv_pdf_url_english, cv_pdf_url_german FROM lpf_jobs WHERE id = $1`,
        [jobId]
    ).catch(() => null);
    if (!row) return res.status(404).json({ error: 'Job not found' });

    const url = variant === 'german' ? row.cv_pdf_url_german : row.cv_pdf_url_english;
    if (!url) return res.status(404).json({ error: `No ${variant} PDF generated yet — trigger /api/cvs/${jobId}/generate first` });
    res.redirect(302, url);
});

// ── Job Poster endpoint ───────────────────────────────────────────────────────

/**
 * GET /api/job-posters
 * Returns all jobs that have extracted poster info (from Stage 6),
 * with poster contact data joined in. Powers the Job Poster sub-tab.
 */
router.get('/api/job-posters', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '300');
        const posters = await db.getJobPosters({ limit });
        res.json({ count: posters.length, posters });
    } catch (err) {
        res.status(503).json({ error: err.message, posters: [] });
    }
});

/**
 * POST /api/heyreach/send/:jobId
 * Manually trigger the HeyReach send step for a single job. Same DACH-only
 * gate as the auto-send hook at the end of the pipeline.
 */
router.post('/api/heyreach/send/:jobId', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const job = await db.getJobById(jobId).catch(() => null);
    if (!job) return res.status(404).json({ error: `Job ${jobId} not found` });

    res.json({ ok: true, message: `HeyReach send started for job ${jobId} — poll /api/heyreach for results` });
    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline()._runHeyReachSend(jobId).catch(err => {
        const Logger = require('../Logger');
        new Logger('HeyReachSend').error(`Send failed for job ${jobId}`, { error: err.message });
    });
});

// ── HeyReach endpoints ────────────────────────────────────────────────────────

// GET /api/heyreach — contacts eligible for LinkedIn outreach
router.get('/api/heyreach', async (req, res) => {
    try {
        const { limit = 500, route, generated } = req.query;
        const contacts = await db.getHeyReachContacts({
            limit: parseInt(limit),
            route:     route     || null,
            generated: generated || null,
        });
        res.json({ count: contacts.length, contacts });
    } catch (err) {
        res.status(503).json({ error: err.message, contacts: [] });
    }
});

// POST /api/heyreach/generate — generate AI content for one or many contacts
router.post('/api/heyreach/generate', async (req, res) => {
    const { contact_ids, all = false } = req.body || {};
    const HeyReach = require('../services/HeyReachService');

    try {
        let targets;
        if (all) {
            targets = await db.getHeyReachContacts({ limit: 2000, generated: 'no' });
        } else if (Array.isArray(contact_ids) && contact_ids.length) {
            targets = await db.getHeyReachContacts({ limit: 2000 });
            targets = targets.filter(c => contact_ids.includes(c.id));
        } else {
            return res.status(400).json({ error: 'Provide contact_ids array or all:true' });
        }

        res.json({ ok: true, queued: targets.length });

        // Process in background — one at a time to avoid rate limits
        (async () => {
            let done = 0, errors = 0;
            for (const contact of targets) {
                try {
                    const job = { job_title: contact.job_title, job_url: contact.job_url,
                                  top_job_tech_comma: contact.top_job_tech_comma };
                    const fields = await HeyReach.generateContent(contact, job);
                    await db.updateContact(contact.id, fields);
                    done++;
                } catch (e) {
                    await db.updateContact(contact.id, { heyreach_error: e.message }).catch(() => {});
                    errors++;
                }
            }
            const logger = require('../Logger');
            new logger('HeyReach').info('Batch generate complete', { done, errors });
        })();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/fresh-start — wipe all processed data, keep received-stage jobs intact
router.post('/admin/fresh-start', async (req, res) => {
    try {
        const q = db.db.query.bind(db.db);
        await q('DELETE FROM lpf_sends');
        await q('DELETE FROM lpf_contacts');
        await q('DELETE FROM lpf_pipeline_log');
        await q('DELETE FROM lpf_api_costs');
        await q('DELETE FROM lpf_cell_runs');
        await q('DELETE FROM lpf_cell_state');
        await q('DELETE FROM lpf_condition_traces');
        await q('DELETE FROM lpf_companies');
        await q("DELETE FROM lpf_jobs WHERE stage != 'received'");
        res.json({ ok: true, message: 'Fresh start — processed data cleared, unprocessed queue intact' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/reset — truncate all tables (requires ?confirm=yes)
router.post('/admin/reset', async (req, res) => {
    if (req.query.confirm !== 'yes') {
        return res.status(400).json({ error: 'Pass ?confirm=yes to proceed' });
    }
    try {
        await db.db.query(`
            TRUNCATE TABLE lpf_sends, lpf_pipeline_log, lpf_contacts,
                           lpf_companies, lpf_logs, lpf_jobs
            RESTART IDENTITY CASCADE
        `);
        res.json({ ok: true, message: 'All data cleared' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /contacts/:id/send/instantly — approve + send single contact to Instantly
router.post('/contacts/:id/send/instantly', async (req, res) => {
    const contactId = parseInt(req.params.id);
    if (isNaN(contactId)) return res.status(400).json({ error: 'Invalid contact ID' });

    try {
        const { campaign_id = null } = req.body;
        await db.updateContact(contactId, {
            send_decision:    'approved',
            send_destination: 'instantly',
            send_campaign_id: campaign_id,
        });

        const contact = await db.db.queryOne('SELECT * FROM lpf_contacts WHERE id = $1', [contactId]);
        if (!contact) return res.status(404).json({ error: 'Contact not found' });

        const job = await db.getJobById(contact.job_id);
        res.json({ ok: true, message: `Queued contact ${contactId} for send` });

        const Pipeline = require('../pipeline/Pipeline');
        new Pipeline().sendJob(contact.job_id).catch(err => {
            const Logger = require('../Logger');
            new Logger('ContactSend').error('Send failed', { contact_id: contactId, error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /contacts/:id/send/heyreach — send single contact to HeyReach via LinkedIn URL
router.post('/contacts/:id/send/heyreach', async (req, res) => {
    const contactId = parseInt(req.params.id);
    if (isNaN(contactId)) return res.status(400).json({ error: 'Invalid contact ID' });

    try {
        const contact = await db.db.queryOne(
            `SELECT c.*, j.job_title, j.dev_or_eng, j.sap_skills_comma, j.shorter_tech_comma,
                    j.imagined_city, j.imagined_nearby_city, j.imagined_industry
             FROM lpf_contacts c LEFT JOIN lpf_jobs j ON c.job_id = j.id WHERE c.id = $1`,
            [contactId]
        );
        if (!contact) return res.status(404).json({ error: 'Contact not found' });

        const HeyReach = require('../services/HeyReachService');
        const listId   = req.body.list_id || null;
        const leadId   = await HeyReach.addLead(contact, listId);
        await db.markContactSentHeyReach(contactId, leadId);
        res.json({ ok: true, lead_id: leadId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /contacts/bulk-send — bulk approve + send contacts to instantly or heyreach
router.post('/contacts/bulk-send', async (req, res) => {
    const { ids, destination = 'instantly', campaign_id = null, list_id = null } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });

    const contactIds = ids.map(Number).filter(n => !isNaN(n));
    if (!contactIds.length) return res.status(400).json({ error: 'No valid IDs' });

    res.json({ ok: true, message: `Sending ${contactIds.length} contacts to ${destination}…` });

    try {
        const contacts = await db.getContactsByIds(contactIds);

        if (destination === 'heyreach') {
            const HeyReach = require('../services/HeyReachService');
            for (const c of contacts) {
                try {
                    const leadId = await HeyReach.addLead(c, list_id);
                    await db.markContactSentHeyReach(c.id, leadId);
                } catch (e) {
                    const Logger = require('../Logger');
                    new Logger('BulkSend').warn(`HeyReach failed for contact ${c.id}`, { error: e.message });
                }
            }
        } else {
            // Instantly — approve all contacts then trigger Stage08 per job
            for (const c of contacts) {
                await db.updateContact(c.id, {
                    send_decision:    'approved',
                    send_destination: 'instantly',
                    send_campaign_id: campaign_id,
                }).catch(() => {});
            }
            const jobIds = [...new Set(contacts.map(c => c.job_id).filter(Boolean))];
            const Pipeline = require('../pipeline/Pipeline');
            for (const jobId of jobIds) {
                new Pipeline().sendJob(jobId).catch(() => {});
            }
        }
    } catch (err) {
        const Logger = require('../Logger');
        new Logger('BulkSend').error('Bulk send error', { error: err.message });
    }
});

// (duplicate /api/costs removed — defined earlier in file)

// GET /api/costs/:jobId — per-job cost breakdown
router.get('/api/costs/:jobId', async (req, res) => {
    try {
        const rows = await costTracker.getJobCosts(parseInt(req.params.jobId));
        res.json({ count: rows.length, costs: rows });
    } catch (err) {
        res.status(503).json({ error: err.message, costs: [] });
    }
});

// POST /upload/csv — bulk import jobs from CSV with column mapping
// Body: { rows: [[...]], headers: [...], mapping: { job_title: "col_name", ... }, run_pipeline: bool }
router.post('/upload/csv', async (req, res) => {
    const { rows, headers, mapping, run_pipeline = false } = req.body;
    if (!rows?.length || !mapping) return res.status(400).json({ error: 'rows and mapping required' });

    const FIELDS = ['job_title','job_url','job_description','company_name','company_url',
                    'company_linkedin_url','city','country','job_poster_url','source','applicant_count'];

    // Build header index
    const idx = {};
    for (const [field, col] of Object.entries(mapping)) {
        const i = headers.indexOf(col);
        if (i >= 0) idx[field] = i;
    }

    let inserted = 0, skipped = 0, errors = [];
    for (const row of rows) {
        const job = {};
        for (const f of FIELDS) {
            if (idx[f] !== undefined) job[f] = (row[idx[f]] || '').trim() || null;
        }
        // Custom mapped fields → store in source field
        if (!job.job_title && !job.job_url) { skipped++; continue; }
        job.job_url  = job.job_url  || `csv://import/${Date.now()}-${Math.random().toString(36).slice(2)}`;
        job.source   = job.source   || 'csv_import';
        try {
            await db.upsertJob(job);
            inserted++;
        } catch (err) {
            skipped++;
            if (errors.length < 5) errors.push({ row: row.slice(0, 3).join(','), error: err.message });
        }
    }

    if (run_pipeline && inserted > 0) {
        const Pipeline = require('../pipeline/Pipeline');
        new Pipeline().run(Math.min(inserted, 10)).catch(() => {});
    }

    res.json({ ok: true, inserted, skipped, errors });
});

// ── Retry API ─────────────────────────────────────────────────────────────────

// Maps every colId back to its owning pipeline stage name.
const COL_TO_STAGE = {
    stage1_dach:          'stage1_sap',
    stage1_direct:        'stage1_sap',
    stage1_sap_check:     'stage1_sap',
    stage1_score:         'stage1_sap',
    stage1_fit:           'stage1_sap',
    stage2_enrich:        'stage2_company',
    stage2_apify:         'stage2_company',
    stage2_industry:      'stage2_company',
    stage2_employees:     'stage2_company',
    stage3_tech_extract:  'stage3_tech',
    stage3_sap_modules:   'stage3_tech',
    stage3_city_industry: 'stage3_tech',
    stage3_tech_comma:    'stage3_tech',
    stage4_apollo:        'stage4_people',
    stage4_linkedin:      'stage4_people',
    stage4_people_total:  'stage4_people',
    stage5_fm:            'stage5_enrich',
    stage5_ap:            'stage5_enrich',
    stage5_hv:            'stage5_enrich',
    stage5_tk:            'stage5_enrich',
    stage6_job_poster:    'stage6_poster',
    stage7_ai_search:     'stage7_ai_search',
};

const VALID_STAGES = [
    'stage1_sap','stage2_company','stage3_tech','stage4_people',
    'stage5_enrich','stage6_poster','stage7_ai_search',
];

async function _resetAndRun(jobId, stageName) {
    const pool = require('../database/Database').getInstance().pool;
    await pool.query(`UPDATE lpf_jobs SET stage = $1 WHERE id = $2`, [stageName, jobId]);
    const job = await db.getJobById(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline().runJobs([job]).catch(err => {
        const Logger = require('../Logger');
        new Logger('RetryAPI').error('Retry pipeline error', { job_id: jobId, error: err.message });
    });
}

/**
 * POST /api/pipeline/retry-cell
 * Body: { jobId, colId }
 * Resets the job to the stage that owns colId, then re-runs the pipeline.
 */
router.post('/api/pipeline/retry-cell', async (req, res) => {
    const { jobId, colId } = req.body;
    if (!jobId || !colId) return res.status(400).json({ error: 'jobId and colId required' });
    const stage = COL_TO_STAGE[colId];
    if (!stage) return res.status(400).json({ error: `Unknown colId: ${colId}` });
    try {
        await _resetAndRun(parseInt(jobId), stage);
        res.json({ ok: true, message: `Job ${jobId} retrying from ${stage}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/pipeline/retry-stage
 * Body: { jobId, stage }
 * Resets the job to the given stage, then re-runs.
 */
router.post('/api/pipeline/retry-stage', async (req, res) => {
    const { jobId, stage } = req.body;
    if (!jobId || !stage) return res.status(400).json({ error: 'jobId and stage required' });
    if (!VALID_STAGES.includes(stage)) return res.status(400).json({ error: `Invalid stage: ${stage}` });
    try {
        await _resetAndRun(parseInt(jobId), stage);
        res.json({ ok: true, message: `Job ${jobId} retrying from ${stage}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/pipeline/retry-column
 * Body: { colId }
 * Finds all jobs with error state in colId and retries each from its owning stage.
 */
router.post('/api/pipeline/retry-column', async (req, res) => {
    const { colId } = req.body;
    if (!colId) return res.status(400).json({ error: 'colId required' });
    const stage = COL_TO_STAGE[colId];
    if (!stage) return res.status(400).json({ error: `Unknown colId: ${colId}` });
    try {
        const pool = require('../database/Database').getInstance().pool;
        const result = await pool.query(
            `SELECT DISTINCT job_id FROM lpf_cell_state WHERE col_id = $1 AND state = 'error'`,
            [colId]
        );
        const jobIds = result.rows.map(r => r.job_id);
        res.json({ ok: true, message: `Retrying ${jobIds.length} jobs from ${stage}` });
        for (const jobId of jobIds) {
            try { await _resetAndRun(jobId, stage); } catch (_) {}
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Cell state API ─────────────────────────────────────────────────────────────

/**
 * GET /api/cell-states?jobId=X
 * Returns all cell states for one job — used by Phase C table renderer.
 * Response: { states: [{ col_id, state, value, error_msg, error_kind, run_count, updated_at }] }
 */
router.get('/api/cell-states', async (req, res) => {
    const { jobId } = req.query;
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    try {
        const pool = require('../database/Database').getInstance().pool;

        // ── Stuck-cell auto-recovery ────────────────────────────────────────
        // When `node --watch` restarts the server mid-stage (or a stage hits
        // an unhandled exception), cells stay in 'running' state forever in
        // the DB. Any time the client polls cell-states for a job, we first
        // sweep through and reset cells that have been 'running' for >5 min,
        // marking them as 'error' with a clear message so the operator can
        // retry. This keeps the dashboard honest without a separate cron.
        await pool.query(
            `UPDATE lpf_cell_state
             SET state      = 'error',
                 error_msg  = COALESCE(error_msg, 'Cell was stuck in running state — pipeline likely restarted mid-execution. Click "retry" to re-run.'),
                 error_kind = 'orphaned',
                 updated_at = NOW()
             WHERE job_id  = $1
               AND state   = 'running'
               AND updated_at < NOW() - INTERVAL '5 minutes'`,
            [parseInt(jobId)]
        ).catch(() => {});

        const result = await pool.query(
            `SELECT col_id, state, value, error_msg, error_kind, run_count, updated_at
             FROM lpf_cell_state WHERE job_id = $1 ORDER BY col_id`,
            [parseInt(jobId)]
        );
        res.json({ states: result.rows });
    } catch (err) {
        res.status(503).json({ error: err.message, states: [] });
    }
});

/**
 * GET /api/cell-states/bulk?jobIds=1,2,3
 * Returns cell states for multiple jobs at once.
 * Response: { states: { [jobId]: [{ col_id, state, ... }] } }
 */
router.get('/api/cell-states/bulk', async (req, res) => {
    const raw = (req.query.jobIds || '').split(',').map(Number).filter(Boolean);
    if (!raw.length) return res.status(400).json({ error: 'jobIds required' });
    try {
        const pool = require('../database/Database').getInstance().pool;
        const result = await pool.query(
            `SELECT job_id, col_id, state, value, error_msg, error_kind, run_count, updated_at
             FROM lpf_cell_state WHERE job_id = ANY($1::int[]) ORDER BY job_id, col_id`,
            [raw]
        );
        const out = {};
        for (const row of result.rows) {
            if (!out[row.job_id]) out[row.job_id] = [];
            out[row.job_id].push(row);
        }
        res.json({ states: out });
    } catch (err) {
        res.status(503).json({ error: err.message, states: {} });
    }
});

/**
 * GET /api/cell-runs?jobId=X&colId=Y
 * Returns run history for a specific (job, column) pair — for the cell detail drawer.
 */
router.get('/api/cell-runs', async (req, res) => {
    const { jobId, colId } = req.query;
    if (!jobId || !colId) return res.status(400).json({ error: 'jobId and colId required' });
    try {
        const pool = require('../database/Database').getInstance().pool;
        const result = await pool.query(
            `SELECT id, status, value, error_msg, error_kind, duration_ms, started_at, ended_at
             FROM lpf_cell_runs WHERE job_id=$1 AND col_id=$2 ORDER BY started_at DESC LIMIT 20`,
            [parseInt(jobId), colId]
        );
        res.json({ runs: result.rows });
    } catch (err) {
        res.status(503).json({ error: err.message, runs: [] });
    }
});

// ── RecruiterFlow CRM API ─────────────────────────────────────────────────────

/**
 * POST /crm/push/:jobId
 * Push a job (company + contacts + job) to RecruiterFlow CRM.
 * Returns immediately; CRM writes happen in background.
 */
router.post('/crm/push/:jobId', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    if (isNaN(jobId)) return res.status(400).json({ error: 'Invalid job ID' });

    const job = await db.getJobById(jobId).catch(() => null);
    if (!job) return res.status(404).json({ error: `Job ${jobId} not found` });

    res.json({ ok: true, message: `CRM push started for job ${jobId}` });

    const Pipeline = require('../pipeline/Pipeline');
    new Pipeline()._runCRMPush(jobId).catch(err => {
        const Logger = require('../Logger');
        new Logger('CRM').error('CRM push failed', { job_id: jobId, error: err.message });
    });
});

/**
 * GET /crm/records/:jobId
 * Returns all CRM records for a job (company + contacts + job).
 */
router.get('/crm/records/:jobId', async (req, res) => {
    try {
        const jobId = parseInt(req.params.jobId);
        const records = await db.getCRMRecordsForJob(jobId);
        res.json({ count: records.length, records });
    } catch (err) {
        res.status(503).json({ error: err.message, records: [] });
    }
});

/**
 * GET /crm/records
 * Returns all CRM records (paginated), optionally filtered by record_type or status.
 * Query params: type=company|contact|job, status=sent|error|dedup_skipped, limit=200
 */
router.get('/crm/records', async (req, res) => {
    try {
        const { type, status, limit = 200 } = req.query;
        const records = await db.getAllCRMRecords({
            limit:       parseInt(limit),
            record_type: type   || null,
            status:      status || null,
        });
        res.json({ count: records.length, records });
    } catch (err) {
        res.status(503).json({ error: err.message, records: [] });
    }
});

/**
 * GET /crm/summary
 * Aggregated counts per record_type and status — for the CRM tab header.
 */
router.get('/crm/summary', async (req, res) => {
    try {
        const pool   = require('../database/Database').getInstance().pool;
        const result = await pool.query(`
            SELECT record_type, status, COUNT(*) AS count
            FROM lpf_crm_records
            GROUP BY record_type, status
            ORDER BY record_type, status
        `);
        res.json({ rows: result.rows });
    } catch (err) {
        res.status(503).json({ error: err.message, rows: [] });
    }
});

/**
 * POST /crm/push-batch
 * Push multiple jobs to CRM. Body: { ids: [1,2,3] }
 */
router.post('/crm/push-batch', async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });

    const jobIds = ids.map(Number).filter(n => !isNaN(n));
    res.json({ ok: true, message: `CRM push started for ${jobIds.length} jobs` });

    const { pushJobToCRM } = require('../pipeline/CRMPush');
    const Logger = require('../Logger');
    const log = new Logger('CRM');

    (async () => {
        for (const jobId of jobIds) {
            try {
                const job      = await db.getJobById(jobId);
                if (!job) continue;
                const contacts = await db.getContactsForJob(jobId);
                await pushJobToCRM(job, contacts, db);
                log.info('Batch CRM push done', { job_id: jobId });
            } catch (err) {
                log.error('Batch CRM push failed', { job_id: jobId, error: err.message });
            }
        }
    })();
});

module.exports = router;
