#!/usr/bin/env node
/**
 * node scripts/pipeline.js [--limit N]
 *
 * Picks up pending/in-progress jobs and runs each through all 8 stages.
 */
require('dotenv').config();
const chalk    = require('chalk');
const Database = require('../src/database/Database');
const Pipeline = require('../src/pipeline/Pipeline');

const args  = process.argv.slice(2);
const limit = parseInt(getArg(args, '--limit', process.env.PIPELINE_BATCH_SIZE || '10'));

async function main() {
    const db = Database.getInstance();
    await db.connect();

    console.log('');
    console.log(chalk.bold('  claude-jpe — Pipeline'));
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Batch size: ${limit} jobs`);
    console.log('');

    const pipeline = new Pipeline();
    const result   = await pipeline.run(limit);

    console.log('');
    console.log(chalk.bold('  Run complete'));
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Processed : ${chalk.cyan(result.processed)}`);
    console.log(`  Completed : ${chalk.green(result.completed)}`);
    console.log(`  Rejected  : ${chalk.yellow(result.rejected)}`);
    console.log(`  Errors    : ${result.errors > 0 ? chalk.red(result.errors) : chalk.dim('0')}`);
    console.log('');

    process.exit(0);
}

function getArg(args, name, def) {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? args[i + 1] : def;
}

main().catch(err => { console.error(chalk.red('  Error: ' + err.message)); process.exit(1); });
