#!/usr/bin/env node
/**
 * node scripts/jobs.js [--pending] [--processed] [--limit N] [--search TERM]
 *
 * View jobs stored in the local DB.
 */
require('dotenv').config();
const chalk = require('chalk');
const Table = require('cli-table3');
const Database = require('../src/database/Database');
const DatabaseService = require('../src/database/DatabaseService');

const args = process.argv.slice(2);
const showPending   = args.includes('--pending');
const showProcessed = args.includes('--processed');
const limit         = parseInt(getArg(args, '--limit', '30'));
const searchTerm    = getArg(args, '--search', null);

function main() {
    const db = Database.getInstance();
    db.migrate();

    const svc = new DatabaseService();
    const counts = svc.countJobs();

    let processedFilter = null;
    if (showPending)   processedFilter = 0;
    if (showProcessed) processedFilter = 1;

    let jobs = svc.getJobs({ limit, processed: processedFilter });

    if (searchTerm) {
        const term = searchTerm.toLowerCase();
        jobs = jobs.filter(j =>
            (j.job_title   || '').toLowerCase().includes(term) ||
            (j.company_url || '').toLowerCase().includes(term) ||
            (j.sap_tech    || '').toLowerCase().includes(term)
        );
    }

    console.log('');
    console.log(chalk.bold('  claude-jpe — Jobs'));
    console.log('  ─────────────────────────────────────');
    console.log(`  Total: ${counts.total}   Pending: ${chalk.yellow(counts.pending)}   Processed: ${chalk.green(counts.processed)}   Sent: ${chalk.cyan(counts.sent)}`);
    if (searchTerm) console.log(`  Filter: "${searchTerm}"`);
    console.log('');

    if (jobs.length === 0) {
        console.log(chalk.dim('  No jobs found.\n'));
        return;
    }

    const table = new Table({
        head: [
            chalk.bold('ID'),
            chalk.bold('Title'),
            chalk.bold('Company'),
            chalk.bold('Location'),
            chalk.bold('SAP Tech'),
            chalk.bold('Score'),
            chalk.bold('Fit'),
            chalk.bold('Received'),
        ],
        colWidths: [5, 28, 20, 16, 18, 7, 8, 20],
        style: { head: [], border: ['dim'] },
        wordWrap: true,
    });

    for (const job of jobs) {
        const score = job.claude_quality_score;
        const fit   = job.claude_result ? parseField(job.claude_result, 'ctr_fit') : null;

        table.push([
            String(job.id),
            truncate(job.job_title || '—', 26),
            truncate(job.company_url || '—', 18),
            truncate([job.city, job.country].filter(Boolean).join(', ') || '—', 14),
            truncate(job.claude_sap_modules || job.sap_tech || '—', 16),
            score !== null ? String(score) + '/10' : chalk.dim('—'),
            fit ? fitStr(fit) : chalk.dim('—'),
            formatDate(job.received_at),
        ]);
    }

    console.log(table.toString());
    console.log(`  Showing ${jobs.length} of ${counts.total} jobs\n`);
}

function getArg(args, name, defaultVal) {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultVal;
}

function truncate(str, len) {
    if (!str) return '—';
    return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function fitStr(fit) {
    if (fit === 'high')   return chalk.green(fit);
    if (fit === 'medium') return chalk.yellow(fit);
    if (fit === 'low')    return chalk.dim(fit);
    return chalk.red(fit || '—');
}

function parseField(jsonStr, field) {
    try {
        return JSON.parse(jsonStr)[field];
    } catch (_) {
        return null;
    }
}

function formatDate(ts) {
    if (!ts) return '—';
    return ts.replace('T', ' ').slice(0, 16);
}

main();
