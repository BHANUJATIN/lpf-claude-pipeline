/**
 * RetentionService — 30-day data lifecycle for LPF.
 *
 * Operator requirement (verbatim):
 *   "delete people data from DB (not CRM) after 30 days because the cooldown
 *    period for a company is 30 days — if a company posts another SAP job
 *    after 30 days we will process it. Same logic apply for companies."
 *
 * What this does:
 *
 *   1. People (lpf_contacts):
 *      DELETE rows where created_at < NOW() - 30 days.
 *      This frees us to re-discover the same contacts (with fresh emails,
 *      titles, etc.) when the company comes back into the pipeline. RF/CRM
 *      data is untouched — RecruiterFlow is the source of truth.
 *
 *   2. Companies (lpf_companies):
 *      The cache is invalidated by *age*, not deleted. Stage 2's hit check
 *      now requires `updated_at > NOW() - 30 days` — older rows are treated
 *      as stale and a fresh enrich is performed. (We still want the row
 *      around so the operator can see history; we just stop using its data
 *      to short-circuit the pipeline.)
 *
 *   3. Sends (lpf_sends):
 *      Older sends are kept (audit trail).
 *
 * Trigger paths:
 *   - Cron-style: setInterval at server boot runs every 6 hours
 *   - On-demand:  POST /admin/retention/run
 *   - Dry-run:    POST /admin/retention/run?dry=true (counts only, no delete)
 */
const DatabaseClass = require('../database/Database');
const Logger        = require('../Logger');

const logger = new Logger('RetentionService');

const PEOPLE_TTL_DAYS  = parseInt(process.env.PEOPLE_RETENTION_DAYS  || '30', 10);
const COMPANY_TTL_DAYS = parseInt(process.env.COMPANY_COOLDOWN_DAYS  || '30', 10);

function pool() { return DatabaseClass.getInstance().pool; }

/**
 * Returns counts of what's about to be (or just was) cleaned up.
 *   peopleOldCount, companiesStaleCount, peopleDeleted, companiesUntouched
 */
async function previewCounts() {
    const p = pool();
    const r1 = await p.query(
        `SELECT COUNT(*)::int AS n FROM lpf_contacts WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(PEOPLE_TTL_DAYS)]
    );
    // lpf_companies uses `last_seen` (not updated_at). Falls back to created_at.
    const r2 = await p.query(
        `SELECT COUNT(*)::int AS n FROM lpf_companies
         WHERE COALESCE(last_seen, created_at) < NOW() - ($1 || ' days')::interval`,
        [String(COMPANY_TTL_DAYS)]
    );
    return {
        ttl_days: { people: PEOPLE_TTL_DAYS, company: COMPANY_TTL_DAYS },
        people_older_than_ttl:    r1.rows[0]?.n || 0,
        companies_older_than_ttl: r2.rows[0]?.n || 0,
    };
}

/**
 * Run the actual cleanup. With dryRun=true, returns counts but performs no DELETE.
 *
 * Returns:
 *   { ok, deleted_people, stale_companies, last_run_at, dry_run }
 */
async function runCleanup({ dryRun = false } = {}) {
    const t0 = Date.now();
    const counts = await previewCounts();
    if (dryRun) {
        logger.info('Retention dry-run', counts);
        return {
            ok: true,
            dry_run: true,
            deleted_people: 0,
            stale_companies: counts.companies_older_than_ttl,
            preview: counts,
            duration_ms: Date.now() - t0,
        };
    }

    const p = pool();

    // Delete old contacts (and any cascading rows). lpf_contacts has no
    // FK cascade to lpf_sends — the sends rows stay (audit trail).
    const del = await p.query(
        `DELETE FROM lpf_contacts WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING id`,
        [String(PEOPLE_TTL_DAYS)]
    );
    const deletedPeople = del.rowCount || 0;

    logger.info(`Retention cleanup ran — deleted ${deletedPeople} contact(s), ${counts.companies_older_than_ttl} stale company row(s) flagged for re-enrich on next pipeline run`);

    return {
        ok: true,
        dry_run: false,
        deleted_people: deletedPeople,
        stale_companies: counts.companies_older_than_ttl,
        ttl_days: counts.ttl_days,
        last_run_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
    };
}

/**
 * Schedule periodic cleanup. Call once at boot. The interval keeps DB size
 * predictable + makes the company-cooldown rule self-enforcing.
 */
function startScheduledCleanup({ hours = 6 } = {}) {
    if (process.env.RETENTION_AUTORUN === 'false') {
        logger.info('Retention auto-run disabled (RETENTION_AUTORUN=false)');
        return null;
    }
    // First run: 60s after boot (lets the DB settle), then every `hours`.
    setTimeout(() => {
        runCleanup().catch(err => logger.warn('Retention cleanup failed', { error: err.message }));
        setInterval(() => {
            runCleanup().catch(err => logger.warn('Retention cleanup failed', { error: err.message }));
        }, hours * 60 * 60 * 1000);
    }, 60 * 1000);
    logger.info(`Retention scheduler armed — first run in 60s, then every ${hours}h`);
    return { interval_hours: hours };
}

module.exports = {
    PEOPLE_TTL_DAYS,
    COMPANY_TTL_DAYS,
    previewCounts,
    runCleanup,
    startScheduledCleanup,
};
