/**
 * One-shot: delete rejected jobs + revert all processed/in-progress jobs back to 'received'.
 * Jobs already at stage='received' are untouched.
 * Run once then delete this file.
 */
require('dotenv').config();
const Database = require('../src/database/Database');

(async () => {
    const db = new Database();

    // ── 1. Count before ────────────────────────────────────────────────────────
    const before = await db.queryOne(`
        SELECT
            COUNT(*) FILTER (WHERE stage = 'received')  AS unprocessed,
            COUNT(*) FILTER (WHERE stage = 'rejected')  AS rejected,
            COUNT(*) FILTER (WHERE stage NOT IN ('received','rejected')) AS in_progress_or_done
        FROM lpf_jobs
    `);
    console.log('Before:', before);

    // ── 2. Delete sends for ALL non-received jobs (no cascade on lpf_sends) ───
    const delSends = await db.query(`
        DELETE FROM lpf_sends
        WHERE job_id IN (SELECT id FROM lpf_jobs WHERE stage != 'received')
    `);
    console.log('Deleted sends:', delSends.rowCount);

    // ── 3. Delete rejected jobs (CASCADE handles their contacts + log) ─────────
    const delRejected = await db.query(`DELETE FROM lpf_jobs WHERE stage = 'rejected'`);
    console.log('Deleted rejected jobs:', delRejected.rowCount);

    // ── 4. Delete contacts for still-existing processed jobs ───────────────────
    const delContacts = await db.query(`
        DELETE FROM lpf_contacts
        WHERE job_id IN (SELECT id FROM lpf_jobs WHERE stage != 'received')
    `);
    console.log('Deleted contacts:', delContacts.rowCount);

    // ── 5. Delete pipeline log entries for processed jobs ──────────────────────
    const delLog = await db.query(`
        DELETE FROM lpf_pipeline_log
        WHERE job_id IN (SELECT id FROM lpf_jobs WHERE stage != 'received')
    `);
    console.log('Deleted pipeline log rows:', delLog.rowCount);

    // ── 6. Reset processed/in-progress jobs back to received ──────────────────
    const reset = await db.query(`
        UPDATE lpf_jobs SET
            stage = 'received',
            stage_error = NULL,
            -- Stage 1
            is_sap = NULL, sap_rejection_reason = NULL, is_dach = NULL,
            is_direct_employer = NULL, quality_score = NULL, seniority = NULL, ctr_fit = NULL,
            -- Stage 2
            company_domain = NULL, company_description = NULL, company_employee_count = NULL,
            company_dach_employees = NULL, company_hq_city = NULL, company_hq_country = NULL,
            company_industry = NULL,
            -- Stage 3
            sap_modules = NULL, sap_skills_comma = NULL, tech_combined = NULL,
            tech_short = NULL, tech_short2 = NULL, tech_compressed = NULL, tech_longer = NULL,
            top_job_tech_comma = NULL, dev_or_engineer = NULL, a_dev_or_engineer = NULL,
            primary_tech = NULL, dev_or_eng = NULL, shorter_tech_description = NULL,
            shorter_tech_description_scrambled = NULL, shorter_tech_comma = NULL,
            comma_tech_description = NULL, imagined_city = NULL, imagined_nearby_city = NULL,
            imagined_industry = NULL,
            -- Stage 4
            apollo_people_found = 0, li_people_found = 0, total_people_found = 0,
            -- Timestamps
            processed_at = NULL, sent_at = NULL
        WHERE stage != 'received'
    `);
    console.log('Reset to received:', reset.rowCount);

    // ── 7. Count after ─────────────────────────────────────────────────────────
    const after = await db.queryOne(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage = 'received') AS unprocessed
        FROM lpf_jobs
    `);
    console.log('After:', after);
    console.log('Done.');

    await db.pool.end();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
