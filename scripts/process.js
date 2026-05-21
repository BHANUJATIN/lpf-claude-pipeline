#!/usr/bin/env node
/**
 * node scripts/process.js [--limit N] [--dry-run] [--min-score N]
 *
 * Runs Claude analysis on all unprocessed jobs.
 */
require('dotenv').config();
const chalk = require('chalk');
const Database = require('../src/database/Database');
const JobProcessor = require('../src/services/JobProcessor');

const args = process.argv.slice(2);
const limit    = parseInt(getArg(args, '--limit',     '50'));
const minScore = parseInt(getArg(args, '--min-score', '5'));
const dryRun   = args.includes('--dry-run');

async function main() {
    // Ensure DB is ready
    const db = Database.getInstance();
    db.migrate();

    console.log('');
    console.log(chalk.bold('  claude-jpe — Job Processor'));
    console.log('  ─────────────────────────────────────');
    console.log(`  Limit:      ${limit} jobs`);
    console.log(`  Min score:  ${minScore}/10`);
    console.log(`  Dry run:    ${dryRun ? chalk.yellow('yes (no DB writes)') : chalk.green('no')}`);
    console.log('');

    const processor = new JobProcessor();

    try {
        const summary = await processor.run({ limit, minScore, dryRun });

        console.log('');
        console.log(chalk.bold('  Run complete'));
        console.log('  ─────────────────────────────────────');
        console.log(`  Run ID:    ${summary.run_id}`);
        console.log(`  Examined:  ${summary.examined}`);
        console.log(`  Processed: ${summary.processed}`);
        console.log(`  Sent:      ${summary.sent}`);
        console.log('');

        if (summary.results.length > 0) {
            console.log(chalk.bold('  Results (score ≥ ' + minScore + '):'));
            console.log('');
            for (const { job_id, title, result } of summary.results) {
                if (!result || result.quality_score < minScore) continue;
                const fit = fitColor(result.ctr_fit);
                console.log(
                    `  [${job_id}] ${chalk.cyan(title || 'Untitled')}` +
                    `  ${chalk.dim('score:')} ${scoreColor(result.quality_score)}` +
                    `  ${chalk.dim('fit:')} ${fit}` +
                    `  ${chalk.dim('modules:')} ${result.sap_modules?.join(', ') || '—'}`
                );
                if (result.summary) {
                    console.log(`       ${chalk.dim(result.summary)}`);
                }
            }
            console.log('');
        }
    } catch (err) {
        console.error(chalk.red('\n  Error: ' + err.message));
        process.exit(1);
    }
}

function getArg(args, name, defaultVal) {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultVal;
}

function scoreColor(score) {
    if (score >= 8) return chalk.green(score);
    if (score >= 5) return chalk.yellow(score);
    return chalk.red(score);
}

function fitColor(fit) {
    if (fit === 'high')   return chalk.green(fit);
    if (fit === 'medium') return chalk.yellow(fit);
    if (fit === 'low')    return chalk.dim(fit);
    return chalk.red(fit);
}

main();
