/**
 * CRMPush — orchestrates RecruiterFlow writes for a single job.
 *
 * Order (required by RF):
 *   1. Dedup: look up company by name + by LinkedIn URL
 *   2. Create company if not found → capture client_id
 *   3. Create contacts (with email, non-excluded title) → link to company via client_company name
 *   4. Create job (requires client_id) → links to company
 *
 * All results are persisted to lpf_crm_records for the CRM dashboard tab.
 */
const RF     = require('../services/RecruiterFlowService');
const Logger = require('../Logger');

const logger = new Logger('CRMPush');

// Titles excluded from RF contact push (matches Clay Excluded Titles gate)
const EXCLUDED_TITLE_KEYWORDS = [
    'sales', 'marketing', 'business development', 'account executive', 'account manager',
    'commercial', 'ui/ux', 'ux designer', 'ui designer', 'product design',
    'digital marketing', 'seo', 'sem', 'content manager', 'community manager',
    'pr manager', 'public relation', 'social media', 'brand manager',
    'growth hacker', 'demand generation', 'customer success',
];

// Tag every pipeline-created RF job with this so the recruiter can filter
// to inbound advert-driven jobs in RecruiterFlow's UI.
const JOB_TAGS = (process.env.RECRUITERFLOW_JOB_TAGS || 'Job Advert')
    .split(',').map(t => t.trim()).filter(Boolean);

// RF "Job Advert" is a custom job-status (not a tag) on the CTR tenant.
// Visible in /job list responses as `job_status: {id: 2, name: "Job Advert", ...}`.
// Override via env if the tenant's status id differs.
const JOB_STATUS_ID = parseInt(process.env.RECRUITERFLOW_JOB_STATUS_ID || '2', 10);

function isExcludedTitle(title) {
    if (!title) return false;
    const t = title.toLowerCase();
    return EXCLUDED_TITLE_KEYWORDS.some(k => t.includes(k));
}

/**
 * Build the RF company payload from a job row.
 */
function buildCompanyPayload(job) {
    const domain = job.company_domain
        || (job.company_url ? extractDomain(job.company_url) : null);
    return {
        name:          job.company_name || '',
        domain:        domain           || '',
        linkedin_page: job.company_linkedin_url || undefined,
        location: (job.company_hq_city || job.company_hq_country) ? {
            city:         job.company_hq_city    || '',
            country:      job.company_hq_country || '',
            state:        '',
            postal_code:  '',
        } : undefined,
        employee_count: job.company_employee_count || undefined,
    };
}

/**
 * Build the RF contact payload from a contact row.
 * BUG FIX: phone_number omitted when empty (avoids RF HTTP 400).
 */
function buildContactPayload(contact, companyName) {
    const liUrl = contact.li_merged || contact.linkedin_url_merged
               || contact.person_linkedin_url || contact.linkedin_url || null;
    return {
        first_name:      contact.first_name   || '',
        last_name:       contact.last_name    || '',
        email:           contact.email        || '',
        title:           contact.title        || '',
        linkedin_profile: liUrl               || undefined,
        client_company:  companyName          || '',
        organization:    companyName          || '',
        // phone_numbers intentionally empty — we don't have phone data at this stage
    };
}

/**
 * Build the RF /job/create payload from a job row + client_id.
 * Always tags pipeline-created jobs with JOB_TAGS (default: ['Job Advert']) so
 * the recruiter can filter inbound-advert jobs in RF's UI.
 *
 * Note: contact_ids are NOT included here — RF rejects that field on
 * /job/create. The job-poster linkage happens via a separate POST after
 * the job is created (see addJobContact in RecruiterFlowService).
 */
function buildJobPayload(job, clientId) {
    const skills = (job.sap_skills_comma || job.sap_modules || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    return {
        client_id:   clientId,
        name:        job.job_title       || '',
        url:         job.job_url         || '',
        description: (job.job_description || '').slice(0, 10000),
        country:     job.country          || job.company_hq_country || undefined,
        city:        job.city             || job.company_hq_city    || undefined,
        skills:      skills.length ? skills : undefined,
        tags:        JOB_TAGS,
    };
}

/**
 * Push a job (company + contacts + job record) to RecruiterFlow CRM.
 *
 * @param {object} job       — job row from lpf_jobs
 * @param {array}  contacts  — contact rows from lpf_contacts for this job
 * @param {object} db        — DatabaseService instance (for persisting crm_records)
 * @returns {{ company, contacts, job }}
 */
async function pushJobToCRM(job, contacts, db) {
    const results = {
        company:  null,
        contacts: [],
        job:      null,
    };

    if (!process.env.RECRUITERFLOW_API_KEY) {
        logger.warn('RECRUITERFLOW_API_KEY not set — CRM push skipped', { job_id: job.id });
        return results;
    }

    // ── 1. Dedup company lookup ────────────────────────────────────────────────
    let clientId = null;

    if (job.company_name) {
        const byName = await RF.lookupCompanyByName(job.company_name);
        if (byName.found) {
            clientId = byName.clientId;
            results.company = { status: 'dedup_skipped', client_id: clientId, source: 'name_lookup' };
            logger.debug('RF company dedup hit by name', { company: job.company_name, clientId });
        }
    }

    if (!clientId && job.company_linkedin_url) {
        const byLI = await RF.lookupCompanyByLinkedin(job.company_linkedin_url);
        if (byLI.found) {
            clientId = byLI.clientId;
            results.company = { status: 'dedup_skipped', client_id: clientId, source: 'linkedin_lookup' };
            logger.debug('RF company dedup hit by LinkedIn', { url: job.company_linkedin_url, clientId });
        }
    }

    // ── 2. Create company if not found ────────────────────────────────────────
    if (!clientId) {
        if (!job.company_name) {
            results.company = { status: 'skipped', reason: 'no_company_name' };
        } else {
            const payload = buildCompanyPayload(job);
            try {
                const res = await RF.createCompany(payload);
                clientId = res?.id || res?.data?.id || res?.client_id || null;
                results.company = { status: 'sent', client_id: clientId, payload, response: res };
                logger.info('RF company created', { company: job.company_name, clientId, job_id: job.id });
            } catch (err) {
                results.company = { status: 'error', payload, error: err.message };
                logger.error('RF company create failed', { error: err.message, company: job.company_name });
            }
        }
    }

    // Save company record to DB
    if (db && results.company) {
        await db.upsertCRMRecord({
            job_id:      job.id,
            contact_id:  null,
            record_type: 'company',
            rf_client_id: clientId,
            status:      results.company.status,
            payload:     results.company.payload || null,
            response:    results.company.response || null,
            error_msg:   results.company.error || null,
        }).catch(e => logger.warn('CRM record save failed', { error: e.message }));

        // Persist client_id onto the job for later use
        if (clientId) {
            await db.updateJobFields(job.id, { rf_client_id: clientId }).catch(() => {});
        }
    }

    // ── 3. Create contacts ─────────────────────────────────────────────────────
    // Requires: email present AND title not excluded AND company exists in RF.
    // The job-poster contact gets special treatment: we capture its RF id so the
    // job row created in step 4 can link to it via /job/contact/add.
    const eligibleContacts = contacts.filter(c =>
        c.email && !isExcludedTitle(c.title)
    );
    let jobPosterRfId = null;       // captured below — used in step 5

    for (const contact of eligibleContacts) {
        const payload = buildContactPayload(contact, job.company_name);
        let rec;
        try {
            // Dedup: check if contact already exists in RF by email
            const existing = await RF.lookupContactByEmail(contact.email);
            if (existing.found) {
                rec = { contact_id: contact.id, status: 'dedup_skipped', rf_id: existing.contactId, payload };
                logger.debug('RF contact dedup hit', { email: contact.email, rf_id: existing.contactId });
            } else {
                const res = await RF.createContact(payload);
                const rfId = res?.data?.id || res?.id || null;
                rec = { contact_id: contact.id, status: 'sent', rf_id: rfId, payload, response: res };
                logger.debug('RF contact created', { name: contact.full_name, contact_id: contact.id, rf_id: rfId });
            }
        } catch (err) {
            rec = { contact_id: contact.id, status: 'error', payload, error: err.message };
            logger.warn('RF contact create failed', { error: err.message, contact_id: contact.id, name: contact.full_name });
        }
        results.contacts.push(rec);

        // Capture the job poster's RF id (whether newly created OR dedup hit)
        if (contact.contact_type === 'job_poster' && rec.rf_id) {
            jobPosterRfId = rec.rf_id;
            logger.info('Job poster captured for RF job linkage', { contact_id: contact.id, rf_id: rec.rf_id });
        }

        if (db) {
            await db.upsertCRMRecord({
                job_id:      job.id,
                contact_id:  contact.id,
                record_type: 'contact',
                rf_id:       rec.rf_id || null,
                rf_client_id: clientId,
                status:      rec.status,
                payload:     rec.payload,
                response:    rec.response || null,
                error_msg:   rec.error || null,
            }).catch(e => logger.warn('CRM record save failed', { error: e.message }));
        }
    }

    // ── 4. Create job (requires client_id) ────────────────────────────────────
    // The create call itself never sends contact_ids (RF rejects that field on
    // /job/create with "Please provide contact IDs in integer format"). Tags
    // ARE sent on create. The job ↔ contact linkage happens in step 5 below.
    let rfJobId = null;
    if (!clientId) {
        results.job = { status: 'skipped', reason: 'no_client_id' };
        logger.warn('RF job skipped — no client_id', { job_id: job.id });
    } else {
        const payload = buildJobPayload(job, clientId);
        try {
            const res = await RF.createJob(payload);
            rfJobId = res?.data?.id || res?.id || null;
            results.job = {
                status:        'sent',
                payload,
                response:      res,
                rf_job_id:     rfJobId,
                tags:          JOB_TAGS,
                job_status_id: JOB_STATUS_ID,
            };
            logger.info('RF job created', {
                title: job.job_title, job_id: job.id, rf_job_id: rfJobId,
                tags: JOB_TAGS, job_status_id: JOB_STATUS_ID,
            });
        } catch (err) {
            results.job = { status: 'error', payload, error: err.message };
            logger.error('RF job create failed', { error: err.message, job_id: job.id });
        }
    }

    // ── 5. Post-create: set job_status_id + link the job poster as a contact ──
    // Both fields are silently ignored by /job/create on this RF tenant, but
    // /job/update accepts them. We bundle BOTH into a single update call so
    // the recruiter sees the job land with "Job Advert" status AND the poster
    // attached the moment the pipeline finishes.
    if (rfJobId) {
        const updates = { job_status_id: JOB_STATUS_ID };
        if (jobPosterRfId) updates.contact_ids = [Number(jobPosterRfId)];

        try {
            const updateRes = await RF.updateJob(rfJobId, updates);
            results.job_contact_link = {
                status:        jobPosterRfId ? 'sent' : 'status_only',
                method:        '/job/update',
                rf_job_id:     rfJobId,
                rf_contact_id: jobPosterRfId ? Number(jobPosterRfId) : null,
                job_status_id: JOB_STATUS_ID,
                response:      updateRes,
            };
            logger.info('RF job updated post-create', {
                rf_job_id:     rfJobId,
                job_status_id: JOB_STATUS_ID,
                rf_contact_id: jobPosterRfId,
            });
        } catch (err) {
            results.job_contact_link = {
                status:        'error',
                rf_job_id:     rfJobId,
                rf_contact_id: jobPosterRfId ? Number(jobPosterRfId) : null,
                job_status_id: JOB_STATUS_ID,
                error:         err.message,
            };
            logger.warn('RF job/update post-create failed', {
                error: err.message, rf_job_id: rfJobId,
            });
        }
    }

    if (db && results.job) {
        // Fold the job-poster linkage outcome into the response blob so the
        // CRM dashboard tab can show "✓ Job Advert tag · poster linked" in one place.
        const responseWithLink = {
            ...(results.job.response || {}),
            ...(results.job_contact_link ? { _job_poster_link: results.job_contact_link } : {}),
        };
        await db.upsertCRMRecord({
            job_id:      job.id,
            contact_id:  null,
            record_type: 'job',
            rf_id:       results.job.rf_job_id || null,
            rf_client_id: clientId,
            status:      results.job.status,
            payload:     results.job.payload || null,
            response:    responseWithLink,
            error_msg:   results.job.error || null,
        }).catch(e => logger.warn('CRM record save failed', { error: e.message }));
    }

    return results;
}

function extractDomain(url) {
    if (!url) return null;
    try {
        const normalized = url.includes('://') ? url : 'https://' + url;
        return new URL(normalized).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch (_) { return null; }
}

module.exports = { pushJobToCRM };
