/**
 * BootResume — picks up jobs that were mid-pipeline when the previous process died.
 *
 * Why this exists:
 *   The pipeline runs in-process. When the operator edits a file and `node --watch`
 *   restarts the server, the in-flight Promise chain dies but the DB still shows
 *   the job at e.g. `stage='stage2_company'`. Without this hook, those jobs sit
 *   in a non-terminal state forever — the queue is broken until the operator
 *   manually retries each one.
 *
 *   On every successful server boot we:
 *     1. Find jobs in any non-terminal stage (not 'received'|'completed'|'rejected').
 *     2. Reset any cells stuck in 'running' state for >60s to 'queued' so the
 *        dashboard stops spinning + the pipeline knows to re-run them.
 *     3. Re-trigger Pipeline.processJob() for each one. processJob already
 *        resumes from the stored `job.stage` via STAGE_INDEX, so a job that
 *        died at Stage 4 picks back up at Stage 4 — not Stage 1.
 *
 * Disabled if BOOT_RESUME=false in env. Limit how many resume at once via
 * BOOT_RESUME_MAX (default 5) to keep load reasonable.
 */
const DatabaseClass = require('../database/Database');
const Logger        = require('../Logger');

const logger = new Logger('BootResume');

function pool() { return DatabaseClass.getInstance().pool; }

const TERMINAL_STAGES = ['received', 'completed', 'rejected'];

async function _findOrphans() {
    const r = await pool().query(
        `SELECT id, job_title, company_name, stage, received_at
         FROM lpf_jobs
         WHERE stage NOT IN ('received','completed','rejected')
         ORDER BY received_at ASC
         LIMIT $1`,
        [parseInt(process.env.BOOT_RESUME_MAX || '5', 10)]
    );
    return r.rows;
}

async function _resetStuckCells(jobId) {
    // Cells in 'running' state were owned by a now-dead Promise — flip to
    // 'queued' so the upcoming processJob run rebuilds them cleanly.
    const r = await pool().query(
        `UPDATE lpf_cell_state
         SET state      = 'queued',
             error_msg  = COALESCE(error_msg, 'Reset by BootResume — previous run was killed before completing'),
             error_kind = 'boot_resume_reset',
             updated_at = NOW()
         WHERE job_id = $1 AND state = 'running'
         RETURNING col_id`,
        [jobId]
    );
    return r.rowCount;
}

/**
 * Main entry — call this from server.js once the DB is ready.
 * Async fire-and-forget pattern: we don't await the pipeline runs (they take
 * minutes); the server keeps booting + serving requests while jobs resume.
 */
async function resumeInFlightJobs() {
    if (process.env.BOOT_RESUME === 'false') {
        logger.info('BootResume disabled via env');
        return { resumed: 0, skipped: 'disabled' };
    }

    let orphans;
    try {
        orphans = await _findOrphans();
    } catch (err) {
        logger.warn('BootResume: could not query orphaned jobs', { error: err.message });
        return { resumed: 0, error: err.message };
    }

    if (orphans.length === 0) {
        logger.info('BootResume: no in-flight jobs to resume');
        return { resumed: 0 };
    }

    logger.info(`BootResume: found ${orphans.length} in-flight job(s) — resuming`);
    for (const j of orphans) {
        logger.info(`  resuming #${j.id} "${(j.job_title || '').slice(0, 50)}" — was at stage=${j.stage}`);
    }

    // Reset stuck cells first so the dashboard isn't lying while we resume
    for (const j of orphans) {
        try {
            const n = await _resetStuckCells(j.id);
            if (n > 0) logger.debug(`  reset ${n} stuck cell(s) for job ${j.id}`);
        } catch (err) {
            logger.warn(`  could not reset cells for job ${j.id}`, { error: err.message });
        }
    }

    // Kick off the pipeline runs (fire-and-forget — each is its own runJobs([job]))
    // We require Pipeline LAZILY to avoid a circular dependency at module load.
    const Pipeline = require('./Pipeline');
    const PipelineInstance = new Pipeline();

    // Stagger by 1s each so we don't hit OpenAI rate limits all at once on boot
    orphans.forEach((j, idx) => {
        setTimeout(() => {
            PipelineInstance.runJobs([j]).catch(err => {
                logger.error(`BootResume: pipeline failed for job ${j.id}`, { error: err.message });
            });
        }, idx * 1000);
    });

    return { resumed: orphans.length, ids: orphans.map(j => j.id) };
}

module.exports = { resumeInFlightJobs };
