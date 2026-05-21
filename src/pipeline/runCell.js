/**
 * runCell — wraps a single enrichment call with full 7-state cell tracking.
 *
 * States: idle | condition_not_met | queued | running | success | success_empty | error
 *
 * Usage (within a stage or pipeline wrapper):
 *   const { result } = await runCell({
 *       jobId: job.id,
 *       colId: 'stage1_sap_check',
 *       fn: () => askJSON(...),
 *       conditionPasses: job.is_dach === true,
 *       conditionReason: 'DACH check not passed',
 *   });
 */

const DatabaseClass   = require('../database/Database');
const emitter         = require('./PipelineEmitter');
const { classifyError } = require('./errors');

const db = { get pool() { return DatabaseClass.getInstance().pool; } };

// ── SSE helper ────────────────────────────────────────────────────────────────

function emitCellState(jobId, colId, state, extra = {}) {
    try {
        emitter.emit('event', {
            type:   'cell_state',
            ts:     Date.now(),
            job_id: jobId,
            col_id: colId,
            state,
            ...extra,
        });
    } catch (_) {}
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function setCellState(jobId, colId, state, opts = {}) {
    try {
        await db.pool.query(
            `INSERT INTO lpf_cell_state
                 (job_id, col_id, state, value, error_msg, error_kind, run_count, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 1, NOW())
             ON CONFLICT (job_id, col_id) DO UPDATE SET
                 state      = EXCLUDED.state,
                 value      = COALESCE(EXCLUDED.value, lpf_cell_state.value),
                 error_msg  = EXCLUDED.error_msg,
                 error_kind = EXCLUDED.error_kind,
                 run_count  = lpf_cell_state.run_count + 1,
                 updated_at = NOW()`,
            [jobId, colId, state,
             opts.value    ?? null,
             opts.errorMsg ?? null,
             opts.errorKind ?? null]
        );
    } catch (_) {}
}

async function insertCellRun(jobId, colId) {
    try {
        const res = await db.pool.query(
            `INSERT INTO lpf_cell_runs (job_id, col_id, status, started_at)
             VALUES ($1, $2, 'running', NOW()) RETURNING id`,
            [jobId, colId]
        );
        return res.rows[0].id;
    } catch (_) { return null; }
}

async function finishCellRun(runId, status, durationMs, opts = {}) {
    if (!runId) return;
    try {
        await db.pool.query(
            `UPDATE lpf_cell_runs
             SET status=$1, duration_ms=$2, value=$3, error_msg=$4, error_kind=$5, ended_at=NOW()
             WHERE id=$6`,
            [status, durationMs,
             opts.value    ?? null,
             opts.errorMsg ?? null,
             opts.errorKind ?? null,
             runId]
        );
    } catch (_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute an enrichment function with full cell-state tracking.
 *
 * @param {object}   opts
 * @param {number}   opts.jobId
 * @param {string}   opts.colId            — matches PIPELINE_COLUMNS[].id in frontend
 * @param {Function} opts.fn               — async () → value
 * @param {boolean}  [opts.conditionPasses=true]
 * @param {string}   [opts.conditionReason]
 * @returns {{ result?, skipped?, reason?, error? }}
 */
async function runCell({ jobId, colId, fn, conditionPasses = true, conditionReason = null }) {
    if (!conditionPasses) {
        await setCellState(jobId, colId, 'condition_not_met', { errorMsg: conditionReason });
        emitCellState(jobId, colId, 'condition_not_met', { reason: conditionReason });
        return { skipped: true, reason: conditionReason };
    }

    const runId = await insertCellRun(jobId, colId);
    await setCellState(jobId, colId, 'running');
    emitCellState(jobId, colId, 'running');

    const t0 = Date.now();
    try {
        const value    = await fn();
        const duration = Date.now() - t0;
        const isEmpty  = value === null || value === undefined || value === '' || value === 0;
        const state    = isEmpty ? 'success_empty' : 'success';
        const valStr   = value != null ? String(value) : null;

        await finishCellRun(runId, state, duration, { value: valStr });
        await setCellState(jobId, colId, state, { value: valStr });
        emitCellState(jobId, colId, state, { value: valStr });

        return { result: value };
    } catch (err) {
        const duration  = Date.now() - t0;
        const errorKind = classifyError(err);

        await finishCellRun(runId, 'error', duration, { errorMsg: err.message, errorKind });
        await setCellState(jobId, colId, 'error', { errorMsg: err.message, errorKind });
        emitCellState(jobId, colId, 'error', { error: err.message, errorKind });

        throw err;
    }
}

/**
 * Set multiple columns to the same state at once (no fn, no run record).
 * Used by Pipeline.js to flip all cells for a stage in bulk.
 */
async function batchSetCellState(jobId, colIds, state, opts = {}) {
    await Promise.all(colIds.map(colId => setCellState(jobId, colId, state, opts)));
    colIds.forEach(colId => emitCellState(jobId, colId, state, opts));
}

/**
 * Mark all columns for stages that haven't started yet as 'queued'.
 * Call once when a job enters the pipeline so the table shows queued dots.
 */
async function queueAllRemaining(jobId, startStageIndex, stageCols) {
    const stageNames = Object.keys(stageCols);
    const pending    = stageNames.slice(startStageIndex);
    const colIds     = pending.flatMap(s => stageCols[s] || []);
    if (colIds.length) await batchSetCellState(jobId, colIds, 'queued');
}

module.exports = { runCell, setCellState, batchSetCellState, queueAllRemaining, emitCellState };
