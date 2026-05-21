#!/usr/bin/env node
require('dotenv').config();
const chalk    = require('chalk');
const Table    = require('cli-table3');
const Database = require('../src/database/Database');
const DatabaseService = require('../src/database/DatabaseService');

async function main() {
    const db  = Database.getInstance();
    await db.connect();
    const svc = new DatabaseService();

    const [jobs, contacts, recentJobs] = await Promise.all([
        svc.countJobs(),
        svc.countContacts(),
        svc.getRecentJobs(10),
    ]);

    console.log('');
    console.log(chalk.bold('  claude-jpe — Status'));
    console.log('  ─────────────────────────────────────────────');
    console.log('');

    // Config
    console.log(chalk.bold('  Config'));
    chk('  OPENAI_API_KEY',       Boolean(process.env.OPENAI_API_KEY));
    chk('  APOLLO_API_KEY',       Boolean(process.env.APOLLO_API_KEY));
    chk('  PROXYCURL_API_KEY',    Boolean(process.env.PROXYCURL_API_KEY));
    chk('  INSTANTLY_API_KEY',    Boolean(process.env.INSTANTLY_API_KEY));
    chk('  INSTANTLY_CAMPAIGN_ID',Boolean(process.env.INSTANTLY_CAMPAIGN_ID));
    chk('  FINDYMAIL_API_KEY',      Boolean(process.env.FINDYMAIL_API_KEY));
    chk('  APIFY_API_KEY',         Boolean(process.env.APIFY_API_KEY), false);
    chk('  SERPER_API_KEY',       Boolean(process.env.SERPER_API_KEY), false);
    chk('  CLEARBIT_API_KEY',     Boolean(process.env.CLEARBIT_API_KEY), false);
    console.log(`  DB           ${chalk.cyan(process.env.POSTGRES_DB || 'claude_lpf')} @ ${process.env.POSTGRES_HOST || 'localhost'}`);

    // Job counts
    console.log('');
    console.log(chalk.bold('  Jobs'));
    row('Total received',     jobs.total);
    row('Pending',            jobs.pending,    'yellow');
    row('Completed',          jobs.completed,  'green');
    row('Rejected',           jobs.rejected,   'dim');
    row('Sent to Instantly',  jobs.sent,       'cyan');

    // Contact counts
    console.log('');
    console.log(chalk.bold('  Contacts'));
    row('Total found',        contacts.total);
    row('Sent to Instantly',  contacts.sent,   'cyan');

    // Recent jobs
    console.log('');
    console.log(chalk.bold('  Recent Jobs'));

    if (recentJobs.length === 0) {
        console.log(chalk.dim('  No jobs yet. Waiting for JPE webhook...'));
    } else {
        const t = new Table({
            head: [chalk.bold('#'), chalk.bold('Title'), chalk.bold('Company'), chalk.bold('Stage'), chalk.bold('Score'), chalk.bold('Modules'), chalk.bold('Received')],
            colWidths: [5, 28, 22, 16, 7, 22, 18],
            style: { head: [], border: ['dim'] },
            wordWrap: true,
        });
        for (const j of recentJobs) {
            t.push([
                String(j.id),
                trunc(j.job_title || '—', 26),
                trunc(j.company_url || '—', 20),
                stageColor(j.stage),
                j.quality_score ? `${j.quality_score}/10` : chalk.dim('—'),
                trunc(j.sap_modules || '—', 20),
                (j.received_at || '').toString().slice(0, 16),
            ]);
        }
        console.log(t.toString());
    }

    console.log('');
    console.log(chalk.bold('  Commands'));
    console.log('  npm run migrate    — apply DB schema');
    console.log('  npm run pipeline   — process pending jobs');
    console.log('  npm run logs       — view recent logs');
    console.log('');
    process.exit(0);
}

function chk(label, ok, required = true) {
    const icon = ok ? chalk.green('✓') : required ? chalk.red('✗') : chalk.yellow('–');
    console.log(`  ${icon} ${label}`);
}
function row(label, value, colour = 'default') {
    const v = value === null || value === undefined ? '—' : String(value);
    const c = colour === 'green' ? chalk.green(v) : colour === 'yellow' ? chalk.yellow(v) : colour === 'cyan' ? chalk.cyan(v) : colour === 'dim' ? chalk.dim(v) : chalk.white(v);
    console.log(`  ${label.padEnd(26)} ${c}`);
}
function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '—'); }
function stageColor(stage) {
    if (!stage) return chalk.dim('—');
    if (stage === 'completed') return chalk.green(stage);
    if (stage === 'rejected')  return chalk.red(stage);
    if (stage === 'received')  return chalk.yellow(stage);
    return chalk.cyan(stage);
}

main().catch(err => { console.error(chalk.red('Error: ' + err.message)); process.exit(1); });
