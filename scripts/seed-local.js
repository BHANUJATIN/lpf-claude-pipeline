#!/usr/bin/env node
/**
 * Seed the local pglite test database with 3 fake SAP jobs.
 * Run after: npm run migrate:local
 */
require('dotenv').config({ path: '.env.test' });

// Re-use the existing seed logic — it picks up DB_LOCAL=true from .env.test
require('./seed');
