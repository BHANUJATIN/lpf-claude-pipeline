-- claude-jpe PostgreSQL schema
-- Run via: npm run migrate

-- ── Jobs ─────────────────────────────────────────────────────────────────────
-- One row per job received from JPE.
-- Tracks every stage of the pipeline via `stage` column.

CREATE TABLE IF NOT EXISTS lpf_jobs (
    id                      SERIAL PRIMARY KEY,

    -- Raw fields from JPE
    job_url                 TEXT UNIQUE NOT NULL,
    job_title               TEXT,
    job_description         TEXT,
    city                    TEXT,
    country                 TEXT,
    company_url             TEXT,
    company_linkedin_url    TEXT,
    company_name            TEXT,
    job_poster_url          TEXT,       -- LinkedIn URL of person who posted the job
    source                  TEXT,       -- 'LinkedIn jobs' | 'Indeed jobs' | ...
    applicant_count         TEXT,
    search_term             TEXT,

    -- Pipeline stage tracking
    -- Possible values: received | stage1_sap | stage2_company | stage3_tech |
    --   stage4_people | stage5_enrich | stage6_poster | stage7_ai_search |
    --   stage8_send | completed | rejected
    stage                   TEXT        DEFAULT 'received',
    stage_error             TEXT,

    -- Stage 1: SAP & filter check results
    is_sap                  BOOLEAN,
    sap_rejection_reason    TEXT,
    is_dach                 BOOLEAN,
    is_direct_employer      BOOLEAN,
    quality_score           INTEGER,    -- 1-10
    seniority               TEXT,       -- junior | mid | senior | unknown
    ctr_fit                 TEXT,       -- high | medium | low | none

    -- Stage 2: Company enrichment (from Proxycurl LinkedIn)
    company_domain          TEXT,
    company_description     TEXT,
    company_employee_count  INTEGER,
    company_dach_employees  INTEGER,
    company_hq_city         TEXT,
    company_hq_country      TEXT,
    company_industry        TEXT,

    -- Stage 3: Tech extraction (GPT-4o mini)
    sap_modules             TEXT,       -- 'SAP SD, GTS, EDI'
    sap_skills_comma        TEXT,       -- comma-separated SAP skills (WB2.3 col 46)
    tech_combined           TEXT,       -- full tech stack string
    tech_short              TEXT,       -- short form e.g. 'SD'
    tech_short2             TEXT,       -- alternate short form
    tech_compressed         TEXT,       -- no spaces e.g. 'SAPSD'
    tech_longer             TEXT,       -- AI verbose e.g. 'SAP Sales & Distribution'
    tech_longer_abbrev      TEXT,       -- formula: core/related e.g. 'FI/CO/ ABAP/ Fiori'
    top_job_tech_comma                  TEXT,
    dev_or_engineer                     TEXT,
    a_dev_or_engineer                   TEXT,
    primary_tech                        TEXT,
    -- Instantly custom variables (Stage03 additions)
    dev_or_eng                          TEXT,       -- short: 'dev' | 'engineer' | 'consultant'
    shorter_tech_description            TEXT,       -- e.g. 'SAP SD'
    shorter_tech_description_scrambled  TEXT,       -- slight variation for outreach variety
    shorter_tech_comma                  TEXT,       -- short comma list: 'SD, S/4HANA, EDI'
    comma_tech_description              TEXT,       -- long comma list (full names)
    imagined_city                       TEXT,       -- AI-generated candidate city
    imagined_nearby_city                TEXT,       -- AI-generated nearby city
    imagined_industry                   TEXT,       -- AI-generated industry phrase

    -- Stage 4: People finding counts
    apollo_people_found     INTEGER     DEFAULT 0,
    li_people_found         INTEGER     DEFAULT 0,
    total_people_found      INTEGER     DEFAULT 0,

    -- Timestamps
    received_at             TIMESTAMPTZ DEFAULT NOW(),
    processed_at            TIMESTAMPTZ,
    sent_at                 TIMESTAMPTZ,

    raw_payload             JSONB
);

CREATE INDEX IF NOT EXISTS idx_jobs_stage       ON lpf_jobs(stage);
CREATE INDEX IF NOT EXISTS idx_jobs_received    ON lpf_jobs(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company_url ON lpf_jobs(company_url);


-- ── Companies ─────────────────────────────────────────────────────────────────
-- Cached company data — avoids re-fetching Proxycurl on every job from same company.

CREATE TABLE IF NOT EXISTS lpf_companies (
    id                      SERIAL PRIMARY KEY,
    company_url             TEXT UNIQUE,
    company_linkedin_url    TEXT,
    company_name            TEXT,
    company_domain          TEXT,
    company_description     TEXT,
    company_industry        TEXT,
    employee_count          INTEGER,
    dach_employees          INTEGER,
    hq_city                 TEXT,
    hq_country              TEXT,
    last_seen               TIMESTAMPTZ DEFAULT NOW(),
    created_at              TIMESTAMPTZ DEFAULT NOW()
);


-- ── Contacts ──────────────────────────────────────────────────────────────────
-- All people found across Stages 4, 5, 6, 7 for each job's company.

CREATE TABLE IF NOT EXISTS lpf_contacts (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER     REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    company_url             TEXT,
    company_name            TEXT,

    -- Identity
    first_name              TEXT,
    last_name               TEXT,
    full_name               TEXT,
    email                   TEXT,
    email_validated         BOOLEAN     DEFAULT FALSE,
    email_source            TEXT,       -- 'apollo' | 'clearbit' | 'manual'

    -- LinkedIn
    linkedin_url            TEXT,
    linkedin_url_merged     TEXT,       -- consolidated best URL
    person_linkedin_url     TEXT,       -- alternate field (from WB2.2)
    li_merged               TEXT,       -- final merged (WB2.2 LinkedInMerged)

    -- Profile
    title                   TEXT,
    city                    TEXT,
    country                 TEXT,
    is_dach                 BOOLEAN,
    person_source           TEXT,       -- which platform the data came from

    -- German personalisation (WB2.3 columns 34-35)
    gender                  TEXT,       -- 'male' | 'female' | 'unknown'
    salutation              TEXT,       -- 'Herr Müller' | 'Frau Schmidt'

    -- Contact classification
    source                  TEXT,       -- 'apollo' | 'linkedin' | 'ai_search' | 'job_poster'
    contact_type            TEXT,       -- 'ceo' | 'hr' | 'tech' | 'sap' | 'job_poster'

    -- IT role verification (WB2.3 col 33)
    is_it_role              BOOLEAN,

    -- Manual review / send control (set via UI before Stage 8)
    send_decision           TEXT,       -- NULL=pending | 'approved' | 'skipped'
    send_destination        TEXT,       -- 'instantly' | 'heyreach' (default: instantly)
    send_campaign_id        TEXT,       -- overrides INSTANTLY_CAMPAIGN_ID if set

    -- Outreach status
    sent_to_instantly       BOOLEAN     DEFAULT FALSE,
    instantly_lead_id       TEXT,
    sent_at                 TIMESTAMPTZ,

    raw_data                JSONB,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Add review columns to existing tables (idempotent)
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS send_decision    TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS send_destination TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS send_campaign_id TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_job_id      ON lpf_contacts(job_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_url ON lpf_contacts(company_url);
CREATE INDEX IF NOT EXISTS idx_contacts_sent        ON lpf_contacts(sent_to_instantly);


-- ── Pipeline log ──────────────────────────────────────────────────────────────
-- Detailed audit: every stage start/end/fail for every job.

CREATE TABLE IF NOT EXISTS lpf_pipeline_log (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER     REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    stage                   TEXT        NOT NULL,
    status                  TEXT        NOT NULL,   -- started | completed | failed | skipped
    message                 TEXT,
    data                    JSONB,
    duration_ms             INTEGER,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_log_job_id  ON lpf_pipeline_log(job_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_log_stage   ON lpf_pipeline_log(stage);


-- ── Instantly sends ───────────────────────────────────────────────────────────
-- One row per contact sent to Instantly.

CREATE TABLE IF NOT EXISTS lpf_sends (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER     REFERENCES lpf_jobs(id),
    contact_id              INTEGER     REFERENCES lpf_contacts(id),
    campaign_id             TEXT,
    payload                 JSONB,
    instantly_response      JSONB,
    success                 BOOLEAN,
    error_message           TEXT,
    sent_at                 TIMESTAMPTZ DEFAULT NOW()
);


-- ── Application logs ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lpf_logs (
    id                      SERIAL PRIMARY KEY,
    level                   TEXT        NOT NULL,
    module                  TEXT,
    message                 TEXT        NOT NULL,
    meta                    JSONB,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_level   ON lpf_logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created ON lpf_logs(created_at DESC);

-- ── Additive migrations (idempotent) ──────────────────────────────────────────
-- HeyReach send tracking
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS sent_to_heyreach    BOOLEAN     DEFAULT FALSE;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_lead_id    TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_sent_at    TIMESTAMPTZ;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS is_heyreach_eligible BOOLEAN     DEFAULT FALSE;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS is_it_role           BOOLEAN;

ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS dev_or_eng                         TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS shorter_tech_description            TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS shorter_tech_description_scrambled  TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS shorter_tech_comma                  TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS comma_tech_description              TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS imagined_city                       TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS imagined_nearby_city                TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS imagined_industry                   TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS rejection_comment                   TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS tech_longer_abbrev                   TEXT;

-- ── API cost tracking ─────────────────────────────────────────────────────────
-- One row per API call that consumed tokens or credits.

CREATE TABLE IF NOT EXISTS lpf_api_costs (
    id              SERIAL PRIMARY KEY,
    job_id          INTEGER     REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    service         TEXT        NOT NULL,   -- 'openai' | 'apollo' | 'proxycurl' | 'apify'
    operation       TEXT        NOT NULL,   -- 'stage1_sap_check' | 'people_search' | etc.
    model           TEXT,                   -- 'gpt-4o-mini' etc
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    credits_used    INTEGER,                -- for Apollo / Proxycurl (1 per call)
    cost_usd        NUMERIC(10,6),
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_costs_job_id  ON lpf_api_costs(job_id);
CREATE INDEX IF NOT EXISTS idx_api_costs_service ON lpf_api_costs(service);
CREATE INDEX IF NOT EXISTS idx_api_costs_created ON lpf_api_costs(created_at DESC);

-- ── Settings (key/value store) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lpf_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);


-- ── Cell state tracking (Phase B — Clay parity) ───────────────────────────────
-- Per-job, per-column enrichment state (7-state machine):
--   idle | condition_not_met | queued | running | success | success_empty | error

CREATE TABLE IF NOT EXISTS lpf_cell_state (
    id          SERIAL PRIMARY KEY,
    job_id      INTEGER NOT NULL REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    col_id      TEXT    NOT NULL,       -- matches PIPELINE_COLUMNS[].id in frontend
    state       TEXT    NOT NULL DEFAULT 'idle',
    value       TEXT,                  -- last successful output (stringified)
    error_msg   TEXT,
    error_kind  TEXT,                  -- network|rate_limit|validation|auth|timeout|provider_error|unknown
    run_count   INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(job_id, col_id)
);

CREATE INDEX IF NOT EXISTS idx_cell_state_job   ON lpf_cell_state(job_id);
CREATE INDEX IF NOT EXISTS idx_cell_state_col   ON lpf_cell_state(col_id);
CREATE INDEX IF NOT EXISTS idx_cell_state_state ON lpf_cell_state(state);


-- ── Cell run history ──────────────────────────────────────────────────────────
-- One row per execution attempt for each (job, column) pair.

CREATE TABLE IF NOT EXISTS lpf_cell_runs (
    id          SERIAL PRIMARY KEY,
    job_id      INTEGER NOT NULL REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    col_id      TEXT    NOT NULL,
    status      TEXT    NOT NULL,      -- running|success|success_empty|error|condition_not_met
    value       TEXT,
    error_msg   TEXT,
    error_kind  TEXT,
    duration_ms INTEGER,
    started_at  TIMESTAMPTZ DEFAULT NOW(),
    ended_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cell_runs_job ON lpf_cell_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_cell_runs_col ON lpf_cell_runs(col_id, job_id);


-- ── Condition traces ──────────────────────────────────────────────────────────
-- Records why a run condition passed or failed for each (job, column) evaluation.

CREATE TABLE IF NOT EXISTS lpf_condition_traces (
    id         SERIAL PRIMARY KEY,
    job_id     INTEGER NOT NULL REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    col_id     TEXT    NOT NULL,
    passes     BOOLEAN NOT NULL,
    reason     TEXT,
    evaluated  JSONB,                  -- [{name, value, expected, ok}, ...]
    checked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cond_traces_job ON lpf_condition_traces(job_id);


-- reviewed_at: set when a job enters the manual review queue
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ── HeyReach AI content columns (LPF Table 4 parity) ─────────────────────────
-- Generated per contact by the HeyReach generation endpoint.
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS connection_req          TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS inmail_body_de          TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS english_inmail          TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_route          TEXT;  -- 'free_inmail' | 'conreq_plus_inmail' | 'connect_only'
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_generated_at   TIMESTAMPTZ;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_error          TEXT;

-- ── New HeyReach pipeline (DACH-by-LinkedIn check + 3 intermediate sentence prompts) ──
-- Each row caches the exact text the operator's prompts produced so the dashboard
-- can show "this is why we skipped" / "this is what the model wrote for this step".
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_dach_check          TEXT; -- 'yes' | 'no' | '' (blank=unknown)
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_dach_reasoning      TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_skip_reason         TEXT;
-- Per-contact email-finder diagnostic: when no email was found, lists every
-- provider tried + why each fell through. Shown in the dashboard "no email"
-- tooltip so the operator knows why we couldn't reach this person.
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS email_skip_reason            TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_job_posting_intro          TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_imagined_city_sentence     TEXT;
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_imagined_industry_sentence TEXT;
-- Full HeyReach API response body (success or error) — surfaced in the dashboard's "Sent ✅" detail drawer
ALTER TABLE lpf_contacts ADD COLUMN IF NOT EXISTS heyreach_response                   JSONB;

-- ── HeyReach routing rows (1 row per contact eligible for LinkedIn outreach) ──
CREATE TABLE IF NOT EXISTS lpf_heyreach_rows (
    id                          SERIAL PRIMARY KEY,
    contact_id                  INTEGER REFERENCES lpf_contacts(id) ON DELETE CASCADE,
    job_id                      INTEGER REFERENCES lpf_jobs(id),
    -- AI-generated message content
    connection_req              TEXT,
    english_inmail              TEXT,
    inmail_body_de              TEXT,
    message_translation         TEXT,
    -- personalisation vars (from job)
    imagined_city               TEXT,
    imagined_nearby_city        TEXT,
    imagined_industry           TEXT,
    job_posting_intro           TEXT,
    -- routing flags
    is_hot_job_title            BOOLEAN,
    is_connect_only             BOOLEAN,
    is_open_profile             BOOLEAN,
    heyreach_route              TEXT,   -- 'free_inmail' | 'conreq_plus_inmail' | 'connect_only'
    status                      TEXT NOT NULL DEFAULT 'pending', -- pending | ready | sent | error
    -- action results per campaign type
    free_inmail_sent_at         TIMESTAMPTZ,
    free_inmail_lead_id         TEXT,
    free_inmail_error           TEXT,
    conreq_plus_inmail_sent_at  TIMESTAMPTZ,
    conreq_plus_inmail_lead_id  TEXT,
    conreq_plus_inmail_error    TEXT,
    conreq_only_sent_at         TIMESTAMPTZ,
    conreq_only_lead_id         TEXT,
    conreq_only_error           TEXT,
    connect_only_sent_at        TIMESTAMPTZ,
    connect_only_lead_id        TEXT,
    connect_only_error          TEXT,
    -- audit
    generated_at                TIMESTAMPTZ,
    error_msg                   TEXT,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_heyreach_rows_contact ON lpf_heyreach_rows(contact_id);
CREATE INDEX IF NOT EXISTS idx_heyreach_rows_job     ON lpf_heyreach_rows(job_id);
CREATE INDEX IF NOT EXISTS idx_heyreach_rows_status  ON lpf_heyreach_rows(status);


-- ── RecruiterFlow CRM records ──────────────────────────────────────────────────
-- One row per entity pushed to RecruiterFlow (company, contact, or job).
-- Tracks status, payload sent, and RF response for the CRM dashboard tab.

CREATE TABLE IF NOT EXISTS lpf_crm_records (
    id           SERIAL PRIMARY KEY,
    job_id       INTEGER     REFERENCES lpf_jobs(id) ON DELETE CASCADE,
    contact_id   INTEGER     REFERENCES lpf_contacts(id) ON DELETE CASCADE,
    record_type  TEXT        NOT NULL,   -- 'company' | 'contact' | 'job'
    rf_id        TEXT,                   -- RecruiterFlow returned record ID
    rf_client_id INTEGER,                -- RF company ID (for linking contacts+jobs)
    status       TEXT        NOT NULL DEFAULT 'pending',
                                         -- pending | sent | dedup_skipped | error | skipped
    payload      JSONB,                  -- payload we sent to RF
    response     JSONB,                  -- RF API response body
    error_msg    TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_records_job     ON lpf_crm_records(job_id);
CREATE INDEX IF NOT EXISTS idx_crm_records_contact ON lpf_crm_records(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_records_type    ON lpf_crm_records(record_type);
CREATE INDEX IF NOT EXISTS idx_crm_records_status  ON lpf_crm_records(status);

-- Dedup existing rows before adding the unique partial indexes (idempotent).
-- Keeps the most recent row per (job_id, contact_id, record_type) triplet,
-- treating NULL contact_id as the company/job slot.
DELETE FROM lpf_crm_records r
USING (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY job_id, COALESCE(contact_id, -1), record_type
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
    FROM lpf_crm_records
) d
WHERE r.id = d.id AND d.rn > 1;

-- Unique key for CRM records — lets upsertCRMRecord ON CONFLICT actually dedup.
-- A job has at most one 'company' record (contact_id IS NULL) and one 'job' record,
-- and at most one 'contact' record per contact_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_records_uniq_company_or_job
    ON lpf_crm_records(job_id, record_type) WHERE contact_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_records_uniq_contact
    ON lpf_crm_records(job_id, contact_id, record_type) WHERE contact_id IS NOT NULL;

-- rf_client_id on jobs — persisted after company is created/found in RF
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS rf_client_id INTEGER;

-- crm_status: 'pending' | 'pushed' | 'partial' | 'error' — quick lookup for dashboard
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS crm_status        TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS crm_pushed_at      TIMESTAMPTZ;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS crm_error          TEXT;

-- Job poster fields — populated by Stage 6, shown in dashboard detail panel
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS job_poster_name    TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS job_poster_email   TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS job_poster_title   TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS job_poster_linkedin TEXT;

-- ── CV generation outputs (LPF Table 1 cols 6–11 parity) ──────────────────────
-- Populated by CVGenerationService — three variants per job (EN, EN v2, DE).
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS english_cv_text       TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS english_cv_v2_text    TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_german_text        TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_generated_at       TIMESTAMPTZ;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_error              TEXT;
-- GPT cost per CV-generation run — surfaced in the dashboard so users know what each click costs.
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_cost_usd            NUMERIC(10,6);
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_cost_breakdown      JSONB;
-- Public CV PDF URL (Google Drive). Surfaced to the CV save-back sheet so the
-- recruiter can paste a candidate link into the outbound email.
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_pdf_public_url      TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_pdf_drive_file_id   TEXT;

-- ── New CV pipeline (eligibility check → structured EN → DE translation → Apps Script PDF) ──
-- The PDFs are rendered by an external Google Apps Script that returns Drive URLs.
-- Both URLs are written back into the SAP jobs sheet via the configured column mapping.
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_eligible          BOOLEAN;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_eligibility       JSONB;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS english_cv_json      JSONB;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS german_cv_json       JSONB;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_pdf_url_english   TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_pdf_url_german    TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_pdf_doc_id_english TEXT;
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS cv_pdf_doc_id_german  TEXT;

-- ── Connections (API keys + Google Sheets + Google Drive) ─────────────────────
-- Stores all user-managed integrations. Replaces the env-var-only model so the
-- recruiter can add/swap sheets and accounts without editing .env.
--
--   type:    'api_key' | 'google_sheet' | 'google_drive'
--   purpose: free-form label that connects this row to a usage site, e.g.
--            'company_enrich' | 'people_email' | 'sap_jobs_write' | 'cv_save_back'
--   config:  JSONB with the connection-specific shape (see ConnectionService)
CREATE TABLE IF NOT EXISTS lpf_connections (
    id              SERIAL PRIMARY KEY,
    type            TEXT        NOT NULL,    -- api_key | google_sheet | google_drive
    purpose         TEXT,                    -- usage tag (nullable for api_key)
    name            TEXT        NOT NULL,    -- human label, e.g. "Production OpenAI"
    config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_default      BOOLEAN     NOT NULL DEFAULT FALSE,
    status          TEXT,                    -- ok | error | untested
    last_check_at   TIMESTAMPTZ,
    last_check_msg  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connections_type    ON lpf_connections(type);
CREATE INDEX IF NOT EXISTS idx_connections_purpose ON lpf_connections(purpose);

-- One default per (type, purpose) pair — the pipeline reads the default row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_one_default
    ON lpf_connections(type, COALESCE(purpose, '')) WHERE is_default = TRUE;
