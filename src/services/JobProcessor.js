const DatabaseService = require('../database/DatabaseService');
const ClaudeService = require('./ClaudeService');
const Logger = require('../Logger');

const logger = new Logger('JobProcessor');

// Delay between Claude calls to avoid rate limits
const INTER_JOB_DELAY_MS = 1200;

class JobProcessor {
    constructor() {
        this.db = new DatabaseService();
        this.claude = new ClaudeService();
    }

    /**
     * Process all unprocessed jobs using Claude.
     * Logs everything to DB.
     * @param {object} opts
     * @param {number} opts.limit       Max jobs to process per run (default 50)
     * @param {number} opts.minScore    Only log/flag jobs above this quality score
     * @param {boolean} opts.dryRun     If true, analyse but don't mark as processed
     */
    async run({ limit = 50, minScore = 5, dryRun = false } = {}) {
        const runId = this.db.startRun();
        logger.info('Processing run started', { run_id: runId, limit, dry_run: dryRun });

        const jobs = this.db.getUnprocessedJobs(limit);
        logger.info(`Found ${jobs.length} unprocessed jobs`);

        if (jobs.length === 0) {
            this.db.completeRun(runId, { jobs_examined: 0, jobs_processed: 0, jobs_sent: 0 });
            return { run_id: runId, examined: 0, processed: 0, sent: 0, results: [] };
        }

        const results = [];
        let processed = 0;
        let sent = 0;

        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            logger.info(`[${i + 1}/${jobs.length}] Analysing: ${job.job_title || job.job_url}`, {
                job_id:  job.id,
                company: job.company_url,
            });

            try {
                const result = await this.claude.analyseJob(job);
                processed++;

                if (!dryRun) {
                    this.db.saveClaudeResult(job.id, result);
                }

                results.push({ job_id: job.id, title: job.job_title, result });

                if (result.quality_score >= minScore) {
                    logger.info(`  ✓ Score ${result.quality_score}/10 — ${result.summary}`, {
                        job_id:   job.id,
                        ctr_fit:  result.ctr_fit,
                        modules:  result.sap_modules?.join(', '),
                    });
                } else {
                    logger.debug(`  ✗ Score ${result.quality_score}/10 — below threshold`, { job_id: job.id });
                }

                // Send high-quality jobs to OUTPUT_WEBHOOK_URL if configured
                if (!dryRun && result.ctr_fit === 'high' && process.env.OUTPUT_WEBHOOK_URL) {
                    await this._forwardJob(job, result);
                    sent++;
                    this.db.markJobSent(job.id);
                }
            } catch (err) {
                logger.error(`Failed to process job ${job.id}`, { error: err.message });
            }

            if (i < jobs.length - 1) {
                await sleep(INTER_JOB_DELAY_MS);
            }
        }

        this.db.completeRun(runId, { jobs_examined: jobs.length, jobs_processed: processed, jobs_sent: sent });

        logger.info('Processing run complete', {
            run_id:    runId,
            examined:  jobs.length,
            processed,
            sent,
        });

        return { run_id: runId, examined: jobs.length, processed, sent, results };
    }

    async _forwardJob(job, claudeResult) {
        const payload = {
            job_url:              job.job_url,
            job_title:            job.job_title,
            job_description:      job.job_description,
            city:                 job.city,
            country:              job.country,
            company_url:          job.company_url,
            company_linkedin_url: job.company_linkedin_url,
            company_name:         job.company_name,
            job_poster_url:       job.job_poster_url,
            source:               job.source,
            sap_tech:             job.sap_tech,
            claude_summary:       claudeResult.summary,
            claude_sap_modules:   claudeResult.sap_modules,
            claude_quality:       claudeResult.quality_score,
            claude_ctr_fit:       claudeResult.ctr_fit,
            claude_seniority:     claudeResult.seniority,
        };

        try {
            const res = await fetch(process.env.OUTPUT_WEBHOOK_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
                signal:  AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            logger.info('Job forwarded to output webhook', { job_id: job.id });
        } catch (err) {
            logger.error('Failed to forward job to webhook', { job_id: job.id, error: err.message });
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = JobProcessor;
