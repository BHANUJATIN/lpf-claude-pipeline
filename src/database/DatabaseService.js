const Database = require('./Database');

class DatabaseService {
    constructor() {
        this.db = Database.getInstance();
    }

    // ── Jobs ──────────────────────────────────────────────────────────────────

    /**
     * Pre-insertion dedup check — called by the webhook handlers BEFORE any row
     * is created in lpf_jobs. Operator rule: a duplicate job must never enter
     * the pipeline (or even the DB).
     *
     * Rejects when:
     *   • Exact job_url already exists, OR
     *   • Same company (by company_url) is within the 30-day cooldown, OR
     *   • Same (company_name + country) is within the 30-day cooldown
     *
     * Returns:
     *   { duplicate: true,  reason: '…', existing_job_id, existing_stage }
     *   { duplicate: false }
     */
    async checkJobDedupe(payload) {
        // 1. Exact job-URL duplicate — never re-insert the same posting.
        if (payload.job_url) {
            const sameUrl = await this.db.queryOne(
                `SELECT id, stage, received_at FROM lpf_jobs WHERE job_url = $1 LIMIT 1`,
                [payload.job_url]
            );
            if (sameUrl) {
                return {
                    duplicate: true,
                    reason: `Same job_url already received as job #${sameUrl.id} (stage=${sameUrl.stage})`,
                    existing_job_id: sameUrl.id,
                    existing_stage:  sameUrl.stage,
                    match_kind:      'job_url',
                };
            }
        }

        // 2. Company cooldown — uses the same 30-day window as Stage 1's
        //    in-pipeline check. Reused via getProcessedJobForCompany so the
        //    rule is defined in one place.
        const cooldownHit = await this.getProcessedJobForCompany(
            payload.company_url, payload.company_name, payload.country, /* excludeId */ null
        );
        if (cooldownHit) {
            const cooldownDays = parseInt(process.env.COMPANY_COOLDOWN_DAYS || '30', 10);
            const ageDays = cooldownHit.received_at
                ? Math.floor((Date.now() - new Date(cooldownHit.received_at).getTime()) / 86_400_000)
                : '?';
            return {
                duplicate: true,
                reason: `Company in cooldown — job #${cooldownHit.id} (stage=${cooldownHit.stage}) was received ${ageDays}d ago. Cooldown=${cooldownDays}d. Eligible again in ${Math.max(0, cooldownDays - ageDays)}d.`,
                existing_job_id: cooldownHit.id,
                existing_stage:  cooldownHit.stage,
                match_kind:      'company_cooldown',
            };
        }

        return { duplicate: false };
    }

    async upsertJob(payload) {
        const row = await this.db.queryOne(`
            INSERT INTO lpf_jobs (
                job_url, job_title, job_description, city, country,
                company_url, company_linkedin_url, company_name,
                job_poster_url, source, applicant_count, search_term, raw_payload
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (job_url) DO UPDATE SET
                job_title            = EXCLUDED.job_title,
                job_description      = EXCLUDED.job_description,
                city                 = EXCLUDED.city,
                country              = EXCLUDED.country,
                company_url          = EXCLUDED.company_url,
                company_linkedin_url = EXCLUDED.company_linkedin_url,
                company_name         = EXCLUDED.company_name,
                job_poster_url       = EXCLUDED.job_poster_url,
                source               = EXCLUDED.source,
                raw_payload          = EXCLUDED.raw_payload
            RETURNING id, stage
        `, [
            payload.job_url, payload.job_title, payload.job_description,
            payload.city, payload.country,
            payload.company_url, payload.company_linkedin_url, payload.company_name,
            payload.job_poster_url, payload.source, payload.applicant_count,
            payload.search_term, JSON.stringify(payload),
        ]);
        return row;
    }

    async getJobById(id) {
        return this.db.queryOne('SELECT * FROM lpf_jobs WHERE id = $1', [id]);
    }

    async getPendingJobs(limit = 10) {
        return this.db.queryAll(`
            SELECT * FROM lpf_jobs
            WHERE stage = 'received'
            ORDER BY received_at ASC
            LIMIT $1
        `, [limit]);
    }

    async getJobsForStage(stage, limit = 10) {
        return this.db.queryAll(`
            SELECT * FROM lpf_jobs
            WHERE stage = $1
            ORDER BY received_at ASC
            LIMIT $2
        `, [stage, limit]);
    }

    async updateJobStage(jobId, stage, extraFields = {}) {
        const sets   = ['stage = $2'];
        const params = [jobId, stage];
        let   i      = 3;

        for (const [key, val] of Object.entries(extraFields)) {
            sets.push(`${key} = $${i++}`);
            params.push(val);
        }

        return this.db.query(
            `UPDATE lpf_jobs SET ${sets.join(', ')} WHERE id = $1`,
            params
        );
    }

    async markJobRejected(jobId, reason) {
        return this.db.query(
            `UPDATE lpf_jobs SET stage = 'rejected', stage_error = $2 WHERE id = $1`,
            [jobId, reason]
        );
    }

    async countJobs() {
        return this.db.queryOne(`
            SELECT
                COUNT(*)                                                            AS total,
                COUNT(*) FILTER (WHERE stage = 'received')                         AS pending,
                COUNT(*) FILTER (WHERE stage IN ('stage1_sap','stage2_company',
                    'stage3_tech','stage4_people','stage5_enrich',
                    'stage6_poster','stage7_ai_search'))                            AS in_progress,
                COUNT(*) FILTER (WHERE stage = 'review')                           AS review,
                COUNT(*) FILTER (WHERE stage = 'completed')                        AS completed,
                COUNT(*) FILTER (WHERE stage = 'rejected')                         AS rejected,
                COUNT(*) FILTER (WHERE sent_at IS NOT NULL)                        AS sent
            FROM lpf_jobs
        `);
    }

    async countContactsForJob(jobId) {
        const r = await this.db.queryOne('SELECT COUNT(*) AS cnt FROM lpf_contacts WHERE job_id = $1', [jobId]);
        return parseInt(r?.cnt || 0);
    }

    async updateJobFields(jobId, fields) {
        if (!fields || !Object.keys(fields).length) return;
        const sets   = [];
        const params = [jobId];
        for (const [k, v] of Object.entries(fields)) {
            sets.push(`${k} = $${params.length + 1}`);
            params.push(v);
        }
        return this.db.query(`UPDATE lpf_jobs SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    async updateJobComment(jobId, comment) {
        return this.db.query(
            'UPDATE lpf_jobs SET rejection_comment = $2 WHERE id = $1',
            [jobId, comment || null]
        );
    }

    async reprocessJob(jobId) {
        return this.db.query(`
            UPDATE lpf_jobs SET
                stage = 'received', stage_error = NULL, rejection_comment = NULL,
                is_sap = NULL, sap_rejection_reason = NULL, is_dach = NULL,
                is_direct_employer = NULL, quality_score = NULL, seniority = NULL, ctr_fit = NULL,
                company_domain = NULL, company_description = NULL, company_employee_count = NULL,
                company_dach_employees = NULL, company_hq_city = NULL, company_hq_country = NULL,
                company_industry = NULL,
                sap_modules = NULL, sap_skills_comma = NULL, tech_combined = NULL,
                tech_short = NULL, tech_short2 = NULL, tech_compressed = NULL, tech_longer = NULL,
                top_job_tech_comma = NULL, dev_or_engineer = NULL, a_dev_or_engineer = NULL,
                primary_tech = NULL, dev_or_eng = NULL, shorter_tech_description = NULL,
                shorter_tech_description_scrambled = NULL, shorter_tech_comma = NULL,
                comma_tech_description = NULL, imagined_city = NULL, imagined_nearby_city = NULL,
                imagined_industry = NULL,
                apollo_people_found = 0, li_people_found = 0, total_people_found = 0,
                processed_at = NULL, sent_at = NULL
            WHERE id = $1
        `, [jobId]);
    }

    async getUnprocessedJobs(limit = 50, sinceDate = null) {
        const params = [];
        let extra = '';
        if (sinceDate) {
            params.push(sinceDate);
            extra = ` AND received_at >= $${params.length}`;
        }
        params.push(limit);
        return this.db.queryAll(`
            SELECT id, job_title, company_name, company_url, city, country, stage,
                   received_at, source, applicant_count, search_term, job_url
            FROM lpf_jobs
            WHERE stage = 'received'${extra}
            ORDER BY received_at DESC
            LIMIT $${params.length}
        `, params);
    }

    // Returns an existing non-rejected job for the same company within the
    // configured cooldown window (default 30 days). Dedup key: company_url
    // OR (company_name + country). If the most recent prior job is older than
    // COMPANY_COOLDOWN_DAYS, we treat the new job as eligible for re-processing —
    // matches the operator rule "after 30 days, process again".
    // `excludeId` lets the caller exclude the job being checked itself from the
    // dedup result — otherwise re-processing the same job hits the cooldown
    // against itself and gets rejected for "Company already has job #X". This
    // matters when boot-resume + the bulk-pipeline runner both pick up the
    // same job, or when a job is retried after completing.
    async getProcessedJobForCompany(companyUrl, companyName, country, excludeId = null) {
        const cooldownDays = parseInt(process.env.COMPANY_COOLDOWN_DAYS || '30', 10);
        const interval     = `${cooldownDays} days`;
        if (companyUrl) {
            const row = await this.db.queryOne(
                `SELECT id, stage, received_at FROM lpf_jobs
                 WHERE company_url = $1
                   AND stage NOT IN ('received','rejected')
                   AND received_at > NOW() - $2::interval
                   AND ($3::int IS NULL OR id != $3)
                 ORDER BY received_at DESC LIMIT 1`,
                [companyUrl, interval, excludeId]
            );
            if (row) return row;
        }
        if (companyName && country) {
            return this.db.queryOne(
                `SELECT id, stage, received_at FROM lpf_jobs
                 WHERE LOWER(TRIM(company_name)) = LOWER(TRIM($1))
                   AND LOWER(TRIM(country))       = LOWER(TRIM($2))
                   AND stage NOT IN ('received','rejected')
                   AND received_at > NOW() - $3::interval
                   AND ($4::int IS NULL OR id != $4)
                 ORDER BY received_at DESC LIMIT 1`,
                [companyName, country, interval, excludeId]
            );
        }
        return null;
    }

    async getProcessedJobs(limit = 200, stage = null) {
        const stageClause = stage
            ? `j.stage = $2`
            : `j.stage IN ('review','completed','rejected')`;
        const params = stage ? [limit, stage] : [limit];
        return this.db.queryAll(`
            SELECT j.*,
                   COUNT(DISTINCT c.id)                                                  AS contact_count,
                   COUNT(DISTINCT c.id) FILTER (WHERE c.send_decision = 'approved')     AS approved_count,
                   COUNT(DISTINCT c.id) FILTER (WHERE c.sent_to_instantly = TRUE)       AS sent_count
            FROM lpf_jobs j
            LEFT JOIN lpf_contacts c ON c.job_id = j.id
            WHERE ${stageClause}
            GROUP BY j.id
            ORDER BY j.received_at DESC
            LIMIT $1
        `, params);
    }

    async getRecentJobs(limit = 100) {
        return this.db.queryAll(`
            SELECT id, job_title, company_name, company_url, city, country, stage, stage_error,
                   quality_score, ctr_fit, seniority,
                   sap_modules, tech_short, dev_or_eng, dev_or_engineer,
                   imagined_city, imagined_nearby_city, imagined_industry,
                   shorter_tech_comma, sap_skills_comma,
                   total_people_found, received_at, processed_at
            FROM lpf_jobs
            ORDER BY received_at DESC
            LIMIT $1
        `, [limit]);
    }

    // ── Companies ─────────────────────────────────────────────────────────────

    async upsertCompany(data) {
        return this.db.queryOne(`
            INSERT INTO lpf_companies (
                company_url, company_linkedin_url, company_name, company_domain,
                company_description, company_industry, employee_count, dach_employees,
                hq_city, hq_country
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (company_url) DO UPDATE SET
                company_linkedin_url = COALESCE(EXCLUDED.company_linkedin_url, lpf_companies.company_linkedin_url),
                company_name         = COALESCE(EXCLUDED.company_name, lpf_companies.company_name),
                company_domain       = COALESCE(EXCLUDED.company_domain, lpf_companies.company_domain),
                company_description  = COALESCE(EXCLUDED.company_description, lpf_companies.company_description),
                company_industry     = COALESCE(EXCLUDED.company_industry, lpf_companies.company_industry),
                employee_count       = COALESCE(EXCLUDED.employee_count, lpf_companies.employee_count),
                dach_employees       = COALESCE(EXCLUDED.dach_employees, lpf_companies.dach_employees),
                hq_city              = COALESCE(EXCLUDED.hq_city, lpf_companies.hq_city),
                hq_country           = COALESCE(EXCLUDED.hq_country, lpf_companies.hq_country),
                last_seen            = NOW()
            RETURNING *
        `, [
            data.company_url, data.company_linkedin_url, data.company_name, data.company_domain,
            data.company_description, data.company_industry, data.employee_count, data.dach_employees,
            data.hq_city, data.hq_country,
        ]);
    }

    async getCompanyByUrl(url) {
        return this.db.queryOne('SELECT * FROM lpf_companies WHERE company_url = $1', [url]);
    }

    async getJobsForReview(limit = 50) {
        return this.db.queryAll(`
            SELECT j.*, COUNT(c.id) AS contact_count,
                   COUNT(c.id) FILTER (WHERE c.send_decision = 'approved') AS approved_count,
                   COUNT(c.id) FILTER (WHERE c.send_decision = 'skipped')  AS skipped_count,
                   COUNT(c.id) FILTER (WHERE c.send_decision IS NULL)      AS pending_count,
                   COUNT(c.id) FILTER (WHERE c.email IS NOT NULL)          AS has_email_count
            FROM lpf_jobs j
            LEFT JOIN lpf_contacts c ON c.job_id = j.id
            WHERE j.stage = 'review'
            GROUP BY j.id
            ORDER BY j.received_at DESC
            LIMIT $1
        `, [limit]);
    }

    // ── Contacts ──────────────────────────────────────────────────────────────

    async insertContact(data) {
        return this.db.queryOne(`
            INSERT INTO lpf_contacts (
                job_id, company_url, company_name,
                first_name, last_name, full_name, email, email_validated, email_source,
                linkedin_url, linkedin_url_merged, person_linkedin_url, li_merged,
                title, city, country, is_dach, person_source,
                gender, salutation, source, contact_type, is_it_role, raw_data
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
            RETURNING id
        `, [
            data.job_id, data.company_url, data.company_name,
            data.first_name, data.last_name, data.full_name,
            data.email, data.email_validated || false, data.email_source,
            data.linkedin_url, data.linkedin_url_merged, data.person_linkedin_url, data.li_merged,
            data.title, data.city, data.country, data.is_dach, data.person_source,
            data.gender, data.salutation, data.source, data.contact_type,
            data.is_it_role, data.raw_data ? JSON.stringify(data.raw_data) : null,
        ]);
    }

    async getContactsForJob(jobId) {
        return this.db.queryAll(
            'SELECT * FROM lpf_contacts WHERE job_id = $1 ORDER BY created_at ASC',
            [jobId]
        );
    }

    async updateContact(contactId, fields) {
        const allowed = ['send_decision','send_destination','send_campaign_id','email','email_source','email_validated','salutation','gender',
                         'sent_to_heyreach','heyreach_lead_id','heyreach_sent_at',
                         'connection_req','inmail_body_de','english_inmail',
                         'heyreach_route','heyreach_generated_at','heyreach_error',
                         // New HeyReach pipeline fields (DACH-by-LinkedIn + 3 intermediate sentences)
                         'heyreach_dach_check','heyreach_dach_reasoning','heyreach_skip_reason',
                         'heyreach_job_posting_intro','heyreach_imagined_city_sentence',
                         'heyreach_imagined_industry_sentence',
                         // Full RF response body for the Sent ✅ drawer
                         'heyreach_response',
                         // Per-contact email-skip diagnostic (why we couldn't find this contact's email)
                         'email_skip_reason',
                         // Per-contact send-skip diagnostic (e.g. "Instantly: Lead is in blocklist")
                         'send_skip_reason'];
        const jsonbFields = new Set(['heyreach_response']);
        const sets    = [];
        const vals    = [contactId];
        for (const [k, v] of Object.entries(fields)) {
            if (!allowed.includes(k)) continue;
            const isJsonb = jsonbFields.has(k);
            const cast = isJsonb ? '::jsonb' : '';
            sets.push(`${k} = $${vals.length + 1}${cast}`);
            vals.push(isJsonb && v != null && typeof v !== 'string' ? JSON.stringify(v) : v);
        }
        if (!sets.length) return;
        return this.db.query(`UPDATE lpf_contacts SET ${sets.join(', ')} WHERE id = $1`, vals);
    }

    // Returns contacts eligible for HeyReach (have LinkedIn URL, from non-rejected jobs).
    // Returns every Instantly-payload field too, so the HeyReach table can render the
    // same job/company context that the People table shows — the recruiter sees exactly
    // which job, tech, location, and quality signals the InMail was generated from.
    async getHeyReachContacts({ limit = 500, route = null, generated = null } = {}) {
        const conditions = [`(c.li_merged IS NOT NULL OR c.linkedin_url IS NOT NULL)`];
        const params = [];

        if (route === 'pending') {
            conditions.push(`c.heyreach_generated_at IS NULL`);
        } else if (route && route !== 'all') {
            params.push(route);
            conditions.push(`c.heyreach_route = $${params.length}`);
        }
        if (generated === 'yes') conditions.push(`c.heyreach_generated_at IS NOT NULL`);
        if (generated === 'no')  conditions.push(`c.heyreach_generated_at IS NULL`);

        params.push(limit);
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        return this.db.queryAll(`
            SELECT c.id, c.job_id, c.first_name, c.last_name, c.full_name, c.email,
                   c.email_validated, c.email_source, c.title, c.contact_type,
                   c.salutation, c.gender, c.is_dach, c.is_it_role,
                   c.linkedin_url, c.li_merged, c.linkedin_url_merged, c.person_linkedin_url,
                   c.city, c.country, c.source AS person_source,
                   c.company_name, c.company_url, c.created_at,
                   c.sent_to_heyreach, c.heyreach_sent_at, c.heyreach_lead_id,
                   c.sent_to_instantly, c.instantly_lead_id,
                   c.connection_req, c.inmail_body_de, c.english_inmail,
                   c.heyreach_route, c.heyreach_generated_at, c.heyreach_error,
                   c.heyreach_dach_check, c.heyreach_dach_reasoning, c.heyreach_skip_reason,
                   c.heyreach_job_posting_intro,
                   c.heyreach_imagined_city_sentence,
                   c.heyreach_imagined_industry_sentence,
                   j.job_title, j.job_url, j.country AS job_country, j.city AS job_city,
                   j.dev_or_eng, j.dev_or_engineer, j.a_dev_or_engineer,
                   j.sap_skills_comma, j.shorter_tech_comma, j.comma_tech_description,
                   j.tech_short, j.tech_short2 AS tech_names_person_type, j.tech_compressed,
                   j.tech_longer AS longer_tech_description,
                   j.shorter_tech_description, j.shorter_tech_description_scrambled,
                   j.imagined_city, j.imagined_nearby_city, j.imagined_industry,
                   j.sap_modules, j.primary_tech, j.top_job_tech_comma,
                   j.quality_score, j.ctr_fit, j.seniority,
                   j.company_domain, j.company_hq_city, j.company_hq_country,
                   j.company_employee_count, j.company_industry,
                   j.company_linkedin_url,
                   j.company_description AS job_company_description
            FROM lpf_contacts c
            LEFT JOIN lpf_jobs j ON c.job_id = j.id
            ${where}
            ORDER BY c.created_at DESC
            LIMIT $${params.length}
        `, params);
    }

    async approveAllContacts(jobId, destination = 'instantly', campaignId = null) {
        return this.db.query(`
            UPDATE lpf_contacts
            SET send_decision    = 'approved',
                send_destination = $2,
                send_campaign_id = $3
            WHERE job_id = $1 AND send_decision IS NULL AND email IS NOT NULL
        `, [jobId, destination, campaignId]);
    }

    async markContactSentHeyReach(contactId, leadId, response = null) {
        return this.db.query(
            `UPDATE lpf_contacts SET
                sent_to_heyreach = TRUE,
                heyreach_lead_id = $2,
                heyreach_sent_at = NOW(),
                heyreach_response = $3::jsonb
             WHERE id = $1`,
            [contactId, leadId, response ? JSON.stringify(response) : null]
        );
    }

    async getContactsByIds(ids) {
        if (!ids?.length) return [];
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        return this.db.queryAll(
            `SELECT c.*, j.job_title, j.company_url AS job_company_url,
                    j.dev_or_eng, j.sap_skills_comma, j.shorter_tech_comma,
                    j.imagined_city, j.imagined_nearby_city, j.imagined_industry
             FROM lpf_contacts c
             LEFT JOIN lpf_jobs j ON c.job_id = j.id
             WHERE c.id IN (${placeholders})`,
            ids
        );
    }

    async markContactSent(contactId, instantlyLeadId) {
        return this.db.query(
            `UPDATE lpf_contacts SET sent_to_instantly = TRUE, instantly_lead_id = $2, sent_at = NOW() WHERE id = $1`,
            [contactId, instantlyLeadId]
        );
    }

    async countContacts() {
        return this.db.queryOne(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE sent_to_instantly = TRUE) AS sent
            FROM lpf_contacts
        `);
    }

    // ── Pipeline log ──────────────────────────────────────────────────────────

    async logStage(jobId, stage, status, message, data = null, durationMs = null) {
        return this.db.query(`
            INSERT INTO lpf_pipeline_log (job_id, stage, status, message, data, duration_ms)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [jobId, stage, status, message, data ? JSON.stringify(data) : null, durationMs]);
    }

    async getStageLogs(jobId) {
        return this.db.queryAll(
            'SELECT * FROM lpf_pipeline_log WHERE job_id = $1 ORDER BY created_at ASC',
            [jobId]
        );
    }

    async getAllContacts({ limit = 200, offset = 0, jobId = null, jobStage = null } = {}) {
        const conditions = [];
        const params = [limit, offset];
        if (jobId) {
            params.push(jobId);
            conditions.push(`c.job_id = $${params.length}`);
        }
        if (jobStage) {
            params.push(jobStage);
            conditions.push(`j.stage = $${params.length}`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        return this.db.queryAll(`
            SELECT c.id, c.job_id, c.company_name, c.first_name, c.last_name, c.full_name,
                   c.email, c.email_validated, c.email_source, c.title, c.contact_type,
                   c.linkedin_url, c.li_merged, c.person_linkedin_url, c.linkedin_url_merged,
                   c.city, c.country, c.is_dach, c.gender, c.salutation, c.source,
                   c.send_decision, c.sent_to_instantly, c.instantly_lead_id, c.created_at,
                   j.job_title, j.job_url, j.company_url, j.company_linkedin_url,
                   j.dev_or_eng, j.dev_or_engineer, j.a_dev_or_engineer,
                   j.sap_skills_comma, j.shorter_tech_comma, j.comma_tech_description,
                   j.tech_short, j.tech_short2 AS tech_names_person_type, j.tech_compressed,
                   j.tech_longer AS longer_tech_description,
                   j.shorter_tech_description, j.shorter_tech_description_scrambled,
                   j.imagined_city, j.imagined_nearby_city, j.imagined_industry,
                   j.sap_modules, j.primary_tech, j.top_job_tech_comma,
                   j.quality_score, j.ctr_fit, j.seniority,
                   j.company_domain, j.company_hq_city, j.company_hq_country,
                   j.company_employee_count, j.company_industry,
                   j.company_description AS job_company_description
            FROM lpf_contacts c
            LEFT JOIN lpf_jobs j ON c.job_id = j.id
            ${where}
            ORDER BY c.created_at DESC
            LIMIT $1 OFFSET $2
        `, params);
    }

    async getAllCompanies({ limit = 200, offset = 0 } = {}) {
        // Group by dedup key (company_url when present, else lowercased name).
        // MAX() picks the most-enriched value per field across all jobs for that company.
        // Filter out garbage rows (URLs in company_name, single chars, numeric strings).
        return this.db.queryAll(`
            SELECT
                MAX(j.company_name)           AS company_name,
                MAX(j.company_url)            AS company_url,
                MAX(j.company_domain)         AS company_domain,
                MAX(j.company_linkedin_url)   AS company_linkedin_url,
                MAX(j.company_industry)       AS company_industry,
                MAX(j.company_employee_count) AS company_employee_count,
                MAX(j.company_hq_city)        AS company_hq_city,
                MAX(j.company_hq_country)     AS company_hq_country,
                MAX(j.company_description)    AS company_description,
                MAX(j.received_at)            AS last_seen,
                COUNT(DISTINCT j.id)          AS job_count,
                COUNT(DISTINCT c.id)          AS contact_count
            FROM lpf_jobs j
            LEFT JOIN lpf_contacts c ON c.job_id = j.id
            WHERE j.company_name IS NOT NULL
              AND LENGTH(TRIM(j.company_name)) > 2
              AND j.company_name NOT LIKE 'http%'
              AND j.company_name NOT LIKE 'job%url%'
              AND j.company_name NOT SIMILAR TO '[0-9%].*'
            GROUP BY LOWER(TRIM(COALESCE(j.company_url, j.company_name)))
            ORDER BY MAX(j.received_at) DESC
            LIMIT $1 OFFSET $2
        `, [limit, offset]);
    }

    // ── RecruiterFlow CRM records ─────────────────────────────────────────────

    /**
     * Insert or update a CRM record row.
     *
     * Matches the partial unique indexes created in schema.sql:
     *   - (job_id, record_type)             WHERE contact_id IS NULL  → company / job records
     *   - (job_id, contact_id, record_type) WHERE contact_id IS NOT NULL → contact records
     *
     * If a matching row exists, the new values overwrite the old — so the dashboard always
     * shows the latest push attempt per (job, contact, type) triplet.
     */
    async upsertCRMRecord({ job_id, contact_id, record_type, rf_id, rf_client_id,
                            status, payload, response, error_msg }) {
        const params = [
            job_id, contact_id || null, record_type,
            rf_id      || null,
            rf_client_id != null ? rf_client_id : null,
            status,
            payload    ? JSON.stringify(payload)  : null,
            response   ? JSON.stringify(response) : null,
            error_msg  || null,
        ];

        // Delete any matching row first (the partial unique indexes need an explicit WHERE
        // clause that matches the index predicate, and ON CONFLICT can't reference partial
        // indexes by predicate in standard Postgres < 15 reliably — so do a delete+insert).
        if (contact_id) {
            await this.db.query(
                `DELETE FROM lpf_crm_records WHERE job_id=$1 AND contact_id=$2 AND record_type=$3`,
                [job_id, contact_id, record_type]
            ).catch(() => {});
        } else {
            await this.db.query(
                `DELETE FROM lpf_crm_records WHERE job_id=$1 AND contact_id IS NULL AND record_type=$2`,
                [job_id, record_type]
            ).catch(() => {});
        }

        return this.db.queryOne(`
            INSERT INTO lpf_crm_records
                (job_id, contact_id, record_type, rf_id, rf_client_id, status, payload, response, error_msg, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            RETURNING id
        `, params);
    }

    async setJobCRMStatus(jobId, fields) {
        const allowed = ['crm_status', 'crm_pushed_at', 'crm_error', 'rf_client_id'];
        const sets    = [];
        const params  = [jobId];
        for (const [k, v] of Object.entries(fields)) {
            if (allowed.includes(k)) { sets.push(`${k} = $${params.length + 1}`); params.push(v); }
        }
        if (!sets.length) return;
        return this.db.query(`UPDATE lpf_jobs SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    /** Jobs that have completed the pipeline but haven't been pushed to CRM yet. */
    async getJobsForCRMPush(limit = 50) {
        return this.db.queryAll(`
            SELECT * FROM lpf_jobs
            WHERE stage IN ('review','completed')
              AND (crm_status IS NULL OR crm_status IN ('pending','error'))
            ORDER BY received_at ASC
            LIMIT $1
        `, [limit]);
    }

    /** Job posters surfaced by Stage 6, for the Job Poster sub-tab. */
    async getJobPosters({ limit = 200 } = {}) {
        return this.db.queryAll(`
            SELECT j.id AS job_id, j.job_title, j.job_url, j.company_name, j.country, j.city,
                   j.job_poster_name, j.job_poster_email, j.job_poster_title, j.job_poster_linkedin,
                   j.job_poster_url, j.received_at, j.stage,
                   c.id AS contact_id, c.email_validated, c.email_source, c.salutation,
                   c.gender, c.is_it_role, c.is_dach AS poster_is_dach
            FROM lpf_jobs j
            LEFT JOIN lpf_contacts c
              ON c.job_id = j.id AND c.contact_type = 'job_poster'
            WHERE j.job_poster_name IS NOT NULL
               OR j.job_poster_email IS NOT NULL
               OR j.job_poster_linkedin IS NOT NULL
               OR j.job_poster_url IS NOT NULL
            ORDER BY j.received_at DESC
            LIMIT $1
        `, [limit]);
    }

    /**
     * Get all CRM records for a job (company + contacts + job record).
     */
    async getCRMRecordsForJob(jobId) {
        return this.db.queryAll(`
            SELECT r.*, c.full_name AS contact_name, c.email AS contact_email,
                   c.title AS contact_title, c.contact_type
            FROM lpf_crm_records r
            LEFT JOIN lpf_contacts c ON c.id = r.contact_id
            WHERE r.job_id = $1
            ORDER BY r.record_type, r.created_at ASC
        `, [jobId]);
    }

    /**
     * Get recent CRM records across all jobs — for the CRM dashboard tab.
     */
    async getAllCRMRecords({ limit = 200, record_type = null, status = null } = {}) {
        const conds  = [];
        const params = [];
        if (record_type) { params.push(record_type); conds.push(`r.record_type = $${params.length}`); }
        if (status)      { params.push(status);       conds.push(`r.status      = $${params.length}`); }
        params.push(limit);
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        return this.db.queryAll(`
            SELECT r.*,
                   j.job_title, j.job_url, j.company_name, j.company_url,
                   c.full_name AS contact_name, c.email AS contact_email, c.title AS contact_title
            FROM lpf_crm_records r
            LEFT JOIN lpf_jobs     j ON j.id = r.job_id
            LEFT JOIN lpf_contacts c ON c.id = r.contact_id
            ${where}
            ORDER BY r.created_at DESC
            LIMIT $${params.length}
        `, params);
    }

    // ── Instantly sends ───────────────────────────────────────────────────────

    async logSend(jobId, contactId, campaignId, payload, response, success, errorMessage = null) {
        return this.db.query(`
            INSERT INTO lpf_sends (job_id, contact_id, campaign_id, payload, instantly_response, success, error_message)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [jobId, contactId, campaignId, JSON.stringify(payload), JSON.stringify(response), success, errorMessage]);
    }

    // ── Application logs ──────────────────────────────────────────────────────

    async insertLog(level, module, message, meta = null) {
        return this.db.query(
            'INSERT INTO lpf_logs (level, module, message, meta) VALUES ($1,$2,$3,$4)',
            [level, module, message, meta ? JSON.stringify(meta) : null]
        );
    }

    async getLogs({ limit = 100, level = null, module = null, offset = 0 } = {}) {
        const where  = [];
        const params = [];
        if (level)  { params.push(level);  where.push(`level = $${params.length}`); }
        if (module) { params.push(module); where.push(`module = $${params.length}`); }
        params.push(limit, offset);
        const sql = `SELECT * FROM lpf_logs${where.length ? ' WHERE ' + where.join(' AND ') : ''}
                     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
        return this.db.queryAll(sql, params);
    }
}

module.exports = DatabaseService;
