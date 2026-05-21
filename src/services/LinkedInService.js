/**
 * LinkedIn data via Proxycurl API.
 * Replaces Clay's native LinkedIn integrations in:
 *   - Table 2a Col 11 (Get org LinkedIn data)
 *   - Table 2a Cols 21-27 (Find tech/CEO/SAP contacts via LinkedIn)
 *   - WB2.3 (job poster profile enrichment)
 */
const axios = require('axios');

const BASE_URL = 'https://nubela.co/proxycurl/api';

function headers() {
    if (!process.env.PROXYCURL_API_KEY) throw new Error('PROXYCURL_API_KEY not set');
    return { Authorization: `Bearer ${process.env.PROXYCURL_API_KEY}` };
}

/**
 * Fetch company profile from LinkedIn URL.
 * Returns: name, domain, employee_count, hq_city, hq_country, description, industry
 */
async function getCompanyProfile(linkedinUrl) {
    if (!linkedinUrl) return null;
    const res = await axios.get(`${BASE_URL}/linkedin/company`, {
        headers: headers(),
        params:  { url: linkedinUrl, resolve_numeric_id: 'true' },
    });
    return res.data || null;
}

/**
 * Fetch person profile from LinkedIn URL.
 * Used in Stage 6 (job poster extraction) and Stage 5 (contact enrichment).
 */
async function getPersonProfile(linkedinUrl) {
    if (!linkedinUrl) return null;
    const res = await axios.get(`${BASE_URL}/v2/linkedin`, {
        headers: headers(),
        params:  { url: linkedinUrl, extra: 'include', github_profile_id: 'exclude', facebook_profile_id: 'exclude' },
    });
    return res.data || null;
}

/**
 * Search for employees at a company by keyword/title.
 * Mirrors LPF Table 2a LinkedIn Find People columns (Cols 21-27).
 *
 * @param {string}   companyLinkedinUrl
 * @param {string}   keywordRegex       e.g. 'CTO|VP Engineering|Head of Technology'
 * @param {number}   pageSize
 */
async function searchCompanyEmployees(companyLinkedinUrl, keywordRegex, pageSize = 10) {
    if (!companyLinkedinUrl) return [];
    const res = await axios.get(`${BASE_URL}/v2/linkedin/company/employees/search`, {
        headers: headers(),
        params: {
            linkedin_company_profile_url: companyLinkedinUrl,
            keyword_regex:                keywordRegex,
            page_size:                    pageSize,
            resolve_numeric_id:           'true',
        },
    });
    return res.data?.employees || [];
}

/**
 * Normalise a Proxycurl company object to our lpf_companies shape.
 */
function normaliseCompany(data, companyUrl) {
    const hq = data.hq || {};
    return {
        company_url:          companyUrl,
        company_linkedin_url: data.linkedin_internal_id ? `https://www.linkedin.com/company/${data.linkedin_internal_id}` : null,
        company_name:         data.name,
        company_domain:       data.website ? extractDomain(data.website) : null,
        company_description:  data.description,
        company_industry:     data.industry,
        employee_count:       data.company_size_on_linkedin || null,
        dach_employees:       null,
        hq_city:              hq.city || null,
        hq_country:           hq.country || null,
    };
}

/**
 * Normalise a Proxycurl employee object to our lpf_contacts shape.
 */
function normaliseLinkedInContact(emp, jobId, companyUrl, contactType) {
    const profile = emp.profile || emp;
    return {
        job_id:              jobId,
        company_url:         companyUrl,
        company_name:        null,
        first_name:          profile.first_name,
        last_name:           profile.last_name,
        full_name:           profile.full_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
        email:               null,
        email_validated:     false,
        email_source:        null,
        linkedin_url:        profile.public_identifier
            ? `https://www.linkedin.com/in/${profile.public_identifier}`
            : emp.profile_url || null,
        linkedin_url_merged: emp.profile_url || null,
        person_linkedin_url: emp.profile_url || null,
        li_merged:           emp.profile_url || null,
        title:               profile.occupation || emp.title || null,
        city:                profile.city || null,
        country:             profile.country_full_name || null,
        is_dach:             isDACH(profile.country_full_name),
        person_source:       'LinkedIn',
        source:              'linkedin',
        contact_type:        contactType,
        raw_data:            profile,
    };
}

function extractDomain(url) {
    try {
        return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
    } catch (_) {
        return url;
    }
}

function isDACH(country) {
    if (!country) return false;
    const c = country.toLowerCase();
    return c.includes('germany') || c.includes('austria') || c.includes('switzerland');
}

module.exports = {
    getCompanyProfile,
    getPersonProfile,
    searchCompanyEmployees,
    normaliseCompany,
    normaliseLinkedInContact,
};
