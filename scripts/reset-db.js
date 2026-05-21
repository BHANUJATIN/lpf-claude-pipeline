#!/usr/bin/env node
/**
 * Reset DB — truncates ALL tables and restarts sequences.
 * Run: node scripts/reset-db.js
 * Add --confirm flag to skip the prompt.
 */
require('dotenv').config();
const Database = require('../src/database/Database');

async function main() {
    const confirmed = process.argv.includes('--confirm');

    if (!confirmed) {
        console.log('\n⚠️  This will DELETE ALL DATA from every table.\n');
        console.log('To confirm, run:  node scripts/reset-db.js --confirm\n');
        process.exit(0);
    }

    const db = Database.getInstance();
    await db.connect();
    console.log('Connected. Resetting all tables...');

    await db.query(`
        TRUNCATE TABLE
            lpf_sends,
            lpf_pipeline_log,
            lpf_contacts,
            lpf_companies,
            lpf_logs,
            lpf_jobs
        RESTART IDENTITY CASCADE
    `);

    console.log('✓ All tables truncated and sequences reset');
    process.exit(0);
}

main().catch(err => { console.error('Reset failed:', err.message); process.exit(1); });
