#!/usr/bin/env node
/**
 * Delete jobs where the title looks like a CSV parsing artifact:
 * - Contains "job_title:", "job_url:", "job_country:", "company_linkedin_url:" etc.
 * - Or where title is clearly a JD fragment (no real job title pattern)
 * Run: node scripts/cleanup-bad-imports.js [--dry-run]
 */
require('dotenv').config();
const Database = require('../src/database/Database');

const DRY = process.argv.includes('--dry-run');

const BAD_TITLE_PATTERNS = [
    /^job_title:/i,
    /^job_url:/i,
    /^job_country:/i,
    /^company_linkedin_url:/i,
    /^company_url:/i,
    /^client_key:/i,
    /^source:/i,
];

async function main() {
    const db = Database.getInstance();
    await db.connect();
    console.log('Connected');

    const jobs = await db.queryAll(`SELECT id, job_title, company_url FROM lpf_jobs ORDER BY id`);
    const bad = jobs.filter(j => BAD_TITLE_PATTERNS.some(p => p.test(j.job_title || '')));

    if (!bad.length) { console.log('No bad jobs found.'); process.exit(0); }

    console.log(`Found ${bad.length} bad jobs:`);
    bad.forEach(j => console.log(`  [${j.id}] "${j.job_title}" — ${j.company_url||'no company'}`));

    if (DRY) { console.log('\n(dry run — nothing deleted)'); process.exit(0); }

    for (const j of bad) {
        await db.query('DELETE FROM lpf_contacts WHERE job_id = $1', [j.id]);
        await db.query('DELETE FROM lpf_pipeline_log WHERE job_id = $1', [j.id]);
        await db.query('DELETE FROM lpf_sends WHERE job_id = $1', [j.id]);
        await db.query('DELETE FROM lpf_jobs WHERE id = $1', [j.id]);
        console.log(`Deleted job [${j.id}]`);
    }
    console.log('Done.');
    process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
