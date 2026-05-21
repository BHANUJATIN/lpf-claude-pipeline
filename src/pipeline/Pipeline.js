const DatabaseService  = require('../database/DatabaseService');
const Logger           = require('../Logger');
const emitter          = require('./PipelineEmitter');
const controller       = require('./PipelineController');
const { askJSON }      = require('../services/OpenAIService');
const apify            = require('../services/ApifyService');
const { batchSetCellState, queueAllRemaining, setCellState, emitCellState } = require('./runCell');
const DatabaseClass = require('../database/Database');

/**
 * Flip only the *non-finalized* cells in a stage to a new state.
 * "Finalized" means already in success / success_empty / condition_not_met / error.
 * Used by the stage error/success path so individual cells (DACH, Direct, …) that
 * Stage01 already wrote via setCellState are NOT clobbered.
 */
async function setPendingCellsState(jobId, colIds, newState, opts = {}) {
    const pool = DatabaseClass.getInstance().pool;
    try {
        // Find which cells are still in transient states (queued/running) for this job
        const r = await pool.query(
            `SELECT col_id FROM lpf_cell_state
             WHERE job_id = $1 AND col_id = ANY($2::text[])
               AND state IN ('queued','running','idle')`,
            [jobId, colIds]
        );
        const pending = r.rows.map(row => row.col_id);
        // Also include cells that don't have a row yet
        const seen = new Set(pending);
        const missing = colIds.filter(c => !seen.has(c));
        for (const cid of missing) {
            // Check if a row exists at all; if not, this is a pending cell
            const probe = await pool.query(
                `SELECT 1 FROM lpf_cell_state WHERE job_id=$1 AND col_id=$2 LIMIT 1`,
                [jobId, cid]
            );
            if (probe.rowCount === 0) pending.push(cid);
        }
        for (const cid of pending) {
            await setCellState(jobId, cid, newState, opts);
            emitCellState(jobId, cid, newState, opts);
        }
    } catch (_) {}
}

const Stage01_SAPCheck        = require('./stages/Stage01_SAPCheck');
const Stage02_CompanyEnrich   = require('./stages/Stage02_CompanyEnrich');
const Stage03_TechExtract     = require('./stages/Stage03_TechExtract');
const Stage04_FindPeople      = require('./stages/Stage04_FindPeople');
const Stage05_EnrichContacts  = require('./stages/Stage05_EnrichContacts');
const Stage06_JobPoster       = require('./stages/Stage06_JobPoster');
const Stage07_AIContactSearch = require('./stages/Stage07_AIContactSearch');
const Stage08_SendInstantly   = require('./stages/Stage08_SendInstantly');

const logger = new Logger('Pipeline');

const STAGES = [
    { name: 'stage1_sap',       Class: Stage01_SAPCheck,        nextStage: 'stage2_company'   },
    { name: 'stage2_company',   Class: Stage02_CompanyEnrich,   nextStage: 'stage3_tech'      },
    { name: 'stage3_tech',      Class: Stage03_TechExtract,     nextStage: 'stage4_people'    },
    { name: 'stage4_people',    Class: Stage04_FindPeople,      nextStage: 'stage5_enrich'    },
    { name: 'stage5_enrich',    Class: Stage05_EnrichContacts,  nextStage: 'stage6_poster'    },
    { name: 'stage6_poster',    Class: Stage06_JobPoster,       nextStage: 'stage7_ai_search' },
    { name: 'stage7_ai_search', Class: Stage07_AIContactSearch, nextStage: 'post_processing'  },
];

const STAGE_INDEX = {};
STAGES.forEach((s, i) => { STAGE_INDEX[s.name] = i; });

// Maps each pipeline stage to the frontend PIPELINE_COLUMNS ids it populates.
// Used by runCell to emit cell_state SSE events and write lpf_cell_state rows.
const STAGE_COLS = {
    stage1_sap:       ['stage1_dach', 'stage1_direct', 'stage1_sap_check', 'stage1_score', 'stage1_fit'],
    stage2_company:   ['stage2_enrich', 'stage2_apify', 'stage2_industry', 'stage2_employees'],
    stage3_tech:      ['stage3_tech_extract', 'stage3_sap_modules', 'stage3_city_industry', 'stage3_tech_comma'],
    stage4_people:    ['stage4_apollo', 'stage4_linkedin', 'stage4_people_total'],
    stage5_enrich:    ['stage5_fm', 'stage5_ap', 'stage5_hv', 'stage5_tk'],
    stage6_poster:    ['stage6_job_poster'],
    stage7_ai_search: ['stage7_ai_search'],
};

// How many jobs to process simultaneously (configurable via env)
const CONCURRENCY = parseInt(process.env.PIPELINE_CONCURRENCY || '5');

function emit(type, data = {}) {
    try { emitter.emit('event', { type, ts: Date.now(), ...data }); } catch (_) {}
}

class Pipeline {
    constructor() {
        this.db = new DatabaseService();
    }

    /**
     * Run a specific list of jobs (already fetched). Emits pipeline_start/done.
     * Used by run-batch and single-job endpoints so SSE + controller work correctly.
     */
    async runJobs(jobs) {
        if (!jobs.length) {
            emit('pipeline_done', { stats: { processed: 0, completed: 0, rejected: 0, errors: 0 } });
            return;
        }
        controller.start();
        emit('pipeline_start', { total: jobs.length, concurrency: CONCURRENCY });
        const stats = await this._runConcurrent(jobs, Math.min(CONCURRENCY, jobs.length));
        stats.processed = jobs.length;
        emit('pipeline_done', { stats });
        controller.reset();
        return stats;
    }

    /**
     * Pick up ALL pending/in-progress jobs and run them concurrently.
     * opts.autoApprove = true → after all stages complete, auto-approve contacts and send to Instantly.
     */
    async run(batchSize = 9999, opts = {}) {
        controller.start();
        const receivedJobs = await this.db.getPendingJobs(batchSize);

        const inProgressJobs = [];
        for (const stageDef of STAGES.slice(0, -1)) {
            const jobs = await this.db.getJobsForStage(stageDef.name, batchSize);
            inProgressJobs.push(...jobs);
        }

        // Deduplicate
        const seen = new Set();
        const allJobs = [...receivedJobs, ...inProgressJobs].filter(j => {
            if (seen.has(j.id)) return false;
            seen.add(j.id);
            return true;
        });

        if (allJobs.length === 0) {
            logger.info('No jobs to process');
            emit('pipeline_done', { stats: { processed: 0, completed: 0, rejected: 0, errors: 0 } });
            controller.reset();
            return { processed: 0, completed: 0, rejected: 0, errors: 0 };
        }

        logger.info(`Running pipeline for ${allJobs.length} jobs (concurrency=${CONCURRENCY}, autoApprove=${!!opts.autoApprove})`);
        emit('pipeline_start', { total: allJobs.length, concurrency: CONCURRENCY });

        const stats = await this._runConcurrent(allJobs, CONCURRENCY, opts);
        stats.processed = allJobs.length;

        logger.info('Pipeline run finished', stats);
        emit('pipeline_done', { stats });
        controller.reset();
        return stats;
    }

    /**
     * Process jobs in a worker-pool: up to CONCURRENCY jobs run simultaneously.
     * Each worker picks the next job from the queue when it finishes its current one.
     */
    async _runConcurrent(jobs, concurrency, opts = {}) {
        const queue = [...jobs];
        const results = { completed: 0, rejected: 0, errors: 0 };

        const worker = async () => {
            while (queue.length > 0) {
                if (controller.shouldStop()) {
                    logger.info('Pipeline stop requested — worker exiting');
                    emit('pipeline_stopping', {});
                    break;
                }
                const job = queue.shift();
                if (!job) break;
                try {
                    const result = await this.processJob(job, opts);
                    if (result === 'review' || result === 'completed' || result === 'sent') results.completed++;
                    else if (result === 'rejected') results.rejected++;
                    else results.errors++;
                } catch (err) {
                    logger.error(`Unhandled error for job ${job.id}`, { error: err.message });
                    emit('job_done', { job_id: job.id, result: 'error', error: err.message });
                    results.errors++;
                }
            }
        };

        // Spin up N workers, each draining from the shared queue
        const workers = Array.from(
            { length: Math.min(concurrency, jobs.length) },
            () => worker()
        );
        await Promise.all(workers);
        return results;
    }

    /**
     * Pre-flight: run before Stage 1 on 'received' jobs.
     * 1. Scrape full job description if it's too short (< 200 chars).
     * 2. Infer country if missing — from URL TLD → JD keywords → GPT.
     * Writes changes back to DB so Stage 1 sees the enriched job.
     */
    async _preflightEnrich(job) {
        const updates = {};

        // ── 1. Scrape full description if too short ──────────────────────────
        const descLen = (job.job_description || '').trim().length;
        if (descLen < 200 && job.job_url) {
            emit('field_running', { job_id: job.id, field: 'preflight_desc', label: 'Scraping job description' });
            try {
                const scraped = await apify.scrapeCompanyWebsite(job.job_url, 45);
                if (scraped && scraped.length > descLen) {
                    updates.job_description = scraped.slice(0, 15000);
                    job.job_description     = updates.job_description;
                    emit('field_done', { job_id: job.id, field: 'preflight_desc', value: `Scraped ${updates.job_description.length} chars` });
                    logger.debug(`Preflight: scraped ${updates.job_description.length}-char description for job ${job.id}`);
                } else {
                    emit('field_done', { job_id: job.id, field: 'preflight_desc', value: 'No better description found' });
                }
            } catch (err) {
                logger.warn(`Preflight scrape failed for job ${job.id}`, { error: err.message });
                emit('field_done', { job_id: job.id, field: 'preflight_desc', value: 'Scrape failed' });
            }
        }

        // ── 2. Infer country if missing ──────────────────────────────────────
        if (!job.country || job.country.trim() === '') {
            emit('field_running', { job_id: job.id, field: 'preflight_country', label: 'Inferring country' });

            let inferred = null;

            // Step A: TLD of job_url or company_url
            const tldCountry = inferCountryFromTLD(job.job_url) || inferCountryFromTLD(job.company_url);
            if (tldCountry) {
                inferred = tldCountry;
                logger.debug(`Preflight: country inferred from TLD: ${inferred}`, { job_id: job.id });
            }

            // Step B: DACH keyword scan in job description / title
            if (!inferred) {
                inferred = inferCountryFromText(job.job_description || '') ||
                           inferCountryFromText(job.job_title       || '');
                if (inferred) logger.debug(`Preflight: country inferred from text keywords: ${inferred}`, { job_id: job.id });
            }

            // Step C: GPT fallback
            if (!inferred && (job.job_description || '').length > 100) {
                try {
                    const ai = await askJSON(
                        'You are a location analyst. Output ONLY valid JSON — no markdown.',
                        `What country is this job posting from? Look for city names, postal codes, language, phone prefixes.
Reply with ONLY: {"country": "Germany"} or {"country": "Austria"} or {"country": "Switzerland"} or {"country": null} if unknown.

JOB TITLE: ${job.job_title || ''}
DESCRIPTION (first 1000 chars): ${(job.job_description || '').slice(0, 1000)}`,
                        'gpt-4o-mini',
                        { jobId: job.id, operation: 'preflight_country_infer' }   // already tagged
                    );
                    if (ai?.country) {
                        inferred = ai.country;
                        logger.debug(`Preflight: country inferred via GPT: ${inferred}`, { job_id: job.id });
                    }
                } catch (err) {
                    logger.warn(`Preflight GPT country infer failed`, { job_id: job.id, error: err.message });
                }
            }

            if (inferred) {
                updates.country = inferred;
                job.country     = inferred;
                emit('field_done', { job_id: job.id, field: 'preflight_country', value: inferred });
            } else {
                emit('field_done', { job_id: job.id, field: 'preflight_country', value: 'unknown — will reject' });
            }
        }

        if (Object.keys(updates).length > 0) {
            await this.db.updateJobFields(job.id, updates);
        }
    }

    /**
     * Run a single job through all stages, starting from its current stage.
     * opts.autoApprove = true → auto-approve contacts and call sendJob() when done.
     */
    async processJob(job, opts = {}) {
        const startIndex = job.stage === 'received'
            ? 0
            : (STAGE_INDEX[job.stage] ?? 0);

        logger.info(`Processing job [${job.id}] "${job.job_title}" — from ${STAGES[startIndex]?.name || 'unknown'}`, {
            job_id:  job.id,
            company: job.company_url,
        });

        emit('job_start', {
            job_id:    job.id,
            job_title: job.job_title,
            company:   job.company_name || job.company_url,
            stage:     STAGES[startIndex]?.name,
        });

        // Pre-flight: scrape description + infer country for fresh jobs
        if (job.stage === 'received') {
            try { await this._preflightEnrich(job); } catch (_) {}
        }

        // Mark all remaining stage columns as queued so the table shows pending dots
        try { await queueAllRemaining(job.id, startIndex, STAGE_COLS); } catch (_) {}

        for (let i = startIndex; i < STAGES.length; i++) {
            if (controller.shouldStop()) {
                logger.warn(`Job [${job.id}] paused — stop requested`);
                emit('job_done', { job_id: job.id, result: 'stopped' });
                return 'stopped';
            }
            const stageDef = STAGES[i];
            const stage    = new stageDef.Class(this.db);
            const stageCols = STAGE_COLS[stageDef.name] || [];
            const t0       = Date.now();

            logger.info(`  [${job.id}] starting ${stageDef.name}`);
            emit('stage_start', { job_id: job.id, stage: stageDef.name });
            await this.db.logStage(job.id, stageDef.name, 'started', null);

            // Flip stage columns to running
            try { await batchSetCellState(job.id, stageCols, 'running'); } catch (_) {}

            try {
                const freshJob = await this.db.getJobById(job.id);
                // Per-stage watchdog — guarantees no single stage can hang the
                // pipeline forever even when an underlying provider (OpenAI,
                // Google Sheets, RF, Apify) gets stuck without responding.
                // Default 240s, override via STAGE_TIMEOUT_MS env var.
                const STAGE_TIMEOUT_MS = parseInt(process.env.STAGE_TIMEOUT_MS || '240000', 10);
                const result = await Promise.race([
                    stage.run(freshJob),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error(`Stage "${stageDef.name}" exceeded ${STAGE_TIMEOUT_MS}ms watchdog timeout — likely an external API hang`)),
                        STAGE_TIMEOUT_MS,
                    )),
                ]);
                const duration = Date.now() - t0;

                if (result.rejected) {
                    await this.db.markJobRejected(job.id, result.reason);
                    await this.db.logStage(job.id, stageDef.name, 'skipped', result.reason, null, duration);
                    logger.warn(`Job [${job.id}] rejected at ${stageDef.name}: ${result.reason}`);
                    emit('job_rejected', { job_id: job.id, stage: stageDef.name, reason: result.reason });
                    // Mark ALL remaining stage columns (current + future) as condition_not_met
                    // so nothing is left in "queued" state after rejection.
                    const allRemainingCols = STAGES.slice(i).flatMap(s => STAGE_COLS[s.name] || []);
                    try { await setPendingCellsState(job.id, allRemainingCols, 'condition_not_met', { errorMsg: result.reason }); } catch (_) {}
                    return 'rejected';
                }

                await this.db.updateJobStage(job.id, stageDef.nextStage, result.fields || {});
                await this.db.logStage(job.id, stageDef.name, 'completed', result.message || null, result.logData || null, duration);

                // Aggregate OpenAI cost spent during this stage so it can be shown
                // inline in the activity feed (per-prompt provider-reported cost).
                let stageCost = null;
                try {
                    const pool = DatabaseClass.getInstance().pool;
                    const r = await pool.query(
                        `SELECT COUNT(*) AS calls, SUM(cost_usd) AS usd,
                                SUM(input_tokens) AS tin, SUM(output_tokens) AS tout
                         FROM lpf_api_costs
                         WHERE job_id = $1 AND service = 'openai' AND created_at >= $2`,
                        [job.id, new Date(t0)]
                    );
                    const row = r.rows[0] || {};
                    if (parseInt(row.calls || 0) > 0) {
                        stageCost = {
                            calls: parseInt(row.calls),
                            usd:   parseFloat(row.usd || 0),
                            input_tokens:  parseInt(row.tin  || 0),
                            output_tokens: parseInt(row.tout || 0),
                        };
                    }
                } catch (_) {}

                logger.info(`  [${job.id}] ${stageDef.name} done (${duration}ms)`,
                    { ...(result.summary || {}), ...(stageCost ? { cost_usd: stageCost.usd.toFixed(5) } : {}) });
                emit('stage_done', {
                    job_id:      job.id,
                    stage:       stageDef.name,
                    duration_ms: duration,
                    message:     result.message || null,
                    summary:     result.summary || {},
                    cost:        stageCost,
                });

                // Mark only still-pending stage columns success — success_empty if no output fields.
                // This preserves per-cell states that the stage already set (e.g. DACH=success, Score=success).
                const hasFields = result.fields && Object.keys(result.fields).length > 0;
                try { await setPendingCellsState(job.id, stageCols, hasFields ? 'success' : 'success_empty'); } catch (_) {}

                if (result.fields) Object.assign(job, result.fields);

            } catch (err) {
                const duration = Date.now() - t0;
                await this.db.logStage(job.id, stageDef.name, 'failed', err.message, null, duration);
                logger.error(`Job [${job.id}] failed at ${stageDef.name}`, { error: err.message });
                emit('stage_fail', { job_id: job.id, stage: stageDef.name, error: err.message, duration_ms: duration });
                // CRITICAL: only mark cells still in queued/running as error.
                // Deterministic cells (DACH, Direct) that succeeded earlier in this stage must KEEP their success state.
                try { await setPendingCellsState(job.id, stageCols, 'error', { errorMsg: err.message }); } catch (_) {}

                // ── Resilience: don't halt the entire job on a single stage error ──
                // The user explicitly requested that if one provider/stage fails
                // (Apollo out of credits, Proxycurl missing, etc.), the pipeline
                // continues with whatever data we already have. Subsequent stages
                // can still produce useful output (CV generation, CRM push, sheet
                // write all work off whatever stage 1-3 captured).
                //
                // Stage 1 is the exception — without its DACH/SAP/quality scoring
                // there's nothing downstream can usefully do, so we still halt.
                if (stageDef.name === 'stage1_sap') {
                    return 'error';
                }

                // Advance the job to the next stage so the loop continues.
                await this.db.updateJobStage(job.id, stageDef.nextStage, {}).catch(() => {});
                logger.warn(`Job [${job.id}] continuing past ${stageDef.name} failure — degraded mode`);
                continue;
            }
        }

        // All 7 stages done — update total contact count
        const totalContacts = await this.db.countContactsForJob(job.id);
        await this.db.updateJobFields(job.id, { total_people_found: totalContacts });

        // ── NO MORE REVIEW STATE ──
        // Per operator request, the pipeline now auto-runs all post-Stage-7 work
        // (HeyReach gen, CV gen, SAP-sheet write, CRM push, HeyReach send,
        // Instantly send) and marks the job 'completed' regardless of which
        // outbound channel succeeds. Failures are logged but never block the
        // job from reaching its terminal state.
        logger.info(`Job [${job.id}] completed stages 1-7 — ${totalContacts} contacts; entering post-processing`, { job_id: job.id });
        emit('field_done', { job_id: job.id, field: 's4_people', value: String(totalContacts) });

        // ── Auto-generate HeyReach AI content (Connection Req + German InMail) ───
        // Runs for every contact with a LinkedIn URL that doesn't yet have a generated
        // message. Set HEYREACH_AUTO_GEN=false to disable.
        if (process.env.HEYREACH_AUTO_GEN !== 'false') {
            try {
                await this._runHeyReachGen(job.id);
            } catch (err) {
                logger.warn(`Job [${job.id}] HeyReach auto-generate failed`, { error: err.message });
            }
        }

        // ── CV pipeline (eligibility → EN JSON → DE JSON → 2 PDFs via Apps Script) ──
        // Runs BEFORE the SAP-jobs-sheet write so both PDF URLs are available
        // when we upsert the job row into the sheet. Set CV_AUTO_GEN=false to disable.
        if (process.env.CV_AUTO_GEN !== 'false') {
            try {
                await this._runCVGeneration(job.id);
            } catch (err) {
                logger.warn(`Job [${job.id}] CV auto-generate failed`, { error: err.message });
            }
        }

        // ── Write the SAP job row to the operator-configured jobs sheet ──────────
        // No lookup — this sheet is write-only by spec. One row per processed job.
        try { await this._writeSapJobToSheet(job.id); } catch (err) {
            logger.warn(`Job [${job.id}] SAP jobs sheet write failed`, { error: err.message });
        }

        // ── Auto-push to RecruiterFlow CRM ───────────────────────────────────────
        // Always runs when the API key is set and the job didn't get rejected.
        // Set CRM_AUTO_PUSH=false to disable.
        if (process.env.RECRUITERFLOW_API_KEY && process.env.CRM_AUTO_PUSH !== 'false') {
            try {
                await this._runCRMPush(job.id);
            } catch (err) {
                logger.warn(`Job [${job.id}] CRM auto-push failed`, { error: err.message });
            }
        }

        // ── HeyReach send (DACH-only, after everything else is ready) ────────
        // Sends contacts that:
        //   • passed the DACH-by-LinkedIn check ('yes')
        //   • have AI content (inmail_body_de + connection_req) ready
        //   • haven't already been sent
        // Set HEYREACH_AUTO_SEND=false in .env to keep generation-only and trigger send manually.
        if (process.env.HEYREACH_API_KEY && process.env.HEYREACH_AUTO_SEND !== 'false') {
            try {
                await this._runHeyReachSend(job.id);
            } catch (err) {
                logger.warn(`Job [${job.id}] HeyReach auto-send failed`, { error: err.message });
            }
        }

        // ── Instantly send (final outbound step) ─────────────────────────────
        // Auto-runs whenever INSTANTLY_API_KEY is present. Per the operator's
        // explicit request, there is NO review gate — every contact found by
        // the pipeline gets auto-approved and pushed to Instantly here.
        // Failures are caught + logged; they never prevent the job from
        // reaching 'completed'.
        if (process.env.INSTANTLY_API_KEY) {
            try {
                logger.info(`Job [${job.id}] auto-approving + pushing all contacts to Instantly`);
                await this.db.approveAllContacts(job.id, 'instantly', null).catch(() => {});
                await this._runInstantlySend(job.id);
            } catch (err) {
                logger.warn(`Job [${job.id}] Instantly auto-send failed (continuing to completed anyway)`, { error: err.message });
            }
        } else {
            logger.info(`Job [${job.id}] Instantly send skipped — INSTANTLY_API_KEY not configured`);
        }

        // ── Mark job 'completed' regardless of outbound channel results ──────
        // The review state has been removed by design. Use `total_people_found`
        // + `crm_status` + the lpf_sends table to see what happened.
        try {
            await this.db.updateJobStage(job.id, 'completed', {}).catch(() => {});
        } catch (_) {}

        emit('job_done', { job_id: job.id, result: 'completed', contacts: totalContacts });
        return 'completed';
    }

    /**
     * Full CV pipeline for one job:
     *   1. POST to external eligibility endpoint
     *   2. If eligible: generate English structured CV (OpenAI)
     *   3. Translate English JSON → German JSON (OpenAI)
     *   4. POST both to Google Apps Script PDF renderer → two pdfUrls
     *   5. Persist everything to lpf_jobs
     *
     * Runs as a single pipeline stage so the dashboard activity feed gets a
     * stage_start/stage_done pair with the total token cost.
     */
    async _runCVGeneration(jobId) {
        const CV = require('../services/CVGenerationService');

        emit('stage_start', { job_id: jobId, stage: 'cv_generation' });
        await this.db.logStage(jobId, 'cv_generation', 'started', null).catch(() => {});
        const t0 = Date.now();

        try {
            const job = await this.db.getJobById(jobId);
            if (!job) throw new Error(`Job ${jobId} not found`);

            const result = await CV.generateAll(job);

            const updates = {
                cv_eligible:    !!result.eligible,
                cv_eligibility: result.eligibility || null,
                cv_generated_at: new Date(),
            };
            if (result.eligible) {
                updates.english_cv_json     = result.english;
                updates.german_cv_json      = result.german;
                updates.english_cv_text     = _stringifyForLegacyColumn(result.english);
                updates.cv_german_text      = _stringifyForLegacyColumn(result.german);
                updates.cv_pdf_url_english  = result.englishPdf?.pdfUrl || null;
                updates.cv_pdf_url_german   = result.germanPdf?.pdfUrl  || null;
                updates.cv_pdf_doc_id_english = result.englishPdf?.docId || null;
                updates.cv_pdf_doc_id_german  = result.germanPdf?.docId  || null;
                updates.cv_cost_usd         = result.costs?.total?.usd?.toFixed(6) || null;
                updates.cv_cost_breakdown   = result.costs || null;
                updates.cv_error            = result.errors || null;
            } else {
                updates.cv_error = result.eligibility?.error
                    || `Not eligible (canGenerateCV=${result.eligibility?.canGenerateCV})`;
            }
            await this.db.updateJobFields(jobId, updates).catch(() => {});

            const duration = Date.now() - t0;
            await this.db.logStage(jobId, 'cv_generation',
                result.eligible ? 'completed' : 'skipped',
                result.eligible
                    ? `CV ready — EN: ${result.englishPdf?.pdfUrl ? '✓' : '—'} · DE: ${result.germanPdf?.pdfUrl ? '✓' : '—'} · $${(result.costs?.total?.usd ?? 0).toFixed(5)}`
                    : `Not eligible: ${updates.cv_error}`,
                {
                    eligible:   result.eligible,
                    cost_usd:   result.costs?.total?.usd ?? 0,
                    english_pdf_url: result.englishPdf?.pdfUrl,
                    german_pdf_url:  result.germanPdf?.pdfUrl,
                },
                duration).catch(() => {});

            logger.info(`Job [${jobId}] CV pipeline ${result.eligible ? 'completed' : 'skipped'}`, {
                eligible:    result.eligible,
                english_pdf: result.englishPdf?.pdfUrl,
                german_pdf:  result.germanPdf?.pdfUrl,
                cost:        result.costs?.total?.usd?.toFixed(5),
            });
            emit('stage_done', {
                job_id:      jobId,
                stage:       'cv_generation',
                duration_ms: duration,
                summary:     {
                    eligible:        result.eligible,
                    english_pdf_url: result.englishPdf?.pdfUrl,
                    german_pdf_url:  result.germanPdf?.pdfUrl,
                },
                cost: result.costs ? {
                    calls:         2,
                    usd:           result.costs.total.usd,
                    input_tokens:  result.costs.total.input,
                    output_tokens: result.costs.total.output,
                } : null,
            });
            return result;
        } catch (err) {
            const duration = Date.now() - t0;
            await this.db.updateJobFields(jobId, { cv_error: err.message }).catch(() => {});
            await this.db.logStage(jobId, 'cv_generation', 'failed', err.message, null, duration).catch(() => {});
            logger.error(`Job [${jobId}] CV pipeline failed`, { error: err.message });
            emit('stage_fail', { job_id: jobId, stage: 'cv_generation', error: err.message, duration_ms: duration });
            throw err;
        }
    }

    /**
     * Append the SAP job row to the operator-configured Google Sheet
     * (purpose='sap_jobs_write'). APPEND-ONLY — every pipeline run produces a
     * fresh row; no lookup, no upsert. (The job_url unique constraint on
     * lpf_jobs already prevents duplicate pipeline runs.)
     *
     * Pre-flight audit:
     *   • Reads the sheet's actual header row.
     *   • Cross-references the connection's column_mapping against both the
     *     headers AND the fields we're about to write.
     *   • Logs a coverage report: how many sheet columns got a value, which
     *     pipeline fields had no mapping, which conditional fields stayed empty.
     *
     * Runs AFTER CV generation so cv_pdf_url_english / cv_pdf_url_german are
     * already on the job row and will land in the same sheet line.
     */
    async _writeSapJobToSheet(jobId) {
        const Connections = require('../services/ConnectionService');
        const GSheet      = require('../services/GoogleSheetsServiceV2');

        const conn = await Connections.getDefault('google_sheet', 'sap_jobs_write').catch(() => null);
        const SapSheetWriter = require('../services/SapSheetWriterService');

        // No OAuth-based sheet connection AND no Apps Script URL? Then there's
        // nowhere to write — skip silently with a one-line audit log so the
        // operator can see in the activity feed that nothing was written.
        if (!conn && !SapSheetWriter.isConfigured()) {
            logger.warn(`Job [${jobId}] SAP sheet write skipped — neither google_sheet/sap_jobs_write conn nor SAP_SHEET_APPS_SCRIPT_URL configured`);
            return;
        }

        emit('stage_start', { job_id: jobId, stage: 'sap_jobs_sheet' });
        await this.db.logStage(jobId, 'sap_jobs_sheet', 'started', null).catch(() => {});
        const t0 = Date.now();

        try {
            const job = await this.db.getJobById(jobId);
            if (!job) throw new Error(`Job ${jobId} not found`);

            // ── Build the "Tech" comma-list ────────────────────────────────────
            // Sheet wants e.g. "PM, S/4HANA, NetWeaver, ABAP". We assemble from
            // whatever the pipeline collected (sap_modules + top_job_tech_comma
            // + tech_short), deduping + cleaning separators.
            const techParts = new Set();
            const pushFrom = (s) => {
                if (!s) return;
                String(s).split(/[,/|]/).map(x => x.trim()).filter(Boolean).forEach(t => techParts.add(t));
            };
            pushFrom(job.sap_modules);
            pushFrom(job.top_job_tech_comma);
            pushFrom(job.shorter_tech_comma);
            pushFrom(job.tech_short);
            const techCsv = Array.from(techParts).join(', ');

            // ── Record keyed to the EXACT sheet column headers ────────────────
            // The Apps Script writer aligns row values to existing headers, so
            // these strings must match the sheet 1:1 (including spaces +
            // brackets + the documented typos).
            const record = {
                'Job Title':                       job.job_title || '',
                'Tech':                            techCsv,
                'Top job post URL':                job.job_url || '',
                'Created At':                      job.received_at ? new Date(job.received_at).toISOString() : new Date().toISOString(),
                'Company URL':                     job.company_url || '',
                'Company LinkedIn URL':            job.company_linkedin_url || '',
                '[Top job] City':                  job.city || '',
                'Latitude':                        '',   // not collected by pipeline yet
                'Longitude':                       '',   // not collected by pipeline yet
                'Country':                         job.country || '',
                'Job Poster Url':                  job.job_poster_linkedin || job.job_poster_url || '',
                'DACH Employees Number':           job.company_dach_employees != null ? String(job.company_dach_employees) : '',
                'World Employee Estimate':         job.company_employee_count  != null ? String(job.company_employee_count)  : '',
                'Fake CV Wanted':                  job.cv_eligible === true ? 'Yes' : (job.cv_eligible === false ? 'No' : ''),
                'Fake CV Approved?':               '',   // operator fills manually
                'Fake German CV (Doc Link)':       job.cv_pdf_url_german  || '',
                'Fake English CV (Doc Link)':      job.cv_pdf_url_english || '',
                'Fake CV Uploaded?':               (job.cv_pdf_url_english || job.cv_pdf_url_german) ? 'Yes' : '',
                'Date CV Uploaded':                (job.cv_pdf_url_english || job.cv_pdf_url_german) && job.cv_generated_at
                                                       ? new Date(job.cv_generated_at).toISOString().slice(0, 10) : '',
                'Carl Comments':                   '',   // operator fills manually
                'Sami Comment was CV submittes YES': '', // operator fills manually
            };

            // ── Validate required fields BEFORE we hit the network ────────────
            // Spec from operator:
            //   • Country: must
            //   • Company URL OR Company LinkedIn URL: at least one
            //   • Tech: must (we always have something for SAP jobs)
            //   • Job Title / Top job post URL / Created At: must
            //   • CV doc links: must
            //   • City: optional
            //   • Lat/Long: optional
            //   • Job Poster Url: optional
            const required = [];
            if (!record['Job Title'])         required.push('Job Title');
            if (!record['Top job post URL']) required.push('Top job post URL');
            if (!record['Country'])           required.push('Country');
            if (!record['Tech'])              required.push('Tech');
            if (!record['Created At'])        required.push('Created At');
            if (!record['Company URL'] && !record['Company LinkedIn URL']) {
                required.push('Company URL OR Company LinkedIn URL');
            }
            if (required.length) {
                const msg = `SAP sheet write skipped — required field(s) missing: ${required.join(', ')}`;
                logger.warn(msg, { job_id: jobId });
                await this.db.logStage(jobId, 'sap_jobs_sheet', 'skipped', msg, { missing: required }, Date.now() - t0).catch(() => {});
                emit('stage_fail', { job_id: jobId, stage: 'sap_jobs_sheet', error: msg });
                return;
            }

            // Sheet columns the operator fills manually — never warn about these being blank
            const CONDITIONAL = new Set([
                'Latitude', 'Longitude', '[Top job] City', 'Job Poster Url',
                'DACH Employees Number', 'World Employee Estimate',
                'Fake CV Approved?', 'Fake CV Uploaded?', 'Date CV Uploaded',
                'Carl Comments', 'Sami Comment was CV submittes YES',
            ]);

            // ── Two-path writer ──────────────────────────────────────────────
            // Path A: native — operator wired a google_sheet/sap_jobs_write conn with OAuth
            // Path B: Apps Script — public web app URL in SAP_SHEET_APPS_SCRIPT_URL
            // We try A first when configured; if A fails OR isn't set, fall back to B.
            let nativeOk         = false;
            let nativeErr        = null;
            let nativeAudit      = null;
            let nativeSummary    = null;
            let appsScriptResult = null;

            if (conn) {
                try {
                    // ── Pre-flight: read sheet headers + audit coverage ──────
                    let headers = [];
                    try {
                        const s = await GSheet.readSheet(conn.config);
                        headers = s.headers || [];
                    } catch (err) {
                        logger.warn(`SAP sheet header read failed (writing anyway)`, { error: err.message });
                    }

                    const mapping = conn.config.column_mapping || {};
                    const audit = {
                        sheet_columns_total:    headers.length,
                        fields_with_value:      0,
                        fields_blank:           0,
                        mapped_and_filled:      [],
                        mapped_but_blank:       [],
                        unmapped_with_value:    [],
                        unmapped_no_value:      [],
                        mapping_points_to_missing_header: [],
                    };
                    for (const [field, value] of Object.entries(record)) {
                        const header = mapping[field];
                        const hasValue = value !== '' && value != null;
                        if (hasValue) audit.fields_with_value++; else audit.fields_blank++;
                        if (header) {
                            if (headers.length && !headers.includes(header)) {
                                audit.mapping_points_to_missing_header.push({ field, header });
                            } else if (hasValue) {
                                audit.mapped_and_filled.push(field);
                            } else {
                                audit.mapped_but_blank.push(field);
                            }
                        } else {
                            if (hasValue) audit.unmapped_with_value.push(field);
                            else          audit.unmapped_no_value.push(field);
                        }
                    }
                    const guaranteedUnmapped = audit.unmapped_with_value.filter(f => !CONDITIONAL.has(f));
                    if (guaranteedUnmapped.length) {
                        logger.warn(`SAP sheet — ${guaranteedUnmapped.length} guaranteed field(s) have no column_mapping → values will be dropped`, { fields: guaranteedUnmapped });
                    }

                    await GSheet.appendRow(conn.config, record);
                    nativeOk      = true;
                    nativeAudit   = audit;
                    nativeSummary = {
                        path:    'native_oauth',
                        sheet:   conn.name,
                        cols:    audit.sheet_columns_total,
                        filled:  audit.mapped_and_filled.length,
                        blank:   audit.mapped_but_blank.length,
                        dropped: audit.unmapped_with_value.length,
                        missing: audit.mapping_points_to_missing_header.length,
                    };
                } catch (err) {
                    nativeErr = err.message;
                    logger.warn(`SAP sheet native append failed — will try Apps Script fallback`, { error: err.message });
                }
            }

            // ── Apps Script fallback ─────────────────────────────────────────
            // Runs when (a) no native conn exists OR (b) native append failed.
            if (!nativeOk && SapSheetWriter.isConfigured()) {
                appsScriptResult = await SapSheetWriter.appendJobRow(record);
                if (!appsScriptResult.ok) {
                    logger.warn(`SAP sheet Apps Script append failed`, { error: appsScriptResult.error });
                }
            }

            const duration = Date.now() - t0;

            if (nativeOk) {
                const msg = `Appended via native OAuth · ${nativeSummary.filled}/${nativeSummary.cols} columns filled` +
                    (nativeSummary.blank   ? ` · ${nativeSummary.blank} blank (conditional)` : '') +
                    (nativeSummary.dropped ? ` · ${nativeSummary.dropped} unmapped field(s) skipped` : '') +
                    (nativeSummary.missing ? ` · ${nativeSummary.missing} mapping(s) point to missing header` : '');
                await this.db.logStage(jobId, 'sap_jobs_sheet', 'completed', msg, nativeAudit, duration).catch(() => {});
                logger.info(`Job [${jobId}] SAP sheet appended (native)`, nativeSummary);
                emit('stage_done', { job_id: jobId, stage: 'sap_jobs_sheet', duration_ms: duration, summary: nativeSummary });
            } else if (appsScriptResult?.ok) {
                const summary = { path: 'apps_script', row: appsScriptResult.row, sheet: appsScriptResult.sheet_name, url: appsScriptResult.sheet_url };
                await this.db.logStage(jobId, 'sap_jobs_sheet', 'completed', `Appended via Apps Script · row ${summary.row} in "${summary.sheet}"`, summary, duration).catch(() => {});
                logger.info(`Job [${jobId}] SAP sheet appended (Apps Script)`, summary);
                emit('stage_done', { job_id: jobId, stage: 'sap_jobs_sheet', duration_ms: duration, summary });
            } else {
                const errMsg = appsScriptResult?.error || nativeErr || 'no writer configured';
                await this.db.logStage(jobId, 'sap_jobs_sheet', 'failed', errMsg, { nativeErr, appsScript: appsScriptResult }, duration).catch(() => {});
                logger.warn(`Job [${jobId}] SAP sheet write failed (both paths exhausted)`, { nativeErr, appsScriptErr: appsScriptResult?.error });
                emit('stage_fail', { job_id: jobId, stage: 'sap_jobs_sheet', error: errMsg, duration_ms: duration });
            }
        } catch (err) {
            const duration = Date.now() - t0;
            await this.db.logStage(jobId, 'sap_jobs_sheet', 'failed', err.message, null, duration).catch(() => {});
            logger.warn(`Job [${jobId}] SAP sheet write failed`, { error: err.message });
            emit('stage_fail', { job_id: jobId, stage: 'sap_jobs_sheet', error: err.message, duration_ms: duration });
        }
    }

    /**
     * Auto-generate HeyReach AI content (English InMail template + German translation
     * + ≤299-char Connection Request) for every contact of a job that has a LinkedIn
     * URL and hasn't already been generated. Runs after Stage 7 completes.
     */
    async _runHeyReachGen(jobId) {
        const HeyReach = require('../services/HeyReachService');

        emit('stage_start', { job_id: jobId, stage: 'heyreach_gen' });
        await this.db.logStage(jobId, 'heyreach_gen', 'started', null).catch(() => {});
        const t0 = Date.now();

        try {
            const job = await this.db.getJobById(jobId);
            if (!job) throw new Error(`Job ${jobId} not found`);
            const contacts = await this.db.getContactsForJob(jobId);

            // Pull every contact that hasn't been processed yet — the master gate
            // (DACH country + IS_JOB_POSTER) is enforced inside generateContent so
            // the per-contact reason gets persisted instead of silently filtered out.
            const candidates = contacts.filter(c => !c.heyreach_generated_at);

            if (candidates.length === 0) {
                const duration = Date.now() - t0;
                await this.db.logStage(jobId, 'heyreach_gen', 'completed',
                    'No contacts pending HeyReach generation', null, duration).catch(() => {});
                emit('stage_done', { job_id: jobId, stage: 'heyreach_gen', duration_ms: duration,
                    summary: { generated: 0, skipped: 0, errors: 0, eligible: 0 } });
                return { generated: 0, skipped: 0, errors: 0, eligible: 0 };
            }

            // ── Parallel generation with per-contact timeout ────────────────────
            // Was a sequential for-loop: 10 contacts × ~30s of OpenAI calls each
            // = 5 min before stage finishes. Now we generate in parallel batches
            // (5 at a time) with a 60s per-contact timeout — so 10 contacts
            // finish in ~60-90s instead of 5 min, and a stuck contact never
            // blocks the rest.
            const HEYREACH_GEN_TIMEOUT_MS = parseInt(process.env.HEYREACH_GEN_TIMEOUT_MS || '60000', 10);
            const PARALLEL = parseInt(process.env.HEYREACH_GEN_PARALLEL || '5', 10);
            const withTimeout = (p, ms, label) => Promise.race([
                p,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
            ]);

            let generated = 0, skipped = 0, errors = 0;
            for (let i = 0; i < candidates.length; i += PARALLEL) {
                const batch = candidates.slice(i, i + PARALLEL);
                // Wrap each promise so the contact id is always available — even when the
                // underlying OpenAI call rejects/timeouts — so we can persist heyreach_error.
                const settled = await Promise.allSettled(batch.map(async c => {
                    try {
                        const fields = await withTimeout(
                            HeyReach.generateContent(c, job),
                            HEYREACH_GEN_TIMEOUT_MS, `HeyReach gen c${c.id}`
                        );
                        return { c, fields };
                    } catch (err) {
                        return { c, error: err };
                    }
                }));
                for (const r of settled) {
                    if (r.status !== 'fulfilled') continue;
                    const { c, fields, error } = r.value;
                    if (error) {
                        errors++;
                        logger.warn(`HeyReach gen failed for contact ${c.id}`, { error: error.message });
                        await this.db.updateContact(c.id, { heyreach_error: error.message }).catch(() => {});
                        continue;
                    }
                    await this.db.updateContact(c.id, fields).catch(() => {});
                    if (fields.skipped) {
                        skipped++;
                        logger.debug(`HeyReach skipped contact ${c.id}`, { reason: fields.heyreach_skip_reason });
                    } else {
                        generated++;
                    }
                }
            }

            const duration = Date.now() - t0;
            const msg = `Generated ${generated}/${candidates.length} · Skipped ${skipped} (gate or DACH check) · Errors ${errors}`;
            await this.db.logStage(jobId, 'heyreach_gen', 'completed', msg,
                { generated, skipped, errors, eligible: candidates.length }, duration).catch(() => {});

            logger.info(`Job [${jobId}] HeyReach auto-gen done`, { generated, skipped, errors, candidates: candidates.length });
            emit('stage_done', { job_id: jobId, stage: 'heyreach_gen', duration_ms: duration,
                summary: { generated, skipped, errors, eligible: candidates.length } });
            return { generated, skipped, errors, eligible: candidates.length };
        } catch (err) {
            const duration = Date.now() - t0;
            await this.db.logStage(jobId, 'heyreach_gen', 'failed', err.message, null, duration).catch(() => {});
            logger.error(`Job [${jobId}] HeyReach auto-gen failed`, { error: err.message });
            emit('stage_fail', { job_id: jobId, stage: 'heyreach_gen', error: err.message, duration_ms: duration });
            throw err;
        }
    }

    /**
     * Send every DACH-eligible contact of a job to its HeyReach campaign.
     *
     * Strict gate (mirrors generation gate but adds "content is ready"):
     *   • heyreach_dach_check === 'yes'   (LinkedIn verified Germany/Switzerland)
     *   • heyreach_generated_at IS NOT NULL
     *   • !sent_to_heyreach                (idempotency)
     *   • !heyreach_skip_reason            (gate didn't fail upstream)
     *   • inmail_body_de + connection_req present (we have content)
     *   • a LinkedIn URL exists            (HeyReach payload requires it)
     *   • the route's campaign ID is configured (free_inmail / conreq_plus_inmail / connect_only)
     *
     * If the route's campaign env var is missing, the contact is logged as
     * skipped with the reason — no exception thrown, the pipeline continues.
     */
    async _runHeyReachSend(jobId) {
        const HeyReach = require('../services/HeyReachService');

        emit('stage_start', { job_id: jobId, stage: 'heyreach_send' });
        await this.db.logStage(jobId, 'heyreach_send', 'started', null).catch(() => {});
        const t0 = Date.now();

        try {
            if (!process.env.HEYREACH_API_KEY) {
                const duration = Date.now() - t0;
                await this.db.logStage(jobId, 'heyreach_send', 'skipped',
                    'HEYREACH_API_KEY not set — add it in the Connections tab', null, duration).catch(() => {});
                emit('stage_done', { job_id: jobId, stage: 'heyreach_send', duration_ms: duration,
                    summary: { sent: 0, skipped: 0, errors: 0, eligible: 0 } });
                return { sent: 0, skipped: 0, errors: 0, eligible: 0 };
            }

            const contacts = await this.db.getContactsForJob(jobId);

            // Apply the strict gate
            const eligible = contacts.filter(c =>
                c.heyreach_dach_check === 'yes' &&
                c.heyreach_generated_at != null &&
                !c.sent_to_heyreach &&
                !c.heyreach_skip_reason &&
                c.inmail_body_de && c.connection_req &&
                (c.linkedin_url || c.li_merged || c.linkedin_url_merged || c.person_linkedin_url)
            );

            if (eligible.length === 0) {
                const duration = Date.now() - t0;
                const blockedByGate   = contacts.filter(c => c.heyreach_skip_reason).length;
                const notDachVerified = contacts.filter(c => c.heyreach_dach_check !== 'yes' && !c.heyreach_skip_reason).length;
                const alreadySent     = contacts.filter(c => c.sent_to_heyreach).length;
                await this.db.logStage(jobId, 'heyreach_send', 'completed',
                    `Nothing to send — ${contacts.length} contacts (gate-blocked: ${blockedByGate}, DACH-not-verified: ${notDachVerified}, already-sent: ${alreadySent})`,
                    { blockedByGate, notDachVerified, alreadySent, total: contacts.length },
                    duration).catch(() => {});
                emit('stage_done', { job_id: jobId, stage: 'heyreach_send', duration_ms: duration,
                    summary: { sent: 0, skipped: 0, errors: 0, eligible: 0, blockedByGate, notDachVerified, alreadySent } });
                return { sent: 0, skipped: 0, errors: 0, eligible: 0 };
            }

            // Load HeyReach connection's saved config — gives us per-route
            // campaign IDs + the operator's field_mapping.
            let hrConnConfig = {};
            try {
                const Connections = require('../services/ConnectionService');
                const hrConn = await Connections.getDefault('api_key', 'heyreach').catch(() => null);
                if (hrConn?.config) hrConnConfig = hrConn.config;
            } catch (_) { /* best-effort */ }

            const job = await this.db.getJobById(jobId).catch(() => null);
            let sent = 0, errors = 0, skipped = 0;
            for (const c of eligible) {
                const route = c.heyreach_route || 'conreq_plus_inmail';
                // Campaign-id resolution: connection config first, then env var
                const cfgKey =
                    route === 'free_inmail'  ? 'campaign_free_inmail'  :
                    route === 'connect_only' ? 'campaign_connect_only' :
                                               'campaign_conreq_inmail';
                const envKey = route === 'free_inmail'  ? 'HEYREACH_CAMPAIGN_FREE_INMAIL'  :
                              route === 'connect_only' ? 'HEYREACH_CAMPAIGN_CONNECT_ONLY' :
                                                          'HEYREACH_CAMPAIGN_CONREQ_INMAIL';
                const campaignId = hrConnConfig[cfgKey] || process.env[envKey];
                if (!campaignId) {
                    skipped++;
                    await this.db.updateContact(c.id, {
                        heyreach_error: `Campaign ID not configured for route "${route}" — set ${envKey} in Connections → HeyReach`,
                    }).catch(() => {});
                    logger.warn(`HeyReach send skipped — no campaign ID for route ${route}`, { contact_id: c.id, env: envKey });
                    continue;
                }
                try {
                    const { leadId, response } = await HeyReach.addLeadToCampaign(c, route, {
                        campaignId,
                        fieldMapping: hrConnConfig.field_mapping || null,
                        job,
                    });
                    await this.db.markContactSentHeyReach(c.id, leadId, response);
                    sent++;
                    logger.info(`HeyReach send OK`, { contact_id: c.id, route, lead_id: leadId, name: c.full_name });
                } catch (err) {
                    errors++;
                    logger.warn(`HeyReach send failed`, { contact_id: c.id, route, error: err.message });
                    // Persist the failure with structured details so the dashboard can show
                    // the same drawer for sent + failed contacts.
                    const failureBody = {
                        ok:           false,
                        route,
                        error:        err.message,
                        httpStatus:   err.httpStatus ?? null,
                        attempted_at: new Date().toISOString(),
                    };
                    await this.db.updateContact(c.id, {
                        heyreach_error:    `Send failed (${route}): ${err.message}`,
                        heyreach_response: failureBody,
                    }).catch(() => {});
                }
            }

            const duration = Date.now() - t0;
            const msg = `Sent ${sent}/${eligible.length} · Skipped ${skipped} (no campaign ID) · Errors ${errors}`;
            await this.db.logStage(jobId, 'heyreach_send', 'completed', msg,
                { sent, skipped, errors, eligible: eligible.length }, duration).catch(() => {});
            logger.info(`Job [${jobId}] HeyReach send done`, { sent, skipped, errors, eligible: eligible.length });
            emit('stage_done', { job_id: jobId, stage: 'heyreach_send', duration_ms: duration,
                summary: { sent, skipped, errors, eligible: eligible.length } });
            return { sent, skipped, errors, eligible: eligible.length };
        } catch (err) {
            const duration = Date.now() - t0;
            await this.db.logStage(jobId, 'heyreach_send', 'failed', err.message, null, duration).catch(() => {});
            logger.error(`Job [${jobId}] HeyReach send failed`, { error: err.message });
            emit('stage_fail', { job_id: jobId, stage: 'heyreach_send', error: err.message, duration_ms: duration });
            throw err;
        }
    }

    /**
     * Push a single job's data (company + contacts + job) into RecruiterFlow CRM.
     * Called automatically after Stage 7 completes (unless CRM_AUTO_PUSH=false).
     * Updates lpf_jobs.crm_status so the dashboard can show the push state.
     */
    async _runCRMPush(jobId) {
        const { pushJobToCRM } = require('./CRMPush');

        emit('stage_start', { job_id: jobId, stage: 'crm_push' });
        await this.db.logStage(jobId, 'crm_push', 'started', null).catch(() => {});
        const t0 = Date.now();

        try {
            const job      = await this.db.getJobById(jobId);
            if (!job) throw new Error(`Job ${jobId} not found`);
            const contacts = await this.db.getContactsForJob(jobId);
            const results  = await pushJobToCRM(job, contacts, this.db);

            const ok = results.company?.status === 'sent'      || results.company?.status === 'dedup_skipped';
            const jobOk  = results.job?.status === 'sent'      || results.job?.status === 'dedup_skipped';
            const errors = []
                .concat(results.company?.status === 'error' ? [`company: ${results.company.error}`] : [])
                .concat(results.contacts.filter(c => c.status === 'error').map(c => `contact ${c.contact_id}: ${c.error}`))
                .concat(results.job?.status === 'error'     ? [`job: ${results.job.error}`]     : []);

            const status = errors.length === 0 && ok && jobOk ? 'pushed'
                         : errors.length === 0 ? 'partial'
                         : 'error';

            await this.db.setJobCRMStatus(jobId, {
                crm_status:    status,
                crm_pushed_at: new Date(),
                crm_error:     errors.length ? errors.slice(0, 3).join(' | ') : null,
            });

            const duration = Date.now() - t0;
            await this.db.logStage(jobId, 'crm_push', 'completed',
                `Company: ${results.company?.status}, Contacts sent: ${results.contacts.filter(c=>c.status==='sent').length}/${results.contacts.length}, Job: ${results.job?.status}`,
                { company: results.company?.status, contacts: results.contacts.length, errors: errors.length },
                duration).catch(() => {});

            logger.info(`Job [${jobId}] CRM push ${status}`, {
                company: results.company?.status,
                contacts_sent: results.contacts.filter(c => c.status === 'sent').length,
                contacts_total: results.contacts.length,
                job: results.job?.status,
                errors: errors.length,
            });
            emit('stage_done', { job_id: jobId, stage: 'crm_push', duration_ms: duration, summary: { status, errors: errors.length } });
            return results;
        } catch (err) {
            const duration = Date.now() - t0;
            await this.db.setJobCRMStatus(jobId, {
                crm_status: 'error',
                crm_error:  err.message,
            }).catch(() => {});
            await this.db.logStage(jobId, 'crm_push', 'failed', err.message, null, duration).catch(() => {});
            logger.error(`Job [${jobId}] CRM push failed`, { error: err.message });
            emit('stage_fail', { job_id: jobId, stage: 'crm_push', error: err.message, duration_ms: duration });
            throw err;
        }
    }

    /**
     * Auto-approve every eligible contact and immediately push them through
     * Stage 8 (Instantly send). Used at pipeline end when INSTANTLY_AUTO_SEND
     * is true (default). Equivalent to:
     *   POST /review/:jobId/approve-all
     *   POST /review/:jobId/send
     * but bypasses the manual review gate.
     */
    async _runInstantlySend(jobId) {
        await this.db.approveAllContacts(jobId, 'instantly', null);
        return this.sendJob(jobId);
    }

    /**
     * Run Stage 8 (send to Instantly) for a single job.
     * Called from POST /review/:jobId/send after manual approval.
     */
    async sendJob(jobId) {
        const job = await this.db.getJobById(jobId);
        if (!job) throw new Error(`Job ${jobId} not found`);

        emit('job_start', { job_id: jobId, job_title: job.job_title, company: job.company_name, stage: 'stage8_send' });

        const stage    = new Stage08_SendInstantly(this.db);
        const t0       = Date.now();
        await this.db.logStage(jobId, 'stage8_send', 'started', null);

        try {
            const result   = await stage.run(job);
            const duration = Date.now() - t0;
            await this.db.updateJobStage(jobId, 'completed', { processed_at: new Date(), sent_at: new Date() });
            await this.db.logStage(jobId, 'stage8_send', 'completed', result.message, result.logData, duration);
            logger.info(`Job [${jobId}] sent`, result.summary || {});
            emit('stage_done', { job_id: jobId, stage: 'stage8_send', duration_ms: duration, message: result.message, summary: result.summary });
            emit('job_done', { job_id: jobId, result: 'sent' });
            return result;
        } catch (err) {
            const duration = Date.now() - t0;
            await this.db.logStage(jobId, 'stage8_send', 'failed', err.message, null, duration);
            logger.error(`Job [${jobId}] send failed`, { error: err.message });
            emit('stage_fail', { job_id: jobId, stage: 'stage8_send', error: err.message });
            throw err;
        }
    }
}

// ── Country inference helpers ─────────────────────────────────────────────────

const TLD_MAP = { '.de': 'Germany', '.at': 'Austria', '.ch': 'Switzerland' };

function inferCountryFromTLD(url) {
    if (!url) return null;
    for (const [tld, country] of Object.entries(TLD_MAP)) {
        try {
            const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname;
            if (hostname.endsWith(tld)) return country;
        } catch (_) {}
    }
    return null;
}

const TEXT_SIGNALS = [
    { patterns: ['germany', 'deutschland', 'münchen', 'munich', 'berlin', 'hamburg', 'frankfurt', 'düsseldorf', 'cologne', 'köln', 'stuttgart', '+49', '(de)', ' de '], country: 'Germany' },
    { patterns: ['austria', 'österreich', 'wien', 'vienna', 'graz', 'linz', 'salzburg', 'innsbruck', '+43', '(at)'], country: 'Austria' },
    { patterns: ['switzerland', 'schweiz', 'suisse', 'zürich', 'zurich', 'geneva', 'genf', 'bern', 'basel', '+41', '(ch)'], country: 'Switzerland' },
];

function inferCountryFromText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const sig of TEXT_SIGNALS) {
        if (sig.patterns.some(p => lower.includes(p))) return sig.country;
    }
    return null;
}

/**
 * Render the structured CV JSON into a plain-text block for the legacy
 * `english_cv_text` / `cv_german_text` columns — keeps the existing dashboard
 * preview drawers working while the new flow uses the JSON columns.
 */
function _stringifyForLegacyColumn(s) {
    if (!s) return null;
    const sections = [
        ['Recruiter Summary',     s.recruiterSummary],
        [`Location – ${s.location || ''}`, ''],
        [`Date of Birth – ${s.dateOfBirth || ''}`, ''],
        [`Languages – ${s.languages || ''}`, ''],
        [`Nationality – ${s.nationality || ''}`, ''],
        [`LinkedIn – ${s.linkedin || ''}`, ''],
        ['About Me',              s.aboutMe],
        ['Technical Skills',      s.technicalSkills],
        ['Professional Experience', s.experience],
        ['Education',             s.education],
        ['Languages',             s.languagesDetailed],
        ['Certifications',        s.certifications],
        ['Hobbies & Interests',   s.hobbiesAndInterests],
    ];
    return sections
        .map(([h, body]) => body ? `${h}\n${body}` : h)
        .filter(Boolean)
        .join('\n\n');
}

module.exports = Pipeline;
