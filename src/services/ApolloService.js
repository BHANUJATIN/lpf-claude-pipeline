/**
 * ApolloService — Apollo.io REST client.
 *
 * Endpoint reference:
 *   - mixed_people/search        (people search, consumes search credits)
 *   - mixed_companies/search     (org search, consumes search credits)
 *   - people/match               (enrich a person, 1 credit on email reveal)
 *   - organizations/enrich       (enrich a company, 1 credit on match)
 *
 * Auth: x-api-key header. The legacy `api_key` body field still works on most
 * endpoints but is deprecated — header is the documented form.
 *
 * Credit gating: Apollo now returns HTTP 422 with body
 *   { "error": "You have insufficient credits! …" }
 * on EVERY paid endpoint when the account is out of credits. We surface that as
 * an ApolloCreditError so callers can show a clear message instead of silently
 * recording "0 results". After the first credit failure we trip a process-wide
 * circuit breaker so we don't waste rate-limit budget hammering a dead account.
 */
const axios       = require('axios');
const costTracker = require('./CostTrackerService');
const Logger      = require('../Logger');

const logger   = new Logger('ApolloService');
const BASE_URL = 'https://api.apollo.io/v1';

// ── Typed error + circuit breaker ────────────────────────────────────────────

class ApolloCreditError extends Error {
    constructor(message, opts = {}) {
        super(message || 'Apollo: insufficient credits');
        this.name        = 'ApolloCreditError';
        this.code        = 'APOLLO_INSUFFICIENT_CREDITS';
        this.status      = 422;
        this.providerMsg = opts.providerMsg || null;
        this.endpoint    = opts.endpoint    || null;
    }
}

// Process-wide breaker. Once tripped, subsequent Apollo calls return empty
// results without making network requests. Cleared on process restart.
let _creditBreakerTrippedAt = null;
function isCreditBreakerTripped() {
    return _creditBreakerTrippedAt !== null;
}
function tripCreditBreaker(providerMsg) {
    if (_creditBreakerTrippedAt) return;
    _creditBreakerTrippedAt = new Date();
    logger.error(
        `Apollo credit breaker TRIPPED — all further Apollo calls in this process will short-circuit. Provider message: ${providerMsg || '(none)'}`,
        { tripped_at: _creditBreakerTrippedAt.toISOString() }
    );
}
function resetCreditBreaker() { _creditBreakerTrippedAt = null; }
function getBreakerStatus() {
    return {
        tripped:    Boolean(_creditBreakerTrippedAt),
        tripped_at: _creditBreakerTrippedAt ? _creditBreakerTrippedAt.toISOString() : null,
    };
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

function headers() {
    return {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-cache',
        'accept':        'application/json',
        'x-api-key':     process.env.APOLLO_API_KEY,
    };
}

/**
 * Wrap an axios POST so that:
 *   - 422 "insufficient credits" trips the breaker and throws ApolloCreditError
 *   - Other failures log the full response body (not just axios's generic message)
 *   - Caller sees a real Error with `.status` and `.providerBody` attached
 */
async function apolloPost(endpoint, body) {
    if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY not set');
    if (isCreditBreakerTripped()) {
        throw new ApolloCreditError('Apollo credit breaker is tripped — skipping call', { endpoint });
    }

    try {
        const res = await axios.post(`${BASE_URL}${endpoint}`, body, { headers: headers() });
        return res.data;
    } catch (err) {
        const status = err.response?.status;
        const data   = err.response?.data;
        const msg    = (data && (data.error || data.message)) || err.message;

        // Credit gate — surface clearly and trip breaker
        if (status === 422 && typeof msg === 'string' && /insufficient credit/i.test(msg)) {
            tripCreditBreaker(msg);
            throw new ApolloCreditError(msg, { providerMsg: msg, endpoint });
        }

        // Annotate every other failure with provider context
        const wrapped = new Error(`Apollo ${endpoint} failed (HTTP ${status || 'n/a'}): ${msg}`);
        wrapped.status        = status;
        wrapped.providerBody  = data;
        wrapped.endpoint      = endpoint;
        wrapped.original      = err;
        logger.warn(`Apollo ${endpoint} failed`, { status, body: typeof data === 'object' ? JSON.stringify(data).slice(0, 500) : String(data || '').slice(0, 500) });
        throw wrapped;
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Search for people at a company by title keywords and employee count range.
 * Mirrors LPF Table 2a Apollo columns (HR, CEO, Tech searches).
 *
 * @param {object} opts
 * @param {string[]} opts.domains           Company domains e.g. ['acme.de']
 * @param {string[]} opts.personTitles      Title keywords
 * @param {string}   opts.employeeRange     e.g. '9,350' (min,max)
 * @param {number}   opts.perPage           Results per page (default 10)
 * @param {number}   [opts.jobId]           For cost tracking
 * @param {string}   [opts.operation]       Cost tracking label
 */
async function searchPeople({ domains, personTitles, employeeRange, perPage = 10, jobId, operation }) {
    const body = {
        q_organization_domains: domains,
        person_titles:          personTitles,
        per_page:               perPage,
        // NOTE: `contact_email_status_v2` was a deprecated/invalid field that was
        // silently filtering all results. Use `contact_email_status` with the
        // canonical values when needed. Leaving it off returns the broadest set.
    };

    if (employeeRange) {
        body.organization_num_employees_ranges = [employeeRange];
    }

    const data   = await apolloPost('/mixed_people/search', body);
    const people = data?.people || [];

    costTracker.logApollo({
        jobId:     jobId     || null,
        operation: operation || 'people_search',
        credits:   0,
        metadata:  { domains, titles: personTitles?.slice(0, 3), results: people.length, pagination: data?.pagination },
    }).catch(() => {});

    return people;
}

/**
 * Harvest contacts from your Apollo account's existing contact database
 * (`/v1/contacts/search` — credit-free, scoped to whatever you've previously
 * searched/imported into Apollo).
 *
 * Works when:
 *   - The target company has been searched into the account before. Today the
 *     account has ~1.3M harvested contacts.
 * Doesn't work when:
 *   - Brand-new company we've never queried (returns 0).
 *
 * Filter rules (confirmed via probing):
 *   - `q_organization_domains` is IGNORED here. Use q_organization_name instead.
 *   - `q_organization_name` is the strongest filter (substring match).
 *   - `q_keywords` is a broader full-text fallback (e.g. `@domain.com`).
 *   - `person_titles` + `person_locations` + `contact_email_status` all work.
 *
 * @param {object}  opts
 * @param {string}  [opts.companyName]     Preferred filter — substring of org name
 * @param {string}  [opts.domain]          Fallback keyword search `@domain.com`
 * @param {string[]}[opts.personTitles]
 * @param {string[]}[opts.personLocations] e.g. ['Germany','Austria','Switzerland']
 * @param {boolean} [opts.verifiedOnly]    If true, restrict to verified emails
 * @param {number}  [opts.perPage=25]
 * @param {number}  [opts.page=1]
 * @param {number}  [opts.jobId]
 * @param {string}  [opts.operation]
 */
async function harvestContacts({
    companyName,
    domain,
    personTitles,
    personLocations,
    verifiedOnly = false,
    perPage = 25,
    page = 1,
    jobId,
    operation,
}) {
    if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY not set');
    if (!companyName && !domain) return [];

    // Note: this endpoint is NOT gated by the credit breaker because it doesn't
    // consume search credits. Even when mixed_people/search returns 422, this
    // continues to work. We still skip if the API key is missing entirely.
    const body = { per_page: perPage, page };
    if (companyName)            body.q_organization_name   = companyName;
    else if (domain)            body.q_keywords            = `@${cleanDomainForKeyword(domain)}`;
    if (personTitles?.length)   body.person_titles         = personTitles;
    if (personLocations?.length) body.person_locations     = personLocations;
    if (verifiedOnly)           body.contact_email_status  = ['verified'];

    try {
        const res  = await axios.post(`${BASE_URL}/contacts/search`, body, { headers: headers() });
        const data = res.data || {};
        const contacts = data.contacts || [];

        // Free — no credit consumption
        costTracker.logApollo({
            jobId:     jobId     || null,
            operation: operation || 'harvest_contacts',
            credits:   0,
            metadata:  {
                companyName, domain, titles: personTitles?.slice(0, 3),
                returned:  contacts.length,
                total:     data.pagination?.total_entries,
                page:      data.pagination?.page,
            },
        }).catch(() => {});

        return contacts;
    } catch (err) {
        // Unlike mixed_people/search, this endpoint shouldn't 422 on credits.
        // If it does, surface as a normal provider error (don't trip the breaker).
        const status = err.response?.status;
        const msg    = err.response?.data?.error || err.message;
        logger.warn(`Apollo /contacts/search failed`, { status, msg, companyName, domain });
        const wrapped = new Error(`Apollo /contacts/search failed (HTTP ${status || 'n/a'}): ${msg}`);
        wrapped.status       = status;
        wrapped.providerBody = err.response?.data;
        throw wrapped;
    }
}

function cleanDomainForKeyword(d) {
    if (!d) return '';
    try {
        const u = d.includes('://') ? d : 'https://' + d;
        return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
        return String(d).replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '').toLowerCase();
    }
}

/**
 * Find a specific person's email via Apollo Harvest (the credit-free
 * /v1/contacts/search pool). Filters by full name + company name client-side.
 *
 * Stage 5 calls this when:
 *   - The contact has no LinkedIn URL (so Findymail by LinkedIn won't work)
 *   - Findymail by name+domain returned no match (often because the operator
 *     sent us a synthetic test domain)
 *
 * Returns { email, source: 'apollo_harvest', confidence } or null.
 */
async function harvestEmailByName({ firstName, lastName, companyName, jobId, operation }) {
    if (!process.env.APOLLO_API_KEY) return null;
    if (!firstName || !lastName || !companyName) return null;

    try {
        // Pull up to 25 matching the company; we then match by name client-side.
        const rows = await harvestContacts({
            companyName,
            perPage:  25,
            jobId,
            operation: operation || 'harvest_email_by_name',
        });
        const fnLower = firstName.toLowerCase().trim();
        const lnLower = lastName.toLowerCase().trim();
        const exact = rows.find(c => {
            const fn = (c.first_name || '').toLowerCase().trim();
            const ln = (c.last_name  || '').toLowerCase().trim();
            return fn === fnLower && ln === lnLower;
        });
        if (exact?.email && !exact.email.startsWith('email_not_unlocked')) {
            return { email: exact.email, source: 'apollo_harvest', confidence: 'high', linkedin_url: exact.linkedin_url };
        }
        // Loose match — first name + last name as substrings (handles "Dr." prefixes etc.)
        const loose = rows.find(c => {
            const full = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
            return full.includes(fnLower) && full.includes(lnLower);
        });
        if (loose?.email && !loose.email.startsWith('email_not_unlocked')) {
            return { email: loose.email, source: 'apollo_harvest', confidence: 'loose', linkedin_url: loose.linkedin_url };
        }
        return null;
    } catch (err) {
        logger.warn('Apollo harvest-by-name failed (non-fatal)', { firstName, lastName, companyName, error: err.message });
        return null;
    }
}

/**
 * Map a `/contacts/search` row to our pipeline contact shape. Note the
 * response shape is FLATTER than mixed_people/search:
 *   - `organization_name` is a string, not `organization.name`
 *   - `email_status` ('verified'|'extrapolated'|'unavailable') instead of contact_email_status
 *   - `linkedin_uid`, `present_raw_address`, `photo_url` available
 */
function normaliseHarvestContact(c, jobId, companyUrl, contactType) {
    const raw   = c.email || null;
    // Same gate as Apollo enrichment — never persist locked placeholders
    const email = (raw && !raw.startsWith('email_not_unlocked')) ? raw : null;
    return {
        job_id:              jobId,
        company_url:         companyUrl,
        company_name:        c.organization_name || c.account?.name || null,
        first_name:          c.first_name,
        last_name:           c.last_name,
        full_name:           c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email:               email,
        email_validated:     email != null && c.email_status === 'verified',
        email_source:        email ? 'apollo_harvest' : null,
        linkedin_url:        c.linkedin_url || null,
        linkedin_url_merged: c.linkedin_url || null,
        person_linkedin_url: c.linkedin_url || null,
        li_merged:           c.linkedin_url || null,
        title:               c.title || c.headline || null,
        city:                c.city || null,
        country:             c.country || null,
        is_dach:             isDACH(c.country),
        person_source:       'Apollo (harvested)',
        source:              'apollo_harvest',
        contact_type:        contactType,
        raw_data:            c,
    };
}

/**
 * Search people by company name + country location (fallback when domain not indexed).
 *
 * @param {string[]} [opts.locations]  Country names for person_locations filter.
 *                                     Defaults to all DACH if not provided.
 */
async function searchPeopleByName({ companyName, personTitles, perPage = 10, locations, jobId, operation }) {
    if (!companyName) return [];

    const personLocations = locations && locations.length
        ? locations
        : ['Germany', 'Austria', 'Switzerland', 'Deutschland', 'Österreich', 'Schweiz'];

    const data = await apolloPost('/mixed_people/search', {
        q_organization_name:  companyName,
        person_titles:        personTitles,
        person_locations:     personLocations,
        per_page:             perPage,
    });
    const people = data?.people || [];

    costTracker.logApollo({
        jobId:     jobId     || null,
        operation: operation || 'people_search_by_name',
        credits:   0,
        metadata:  { companyName, results: people.length, pagination: data?.pagination },
    }).catch(() => {});

    return people;
}

/**
 * Enrich a person by LinkedIn URL to get email.
 * Mirrors LPF Table 3a "Enrich Person" columns.
 */
async function enrichPerson(linkedinUrl, opts = {}) {
    if (!linkedinUrl) return null;

    const data = await apolloPost('/people/match', {
        linkedin_url:           linkedinUrl,
        reveal_personal_emails: false,
    });

    const person = data?.person || null;
    // 1 credit only when Apollo returns a real work email (not the email_not_unlocked placeholder)
    const hasRealEmail = Boolean(person?.email && !person.email.startsWith('email_not_unlocked'));
    costTracker.logApollo({
        jobId:     opts.jobId     || null,
        operation: opts.operation || 'enrich_person',
        credits:   hasRealEmail ? 1 : 0,
        metadata:  { linkedinUrl, hasEmail: hasRealEmail },
    }).catch(() => {});

    return person;
}

/**
 * Enrich a person by name + company domain.
 */
async function enrichByNameDomain(firstName, lastName, domain, opts = {}) {
    const data = await apolloPost('/people/match', {
        first_name:             firstName,
        last_name:              lastName,
        domain:                 domain,
        reveal_personal_emails: false,
    });

    const person = data?.person || null;
    const hasRealEmailND = Boolean(person?.email && !person.email.startsWith('email_not_unlocked'));
    costTracker.logApollo({
        jobId:     opts.jobId     || null,
        operation: opts.operation || 'enrich_by_name_domain',
        credits:   hasRealEmailND ? 1 : 0,
        metadata:  { firstName, lastName, domain, hasEmail: hasRealEmailND },
    }).catch(() => {});

    return person;
}

/**
 * Map an Apollo person object to our lpf_contacts shape.
 */
function normaliseApolloContact(person, jobId, companyUrl, contactType, source = 'apollo') {
    const raw   = person.email || person.contact?.email || null;
    // Apollo free plan returns this placeholder instead of real emails
    const email = (raw && !raw.startsWith('email_not_unlocked')) ? raw : null;
    return {
        job_id:              jobId,
        company_url:         companyUrl,
        company_name:        person.organization?.name || null,
        first_name:          person.first_name,
        last_name:           person.last_name,
        full_name:           person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
        email:               email,
        email_validated:     Boolean(email),
        email_source:        email ? 'apollo' : null,
        linkedin_url:        person.linkedin_url,
        linkedin_url_merged: person.linkedin_url,
        person_linkedin_url: person.linkedin_url,
        li_merged:           person.linkedin_url,
        title:               person.title,
        city:                person.city,
        country:             person.country,
        is_dach:             isDACH(person.country),
        person_source:       'Apollo',
        source,
        contact_type:        contactType,
        raw_data:            person,
    };
}

function isDACH(country) {
    if (!country) return false;
    const c = country.toLowerCase();
    return c.includes('germany') || c.includes('deutschland') ||
           c.includes('austria') || c.includes('österreich') ||
           c.includes('switzerland') || c.includes('schweiz') ||
           ['de', 'at', 'ch'].includes(c);
}

/**
 * Enrich a company by domain — replaces Proxycurl company profile.
 * Returns structured company data from Apollo's organization enrichment.
 */
async function enrichCompany(domain, opts = {}) {
    if (!domain) return null;

    const data = await apolloPost('/organizations/enrich', {
        domain: extractDomain(domain),
    });

    const org = data?.organization || null;
    // 1 credit when Apollo returns company data, 0 if not found
    costTracker.logApollo({
        jobId:     opts.jobId     || null,
        operation: opts.operation || 'enrich_company',
        credits:   org ? 1 : 0,
        metadata:  { domain, found: Boolean(org) },
    }).catch(() => {});

    return org;
}

/**
 * Map Apollo organization object to lpf_companies shape.
 */
function normaliseApolloCompany(org, companyUrl) {
    if (!org) return null;
    return {
        company_url:          companyUrl,
        company_linkedin_url: org.linkedin_url || null,
        company_name:         org.name || null,
        company_domain:       org.primary_domain || extractDomain(org.website_url),
        company_description:  org.short_description || null,
        company_industry:     org.industry || null,
        employee_count:       org.estimated_num_employees || null,
        dach_employees:       null,
        hq_city:              org.hq_address_city || null,
        hq_country:           org.hq_address_country || null,
    };
}

function extractDomain(url) {
    if (!url) return null;
    try {
        const normalized = url.includes('://') ? url : 'https://' + url;
        return new URL(normalized).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch (_) {
        return url.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '').toLowerCase() || null;
    }
}

module.exports = {
    searchPeople,
    searchPeopleByName,
    enrichPerson,
    enrichByNameDomain,
    normaliseApolloContact,
    enrichCompany,
    normaliseApolloCompany,
    // Credit-free "harvest" mode — searches the account's existing contact database
    harvestContacts,
    harvestEmailByName,
    normaliseHarvestContact,
    // Error class + breaker utilities so callers (Stage 4/5/6, /health, dashboard) can detect credit state
    ApolloCreditError,
    isCreditBreakerTripped,
    resetCreditBreaker,
    getBreakerStatus,
};
