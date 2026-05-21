#!/usr/bin/env node
/**
 * node scripts/logs.js [--level error|warn|info|debug] [--module NAME] [--limit N] [--tail]
 */
require('dotenv').config();
const chalk    = require('chalk');
const Database = require('../src/database/Database');
const DatabaseService = require('../src/database/DatabaseService');

const args   = process.argv.slice(2);
const level  = getArg(args, '--level',  null);
const mod    = getArg(args, '--module', null);
const limit  = parseInt(getArg(args, '--limit', '60'));
const tail   = args.includes('--tail');

async function main() {
    const db = Database.getInstance();
    await db.connect();
    const svc = new DatabaseService();

    console.log('');
    console.log(chalk.bold('  claude-jpe — Logs'));
    if (level || mod) console.log(`  Filter: ${[level && 'level='+level, mod && 'module='+mod].filter(Boolean).join('  ')}`);
    console.log('');

    await printLogs(svc, limit);

    if (tail) {
        let lastId = await getLastId(svc);
        process.stdout.write(chalk.dim('  [tailing — Ctrl+C to stop]\n\n'));
        setInterval(async () => {
            const rows = await svc.db.queryAll(
                'SELECT * FROM lpf_logs WHERE id > $1 ORDER BY id ASC LIMIT 50',
                [lastId]
            );
            for (const r of rows) { printLine(r); }
            if (rows.length) lastId = rows[rows.length - 1].id;
        }, 3000);
    } else {
        process.exit(0);
    }
}

async function printLogs(svc, n) {
    const logs = await svc.getLogs({ limit: n, level, module: mod });
    for (const log of [...logs].reverse()) printLine(log);
}

function printLine(log) {
    const ts  = String(log.created_at || '').slice(0, 19);
    const lvl = padLevel(log.level);
    const mod = chalk.dim('[' + (log.module || '?').padEnd(18) + ']');
    let meta  = '';
    if (log.meta) {
        try {
            const m = typeof log.meta === 'string' ? JSON.parse(log.meta) : log.meta;
            const keys = Object.keys(m).filter(k => k !== 'module');
            if (keys.length) meta = chalk.dim('  ' + keys.map(k => `${k}=${JSON.stringify(m[k])}`).join(' '));
        } catch (_) { meta = chalk.dim('  ' + String(log.meta)); }
    }
    console.log(`  ${chalk.dim(ts)}  ${lvl}  ${mod}  ${log.message}${meta}`);
}

function padLevel(level) {
    const map = {
        error: chalk.red('ERROR'),  warn:  chalk.yellow('WARN '),
        info:  chalk.cyan('INFO '), debug: chalk.dim('DEBUG'),
    };
    return map[level] || chalk.dim((level || '?').toUpperCase().padEnd(5));
}

async function getLastId(svc) {
    const r = await svc.db.queryOne('SELECT MAX(id) as id FROM lpf_logs');
    return r?.id || 0;
}

function getArg(args, name, def) {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? args[i + 1] : def;
}

main().catch(err => { console.error(chalk.red('Error: ' + err.message)); process.exit(1); });
