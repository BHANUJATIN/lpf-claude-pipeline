const axios = require('axios');

const BASE_URL = 'https://api.instantly.ai/api/v2';

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic discovery — fetched live from Instantly so the dashboard can render
// the campaign picker + custom-variable mapping editor.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /campaigns — returns the operator's Instantly campaigns. Used by the
 * Connections UI to populate the "Send to which campaign" dropdown after the
 * API key is verified.
 *
 * @param {string} [apiKey]  Optional override; defaults to process.env.INSTANTLY_API_KEY
 * @returns {Promise<Array<{ id, name, status, custom_variables?: string[] }>>}
 */
async function fetchCampaigns(apiKey) {
    const key = apiKey || process.env.INSTANTLY_API_KEY;
    if (!key) throw new Error('No Instantly API key');

    const res = await axios.get(`${BASE_URL}/campaigns`, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 15000,
    });
    // Instantly returns either an array directly or { items: [...] } depending
    // on plan/version. Normalise.
    const rows = Array.isArray(res.data) ? res.data
               : Array.isArray(res.data?.items) ? res.data.items
               : Array.isArray(res.data?.data) ? res.data.data
               : [];
    return rows.map(c => ({
        id:     c.id || c.campaign_id || c._id,
        name:   c.name || c.campaign_name || '(unnamed)',
        status: c.status,
        // Custom variables defined on the campaign (if Instantly exposes them)
        custom_variables: c.custom_variables || c.variables || [],
    }));
}

/**
 * GET a single campaign — returns the campaign-level custom-variable schema
 * Instantly will accept on lead inserts. Used by the mapping editor to render
 * the variable list.
 *
 * Instantly's campaign object includes a `custom_variables` array of variable
 * names (no values) declared on the campaign. If the campaign hasn't declared
 * any, we still return the variables we KNOW the pipeline emits — see
 * DEFAULT_CUSTOM_VARIABLE_KEYS below.
 */
async function fetchCustomVariables(campaignId, apiKey) {
    const key = apiKey || process.env.INSTANTLY_API_KEY;
    if (!key) throw new Error('No Instantly API key');
    if (!campaignId) throw new Error('campaignId required');

    let declared = [];
    try {
        const res = await axios.get(`${BASE_URL}/campaigns/${campaignId}`, {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 15000,
        });
        declared = res.data?.custom_variables || res.data?.variables || [];
        if (!Array.isArray(declared)) declared = [];
    } catch (_) { /* fall back to defaults below */ }

    // Always include the variables our pipeline KNOWS how to fill. Operator
    // can extend via the UI; we never drop a default to avoid silently breaking
    // existing email templates.
    const merged = new Set([...declared, ...DEFAULT_CUSTOM_VARIABLE_KEYS]);
    return Array.from(merged);
}

// The exact custom-variable keys this pipeline sends to Instantly today. The
// mapping editor uses this as the canonical list of variables the operator
// can re-map. (Order matters for UI display.)
const DEFAULT_CUSTOM_VARIABLE_KEYS = [
    // Job-level
    'job_url', 'job_title', 'date_added',
    'dev_or_eng', 'dev_or_engineer', 'adev_anengineer',
    'imagined_city', 'imagined_nearby_city', 'imagined_industry',
    'sap_modules', 'sap_skills_comma',
    'shorter_tech_description', 'longer_tech_description',
    'shorter_tech_comma', 'comma_tech_description', 'top_job_tech_comma',
    'shorter_tech_description_scrambled',
    'tech_compressed', 'tech_names_person_type',
    'primary_tech',
    'quality_score', 'ctr_fit',
    // Company-level
    'company_website', 'company_domain', 'company_linkedin',
    'company_hq_city', 'company_employee_count', 'company_description',
    // Contact-level
    'First Name', 'salutation',
    'contact_title', 'contact_city', 'contact_country',
    'linkedin_url', 'recipient_linkedin_url',
];

// Names of the FIXED (non-custom) Instantly lead fields. Operator can re-map
// the source-of-value on these too (e.g. push contact.full_name as Instantly's
// first_name if they want), but the field name is fixed by Instantly.
const STANDARD_FIELDS = ['email', 'first_name', 'last_name', 'company_name', 'personalization'];

/**
 * Add a lead (contact) to an Instantly campaign.
 * This is the final action of Stage 8 — equivalent to Clay Table 3a → Instantly.
 *
 * Required fields in payload:
 *   email, first_name, last_name
 *
 * Custom variables (all the personalisation variables):
 *   salutation, job_title, sap_tech, sap_modules, dev_or_engineer,
 *   a_dev_or_engineer, primary_tech, company_name, company_domain,
 *   company_hq_city, contact_city, contact_title, top_job_url,
 *   top_job_tech_comma, company_employee_count
 */
async function addLead(campaignId, contact, jobContext, opts = {}) {
    if (!process.env.INSTANTLY_API_KEY) throw new Error('INSTANTLY_API_KEY not set');

    // opts.fieldMapping + opts.customVariableKeys flow through to the payload
    // builder so a saved connection's mapping overrides the default resolvers.
    const payload = buildInstantlyPayload(campaignId, contact, jobContext, opts);

    const res = await axios.post(
        `${BASE_URL}/leads`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
                'Content-Type': 'application/json',
            },
        }
    );
    return res.data;
}

/**
 * Add multiple leads in one call (Instantly supports batch).
 */
async function addLeadsBatch(campaignId, contacts, jobContext) {
    if (!process.env.INSTANTLY_API_KEY) throw new Error('INSTANTLY_API_KEY not set');

    const payloads = contacts.map(c => buildInstantlyPayload(campaignId, c, jobContext));

    const res = await axios.post(
        `${BASE_URL}/leads/bulk`,
        { leads: payloads },
        {
            headers: {
                Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
                'Content-Type': 'application/json',
            },
        }
    );
    return res.data;
}

/**
 * Default source-of-value for every (custom variable / standard field) → resolver.
 * The connection's `config.field_mapping` (if set) overrides any of these.
 *
 * Each resolver gets `(contact, job)` and returns the string the payload sends.
 * Keep returning strings — Instantly's lead API rejects non-string custom-var
 * values on some plans.
 */
const DEFAULT_RESOLVERS = {
    // ── Standard fields (Instantly's documented lead schema) ────────────────
    email:        (c)    => c.email,
    first_name:   (c)    => c.first_name,
    last_name:    (c)    => c.last_name,
    company_name: (c, j) => j.company_name || c.company_name,
    personalization: (c) => c.salutation || '',

    // ── Custom variables (every key the email templates can reference) ─────
    'First Name':                        (c) => c.first_name,
    job_url:                             (c, j) => j.job_url,
    job_title:                           (c, j) => j.job_title,
    date_added:                          (c)    => (c.created_at ? new Date(c.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]),
    dev_or_eng:                          (c, j) => j.dev_or_eng,
    dev_or_engineer:                     (c, j) => j.dev_or_engineer,
    adev_anengineer:                     (c, j) => j.a_dev_or_engineer,
    linkedin_url:                        (c)    => c.person_linkedin_url || c.linkedin_url,
    recipient_linkedin_url:              (c)    => c.li_merged || c.linkedin_url_merged || c.person_linkedin_url,
    imagined_city:                       (c, j) => j.imagined_city,
    imagined_nearby_city:                (c, j) => j.imagined_nearby_city,
    imagined_industry:                   (c, j) => j.imagined_industry,
    sap_modules:                         (c, j) => j.sap_modules,
    sap_skills_comma:                    (c, j) => j.sap_skills_comma,
    shorter_tech_description:            (c, j) => j.shorter_tech_description || j.tech_short,
    shorter_tech_description_scrambled:  (c, j) => j.shorter_tech_description_scrambled,
    longer_tech_description:             (c, j) => j.tech_longer,
    shorter_tech_comma:                  (c, j) => j.top_job_tech_comma,
    comma_tech_description:              (c, j) => j.top_job_tech_comma,
    top_job_tech_comma:                  (c, j) => j.top_job_tech_comma,
    tech_compressed:                     (c, j) => j.tech_compressed,
    tech_names_person_type:              (c, j) => j.tech_short2,
    primary_tech:                        (c, j) => j.primary_tech || 'SAP',
    quality_score:                       (c, j) => String(j.quality_score || ''),
    ctr_fit:                             (c, j) => j.ctr_fit,
    salutation:                          (c)    => c.salutation,
    contact_title:                       (c)    => c.title,
    contact_city:                        (c)    => c.city,
    contact_country:                     (c)    => c.country,
    company_website:                     (c, j) => j.company_url || j.company_domain,
    company_domain:                      (c, j) => j.company_domain,
    company_linkedin:                    (c, j) => j.company_linkedin_url,
    company_hq_city:                     (c, j) => j.company_hq_city,
    company_employee_count:              (c, j) => String(j.company_employee_count || ''),
    company_description:                 (c, j) => (j.company_description || '').slice(0, 300),
    a_dev_or_engineer:                   (c, j) => j.a_dev_or_engineer,
};

/**
 * Apply a `field_mapping` saved on a connection's config.
 *
 * Mapping shape:
 *   { "Instantly field name": "pipeline source", ... }
 *
 * Where "pipeline source" is one of:
 *   - "contact.email"        → contact.email
 *   - "job.company_url"      → job.company_url
 *   - "contact.title"        → contact.title
 *   - "literal:Some text"    → constant string
 *
 * Returns the resolved string for a single target field. If the mapping has no
 * entry, falls back to DEFAULT_RESOLVERS[target] (i.e. the value we send today).
 */
function resolveMapped(target, contact, job, fieldMapping) {
    const mapped = fieldMapping?.[target];
    if (mapped) {
        if (typeof mapped === 'string') {
            if (mapped.startsWith('literal:')) return mapped.slice('literal:'.length);
            if (mapped.startsWith('contact.')) return contact[mapped.slice('contact.'.length)];
            if (mapped.startsWith('job.'))     return job[mapped.slice('job.'.length)];
            // Otherwise treat as a literal
            return mapped;
        }
    }
    const fn = DEFAULT_RESOLVERS[target];
    return fn ? fn(contact, job) : null;
}

/**
 * Assemble a complete Instantly lead payload from a contact row + job context.
 * `opts.fieldMapping` (optional) overrides per-field source-of-value — saved
 * on the Instantly connection's config by the dashboard.
 */
function buildInstantlyPayload(campaignId, contact, job, opts = {}) {
    const fieldMapping = opts.fieldMapping || null;
    // Which custom variables to emit. If the connection saved a list (matching
    // what the operator declared on the Instantly campaign), use that; else
    // emit the full default set.
    const variableKeys = opts.customVariableKeys && opts.customVariableKeys.length
        ? opts.customVariableKeys
        : DEFAULT_CUSTOM_VARIABLE_KEYS;

    // NOTE: Instantly v2 API expects the field name `campaign` (UUID), NOT
    // `campaign_id`. If you send `campaign_id` it gets silently ignored and the
    // lead is created in the workspace but assigned to NO campaign — the lead
    // shows up via GET /leads but never inside the campaign's lead list, and
    // the email sequence never fires. Confirmed against the v2 docs + a live
    // test where the API returned 200 + a lead id but the campaign list was
    // empty. Send both keys for safety (some legacy plans may still read _id).
    const resolvedCampaign = campaignId || opts.campaignId || process.env.INSTANTLY_CAMPAIGN_ID;
    const standard = {
        campaign:             resolvedCampaign,
        campaign_id:          resolvedCampaign,
        email:                resolveMapped('email',        contact, job, fieldMapping),
        first_name:           resolveMapped('first_name',   contact, job, fieldMapping),
        last_name:            resolveMapped('last_name',    contact, job, fieldMapping),
        company_name:         resolveMapped('company_name', contact, job, fieldMapping),
        skip_if_in_workspace: true,
        personalization:      resolveMapped('personalization', contact, job, fieldMapping) || '',
    };

    const custom = {};
    for (const k of variableKeys) {
        const v = resolveMapped(k, contact, job, fieldMapping);
        custom[k] = v == null ? '' : String(v);
    }

    return { ...standard, custom_variables: custom };
}

// Legacy hard-coded payload builder kept for reference; not used anymore.
// eslint-disable-next-line no-unused-vars
function _legacyBuildInstantlyPayload(campaignId, contact, job) {
    const dateAdded = contact.created_at
        ? new Date(contact.created_at).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

    return {
        campaign_id:          campaignId || process.env.INSTANTLY_CAMPAIGN_ID,
        email:                contact.email,
        first_name:           contact.first_name,
        last_name:            contact.last_name,
        company_name:         job.company_name || contact.company_name,
        skip_if_in_workspace: true,
        personalization:      contact.salutation || '',
        custom_variables: {
            // ── The 20 Instantly campaign variables (exact names) ──────────────
            job_url:                             job.job_url,
            job_title:                           job.job_title,
            'First Name':                        contact.first_name,
            date_added:                          dateAdded,
            dev_or_eng:                          job.dev_or_eng,
            linkedin_url:                        contact.person_linkedin_url || contact.linkedin_url,
            imagined_city:                       job.imagined_city,
            adev_anengineer:                     job.a_dev_or_engineer,
            company_website:                     job.company_url || job.company_domain,
            dev_or_engineer:                     job.dev_or_engineer,
            sap_skills_comma:                    job.sap_skills_comma,
            imagined_industry:                   job.imagined_industry,
            shorter_tech_comma:                  job.top_job_tech_comma,
            imagined_nearby_city:                job.imagined_nearby_city,
            comma_tech_description:              job.top_job_tech_comma,
            recipient_linkedin_url:              contact.li_merged || contact.linkedin_url_merged || contact.person_linkedin_url,
            tech_names_person_type:              job.tech_short2,
            longer_tech_description:             job.tech_longer,
            shorter_tech_description:            job.shorter_tech_description || job.tech_short,
            shorter_tech_description_scrambled:  job.shorter_tech_description_scrambled,
            // ── Supporting fields ──────────────────────────────────────────────
            salutation:              contact.salutation,
            contact_title:           contact.title,
            contact_city:            contact.city,
            contact_country:         contact.country,
            sap_modules:             job.sap_modules,
            tech_compressed:         job.tech_compressed,
            top_job_tech_comma:      job.top_job_tech_comma,
            primary_tech:            job.primary_tech || 'SAP',
            a_dev_or_engineer:       job.a_dev_or_engineer,
            company_domain:          job.company_domain,
            company_linkedin:        job.company_linkedin_url,
            company_hq_city:         job.company_hq_city,
            company_employee_count:  String(job.company_employee_count || ''),
            company_description:     (job.company_description || '').slice(0, 300),
            quality_score:           String(job.quality_score || ''),
            ctr_fit:                 job.ctr_fit,
        },
    };
}

/**
 * Validate that all required Instantly fields are present before sending.
 * Returns { valid: boolean, missing: string[] }
 */
function validatePayload(contact, job) {
    const missing = [];
    // Standard fields
    if (!contact.email)         missing.push('email');
    if (!contact.first_name)    missing.push('first_name');
    if (!contact.last_name)     missing.push('last_name');
    if (!contact.salutation)    missing.push('salutation');
    if (!job.company_name && !contact.company_name) missing.push('company_name');
    // Required Instantly custom variables
    if (!job.job_title)         missing.push('job_title');
    if (!job.job_url)           missing.push('job_url');
    if (!job.dev_or_engineer)   missing.push('dev_or_engineer');
    if (!job.tech_longer && !job.tech_short) missing.push('longer_tech_description');
    if (!job.tech_short2 && !job.tech_short) missing.push('tech_names_person_type');
    return { valid: missing.length === 0, missing };
}

module.exports = {
    // Lead operations
    addLead, addLeadsBatch, buildInstantlyPayload, validatePayload,
    // Dynamic discovery (Connections UI uses these)
    fetchCampaigns, fetchCustomVariables,
    // Schema constants (Connections UI uses these to render the mapping editor)
    DEFAULT_CUSTOM_VARIABLE_KEYS, STANDARD_FIELDS,
    // Resolver helper (so other modules can preview a payload without sending)
    resolveMapped, DEFAULT_RESOLVERS,
};
