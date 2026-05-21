#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const Database = require('../src/database/Database');

async function main() {
    const db  = Database.getInstance();
    await db.connect();
    console.log('Connected to PostgreSQL');

    const sql = fs.readFileSync(path.join(__dirname, '../src/database/schema.sql'), 'utf8');
    await db.query(sql);
    console.log('Schema applied successfully');
    process.exit(0);
}

main().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
