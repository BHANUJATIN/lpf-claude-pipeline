#!/usr/bin/env node
/**
 * nuke-and-migrate — drops EVERY table in the database and re-applies the LPF schema.
 *
 * Use this to start fresh on a shared DB that has leftover tables from another project.
 *
 * Run:
 *   node scripts/nuke-and-migrate.js --confirm
 *
 * Without --confirm it prints a dry-run list of what would be dropped.
 */
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const Database = require('../src/database/Database');

async function main() {
    const confirmed = process.argv.includes('--confirm');

    const db = Database.getInstance();
    await db.connect();
    console.log(`Connected to ${process.env.POSTGRES_DB}@${process.env.POSTGRES_HOST}\n`);

    // ── List every table in the public schema ────────────────────────────────
    const { rows } = await db.query(`
        SELECT tablename
        FROM   pg_tables
        WHERE  schemaname = 'public'
        ORDER  BY tablename
    `);

    if (rows.length === 0) {
        console.log('Database is already empty — running migrations only.\n');
    } else {
        console.log(`Found ${rows.length} table(s) to drop:`);
        rows.forEach(r => console.log(`  • ${r.tablename}`));
        console.log('');
    }

    if (!confirmed) {
        console.log('DRY RUN — nothing changed.');
        console.log('To execute, run:\n  node scripts/nuke-and-migrate.js --confirm\n');
        process.exit(0);
    }

    // ── Drop all tables (CASCADE handles foreign-key ordering) ───────────────
    if (rows.length > 0) {
        const names = rows.map(r => `"${r.tablename}"`).join(', ');
        await db.query(`DROP TABLE IF EXISTS ${names} CASCADE`);
        console.log(`✓ Dropped ${rows.length} table(s)`);
    }

    // ── Drop all sequences left over (SERIAL columns create named sequences) ─
    const { rows: seqs } = await db.query(`
        SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
    `);
    if (seqs.length > 0) {
        const seqNames = seqs.map(s => `"${s.sequencename}"`).join(', ');
        await db.query(`DROP SEQUENCE IF EXISTS ${seqNames} CASCADE`);
        console.log(`✓ Dropped ${seqs.length} sequence(s)`);
    }

    // ── Re-apply LPF schema ──────────────────────────────────────────────────
    console.log('\nApplying fresh LPF schema...');
    const sql = fs.readFileSync(
        path.join(__dirname, '../src/database/schema.sql'),
        'utf8'
    );
    await db.query(sql);
    console.log('✓ Schema applied\n');

    // ── Confirm tables created ───────────────────────────────────────────────
    const { rows: newTables } = await db.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    console.log('Tables in DB now:');
    newTables.forEach(t => console.log(`  ✓ ${t.tablename}`));

    console.log('\nDone. Run "npm run seed" to insert test jobs.\n');
    process.exit(0);
}

main().catch(err => {
    console.error('\nFailed:', err.message);
    process.exit(1);
});
