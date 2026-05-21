/**
 * RecruiterFlow CRM — HTTP wrapper
 *
 * Endpoints (all POST):
 *   /client/add       — create company
 *   /client/search    — dedup lookup (by name or linkedin)
 *   /contact/add      — create contact (300/min rate limit)
 *   /job/add          — create job (requires client_id)
 *
 * Auth: RF-Api-Key header
 * Env vars:
 *   RECRUITERFLOW_API_KEY      — production key (rotate after setup)
 *   RECRUITERFLOW_USER_ID      — Bhanu's RF user (264375)
 */
const axios  = require('axios');
const Logger = require('../Logger');

const logger   = new Logger('RecruiterFlow');
const BASE_URL = 'https://recruiterflow.com/api/external';

function getHeaders() {
    const key = process.env.RECRUITERFLOW_API_KEY || '';
    if (!key) throw new Error('RECRUITERFLOW_API_KEY not set in .env');
    return { 'RF-Api-Key': key, 'content-type': 'application/json' };
}

function rfUserId() {
    return parseInt(process.env.RECRUITERFLOW_USER_ID || '264375', 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * POST to a RecruiterFlow endpoint with exponential-backoff retry.
 * retryOn: HTTP status codes that should be retried.
 */
async function rfPost(path, body, { maxRetries = 3, retryOn = [429, 501, 502, 503] } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await axios.post(`${BASE_URL}${path}`, body, {
                headers: getHeaders(),
                timeout: 20000,
            });
            return res.data;
        } catch (err) {
            const status = err.response?.status;
            const body   = err.response?.data;
            lastErr = Object.assign(
                new Error(body?.message || err.message || `HTTP ${status}`),
                { httpStatus: status, rfBody: body }
            );
            if (status && !retryOn.includes(status)) throw lastErr;
            if (attempt < maxRetries) await sleep(Math.pow(2, attempt) * 1200);
        }
    }
    throw lastErr;
}

// ── Company ───────────────────────────────────────────────────────────────────

/**
 * Search for an existing RF company by name.
 * Returns { found, clientId } — clientId is set only when found.
 */
async function lookupCompanyByName(name) {
    if (!name?.trim()) return { found: false };
    try {
        const res = await rfPost('/client/search', {
            conjunction:   'match-all',
            current_page:  1,
            items_per_page: 5,
            include_count:  true,
            filters: [{ conjunction: 'in', key: 'name', name: 'Name', values: [name.trim()] }],
        }, { maxRetries: 1, retryOn: [429, 503] });

        const items = res?.items || res?.clients || res?.data || [];
        if (items.length > 0) return { found: true, clientId: items[0].id };
        return { found: false };
    } catch (err) {
        logger.warn('RF company lookup by name failed (non-fatal)', { error: err.message });
        return { found: false };
    }
}

/**
 * Search for an existing RF company by LinkedIn URL.
 */
async function lookupCompanyByLinkedin(linkedinUrl) {
    if (!linkedinUrl?.trim()) return { found: false };
    try {
        const res = await rfPost('/client/search', {
            conjunction:    'match-all',
            current_page:   1,
            items_per_page: 5,
            include_count:  true,
            filters: [{ conjunction: 'in', key: 'linkedin_profile', name: 'LinkedIn Profile', values: [linkedinUrl.trim()] }],
        }, { maxRetries: 1, retryOn: [429, 503] });

        const items = res?.items || res?.clients || res?.data || [];
        if (items.length > 0) return { found: true, clientId: items[0].id };
        return { found: false };
    } catch (err) {
        logger.warn('RF company lookup by linkedin failed (non-fatal)', { error: err.message });
        return { found: false };
    }
}

/**
 * Create a new company (client) in RecruiterFlow.
 * Returns { id, ... } from RF response.
 */
async function createCompany({ name, domain, linkedin_page, location, employee_count }) {
    const body = {
        added_by:      rfUserId(),
        lead_owner_id: rfUserId(),
        name:          name || '',
        domain:        domain || '',
    };
    if (linkedin_page)              body.linkedin_page = linkedin_page;
    if (location)                   body.location      = location;
    if (employee_count != null)     body.custom_fields = [{ id: 2, value: employee_count }];

    return rfPost('/client/add', body, { maxRetries: 5, retryOn: [429, 501, 502, 503] });
}

/**
 * Fetch a single client_company by id, returning enriched fields.
 * Used by Stage 2 to skip live Proxycurl/Apollo when the company is already in RF.
 * Returns the raw RF object on success, null on 404/error.
 */
async function getCompany(clientId) {
    if (!clientId) return null;
    try {
        const res = await axios.get(`${BASE_URL}/client/${clientId}`, {
            headers: getHeaders(), timeout: 15000,
        });
        return res.data?.data || res.data || null;
    } catch (err) {
        if (err.response?.status === 404) return null;
        logger.warn('RF getCompany failed', { id: clientId, error: err.message });
        return null;
    }
}

/**
 * List contacts attached to a given client_company.
 * Used by Stage 4 to harvest existing RF contacts (with emails) for a company
 * before paying Apollo for fresh search.
 */
async function listCompanyContacts(clientId, { limit = 50 } = {}) {
    if (!clientId) return [];
    try {
        const res = await axios.post(`${BASE_URL}/contact/search`, {
            conjunction:    'match-all',
            current_page:   '1',
            items_per_page: String(limit),
            include_count:  true,
            filters: [{
                conjunction: 'in', key: 'client_company_id',
                name: 'Client Company', values: [clientId],
            }],
        }, { headers: getHeaders(), timeout: 20000 });
        return res.data?.items || res.data?.contacts || res.data?.data || [];
    } catch (err) {
        logger.warn('RF listCompanyContacts failed', { id: clientId, error: err.message });
        return [];
    }
}

/**
 * Find a contact's email inside a given client_company by matching either
 * LinkedIn URL or first+last name. Returns the email string, or null when
 * nothing matched. Used by Stage 5's email waterfall ("CRM" step).
 *
 *   const r = await RF.findContactEmailInCompany(rfClientId, {
 *     linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
 *     firstName:   'Jane', lastName: 'Doe',
 *   });
 *   // → { email: 'jane@acme.de', source: 'crm', contactId: 999 }  or null
 */
async function findContactEmailInCompany(clientId, { linkedinUrl, firstName, lastName } = {}) {
    if (!clientId) return null;
    const rfContacts = await listCompanyContacts(clientId, { limit: 100 });
    if (!rfContacts.length) return null;

    const normLi  = linkedinUrl ? linkedinUrl.toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '') : null;
    const normFn  = firstName ? firstName.toLowerCase().trim() : null;
    const normLn  = lastName  ? lastName.toLowerCase().trim()  : null;

    const matchedByLi = normLi && rfContacts.find(c => {
        const li = (c.linkedin_profile || c.linkedin_url || c.linkedin || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
        return li && (li === normLi || li.endsWith(normLi) || normLi.endsWith(li));
    });
    const matched = matchedByLi || (normFn && normLn && rfContacts.find(c => {
        const fn = (c.first_name || c.firstName || '').toLowerCase().trim();
        const ln = (c.last_name  || c.lastName  || '').toLowerCase().trim();
        return fn && ln && fn === normFn && ln === normLn;
    }));

    if (!matched) return null;

    // Email shape on RF can be array-of-objects or a string — handle both
    const email = Array.isArray(matched.email) && matched.email.length
        ? (matched.email.find(e => e.is_primary === 1 || e.is_primary === true)?.email || matched.email[0]?.email)
        : matched.email || matched.work_email || null;

    if (!email) return null;
    return { email, source: 'crm', contactId: matched.id, matchedBy: matchedByLi ? 'linkedin' : 'name' };
}

// ── Contact ───────────────────────────────────────────────────────────────────

/**
 * Search for an existing RF contact by email.
 * Returns { found, contactId } — contactId set only when found.
 */
async function lookupContactByEmail(email) {
    if (!email?.trim()) return { found: false };
    try {
        const res = await rfPost('/contact/search', {
            conjunction:    'match-all',
            current_page:   '1',
            items_per_page: '5',
            include_count:  true,
            filters: [{ conjunction: 'in', key: 'email', name: 'Email', values: [email.trim()] }],
        }, { maxRetries: 1, retryOn: [429, 503] });

        const items = res?.items || res?.contacts || res?.data || [];
        if (items.length > 0) return { found: true, contactId: items[0].id };
        return { found: false };
    } catch (err) {
        logger.warn('RF contact lookup by email failed (non-fatal)', { error: err.message });
        return { found: false };
    }
}

/**
 * Create a contact in RecruiterFlow.
 *
 * BUG FIX (vs. original Clay flow): phone_number array is OMITTED entirely
 * when all entries are empty.  The original Clay config sends [{phone:"",type:1},...]
 * causing RF to return HTTP 400 for every contact push.
 */
async function createContact({ first_name, last_name, email, title, linkedin_profile,
                               client_company, organization, phone_numbers = [] }) {
    const body = {
        first_name:     first_name    || '',
        last_name:      last_name     || '',
        email:          [{ email, is_primary: 1 }],
        title:          title         || '',
        client_company: client_company || '',
        organization:   organization   || '',
    };
    if (linkedin_profile) body.linkedin_profile = linkedin_profile;

    // Only include phone_number array when at least one number is non-empty
    const validPhones = phone_numbers.filter(p => p.number?.trim());
    if (validPhones.length > 0) {
        body.phone_number = validPhones.map(p => ({ phone_number: p.number, type: p.type || 1 }));
    }

    return rfPost('/contact/add', body, { maxRetries: 3, retryOn: [] });
}

// ── Location ──────────────────────────────────────────────────────────────────

// Simple in-process cache so we don't refetch locations per job
let _locationCache = null;

async function _getLocations() {
    if (_locationCache) return _locationCache;
    try {
        const res = await axios.get(`${BASE_URL}/location/list`, {
            headers: getHeaders(), timeout: 15000,
        });
        _locationCache = res.data?.data || [];
    } catch (_) {
        _locationCache = [];
    }
    return _locationCache;
}

/**
 * Find an RF location ID that matches city (case-insensitive).
 * Creates a new location if none found.
 * Returns a location ID integer, or null if city/country both absent.
 */
async function getOrCreateLocation(city, country) {
    if (!city && !country) return null;

    const locations = await _getLocations();
    const needle = (city || country || '').toLowerCase();
    const existing = locations.find(l =>
        (l.city || '').toLowerCase() === needle ||
        (l.name || '').toLowerCase() === needle ||
        (l.name || '').toLowerCase().startsWith(needle)
    );
    if (existing) return existing.id;

    // Create new location
    try {
        const res = await rfPost('/location/create', {
            name:    city || country,
            city:    city    || '',
            country: country || '',
        }, { maxRetries: 2, retryOn: [429, 503] });
        const newId = res?.data?.id || res?.id || null;
        if (newId && Array.isArray(_locationCache)) {
            _locationCache.push({ id: newId, city: city || '', name: city || country, country: country || '' });
        }
        return newId;
    } catch (_) {
        return null;
    }
}

// ── Job ───────────────────────────────────────────────────────────────────────

/**
 * Create a job in RecruiterFlow.
 * Requires client_company_id — must create/look up company first.
 *
 * Endpoint: /job/create
 * Body fields: title, about_position, client_company_id, created_by,
 *              employment_type_id, department_id, locations, skills, tags,
 *              job_status_id.
 *
 * @param {object}   p
 * @param {number}   p.client_id        RF client_company_id
 * @param {string}   p.name             Job title
 * @param {string}   p.url              Job posting URL (appended to about_position)
 * @param {string}   p.description      Long-form description
 * @param {string}   p.country
 * @param {string}   p.city
 * @param {string[]} [p.skills=[]]
 * @param {string[]} [p.tags=[]]        Pipeline always sends ['Job Advert'].
 * @param {number}   [p.job_status_id]  RF custom job-status id. The "Job Advert"
 *                                      status is id=2 on the CTR tenant.
 *                                      Set via env RECRUITERFLOW_JOB_STATUS_ID.
 */
async function createJob({
    client_id, name, url, description, country, city,
    skills = [], tags = [],
}) {
    if (!client_id) throw new Error('createJob: client_id is required');

    // Append url to description (RF job/create has no url field)
    let about = description || '';
    if (url) about = about ? `${about}\n\nJob URL: ${url}` : `Job URL: ${url}`;

    // Resolve city → location ID (RF requires locations array)
    const locationId = await getOrCreateLocation(city, country);

    const body = {
        created_by:         rfUserId(),
        client_company_id:  client_id,
        title:              name        || '',
        about_position:     about.slice(0, 10000),
        employment_type_id: 1,  // 1=Full time
        department_id:      1,  // 1=Admin (catch-all)
        locations:          locationId ? [locationId] : [],
    };
    if (skills.length) body.skills = skills;
    if (tags.length)   body.tags   = tags;
    // NOTE: contact_ids and job_status_id are NOT sent here — RF either rejects
    // or silently ignores them on /job/create. Use updateJob() right after to
    // set both in one /job/update call.

    return rfPost('/job/create', body, { maxRetries: 5, retryOn: [429, 501, 502, 503] });
}

/**
 * Update an existing RF job. Used right after createJob to set fields that
 * /job/create won't accept: contact_ids (job ↔ contact linkage) and
 * job_status_id (custom job-status like "Job Advert" id=2).
 *
 * @param {number}   jobId
 * @param {object}   fields  Any subset of: contact_ids (int[]), job_status_id (int),
 *                           tags (string[]), title, about_position, …
 *                           contact_ids are auto-coerced to integers — RF rejects
 *                           strings with "Please provide contact IDs in integer format."
 */
async function updateJob(jobId, fields = {}) {
    if (!jobId) throw new Error('updateJob: jobId required');
    const body = { job_id: Number(jobId), ...fields };
    if (Array.isArray(body.contact_ids)) {
        body.contact_ids = body.contact_ids.map(n => Number(n)).filter(Number.isFinite);
    }
    if (body.job_status_id != null) body.job_status_id = Number(body.job_status_id);
    return rfPost('/job/update', body, { maxRetries: 2, retryOn: [429, 503] });
}

/**
 * Thin wrapper around updateJob for the common case of attaching a single
 * contact to an existing job. Kept for back-compat with CRMPush; new code
 * should call updateJob({ contact_ids: [...] }) directly.
 */
async function addJobContact(jobId, contactId) {
    if (!jobId || !contactId) throw new Error('addJobContact: jobId and contactId required');
    const res = await updateJob(jobId, { contact_ids: [Number(contactId)] });
    return { path: '/job/update', body: { job_id: jobId, contact_ids: [Number(contactId)] }, response: res };
}

module.exports = {
    lookupCompanyByName,
    lookupCompanyByLinkedin,
    lookupContactByEmail,
    findContactEmailInCompany,
    getCompany,
    listCompanyContacts,
    createCompany,
    createContact,
    createJob,
    updateJob,
    addJobContact,
    getOrCreateLocation,
};
