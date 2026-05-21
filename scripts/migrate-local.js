#!/usr/bin/env node
/**
 * migrate-local — create / reset the local pglite test database
 *
 * Usage:
 *   node scripts/migrate-local.js          # apply schema, keep existing data
 *   node scripts/migrate-local.js --reset  # delete DB file and recreate fresh
 *
 * Reads .env.test automatically.
 */
require('dotenv').config({ path: '.env.test' });
const fs   = require('fs');
const path = require('path');

const dbPath = process.env.LOCAL_DB_PATH || path.join(process.cwd(), 'data', 'local.db');
const reset  = process.argv.includes('--reset');

if (reset && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
    console.log('Deleted existing local DB at', dbPath);
}

// Ensure data dir exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Reset singleton so we get a fresh LocalDatabase pointing to dbPath
const LocalDatabase = require('../src/database/LocalDatabase');
LocalDatabase.resetInstance();

async function main() {
    const db = LocalDatabase.getInstance();
    await db.connect();
    console.log('Local DB ready at', dbPath);

    const sql = fs.readFileSync(
        path.join(__dirname, '../src/database/schema.sql'),
        'utf8'
    );
    await db.query(sql);
    console.log('Schema applied successfully');

    // Quick sanity check
    const r = await db.queryAll(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('Tables created:', r.map(t => t.table_name).join(', '));

    await db.close();
    process.exit(0);
}

main().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
