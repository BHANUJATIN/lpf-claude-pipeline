/**
 * CostTrackerService — logs every API call that consumes tokens or credits.
 *
 * GPT-4o mini pricing (as of mid-2025):
 *   input:  $0.15 / 1M tokens  →  $0.00000015 per token
 *   output: $0.60 / 1M tokens  →  $0.00000060 per token
 *
 * Apollo credit model:
 *   searchPeople / searchPeopleByName → 0 credits (search is free)
 *   enrichPerson / enrichByNameDomain → 1 credit only when a real work email is returned
 *   enrichCompany                     → 1 credit when org data is returned, 0 if not found
 * Proxycurl: 1 credit per person or company profile call.
 * Apify: billed by compute units but we record each scrape as 1 unit for visibility.
 */

const DatabaseClass = require('../database/Database');
const Database = { get pool() { return DatabaseClass.getInstance().pool; } };

const OPENAI_INPUT_COST_PER_TOKEN  = 0.15  / 1_000_000;
const OPENAI_OUTPUT_COST_PER_TOKEN = 0.60  / 1_000_000;

class CostTrackerService {
    /**
     * Log an OpenAI API call.
     * @param {object} opts
     * @param {number|null} opts.jobId
     * @param {string}      opts.operation  e.g. 'stage1_sap_check'
     * @param {string}      opts.model
     * @param {number}      opts.inputTokens
     * @param {number}      opts.outputTokens
     * @param {object}      [opts.metadata]
     */
    async logOpenAI({ jobId, operation, model, inputTokens, outputTokens, metadata }) {
        const cost = (inputTokens * OPENAI_INPUT_COST_PER_TOKEN) +
                     (outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN);
        await this._insert({
            job_id:        jobId   || null,
            service:       'openai',
            operation,
            model:         model   || 'gpt-4o-mini',
            input_tokens:  inputTokens  || 0,
            output_tokens: outputTokens || 0,
            credits_used:  null,
            cost_usd:      cost,
            metadata:      metadata || null,
        });
    }

    /**
     * Log an Apollo API call (1 credit per call).
     * @param {object} opts
     * @param {number|null} opts.jobId
     * @param {string}      opts.operation  e.g. 'people_search_hr'
     * @param {number}      [opts.credits]  defaults to 1
     * @param {object}      [opts.metadata]
     */
    async logApollo({ jobId, operation, credits = 1, metadata }) {
        await this._insert({
            job_id:        jobId || null,
            service:       'apollo',
            operation,
            model:         null,
            input_tokens:  null,
            output_tokens: null,
            credits_used:  credits,
            cost_usd:      null,
            metadata:      metadata || null,
        });
    }

    /**
     * Log a Proxycurl API call (1 credit per call).
     */
    async logProxycurl({ jobId, operation, credits = 1, metadata }) {
        await this._insert({
            job_id:        jobId || null,
            service:       'proxycurl',
            operation,
            model:         null,
            input_tokens:  null,
            output_tokens: null,
            credits_used:  credits,
            cost_usd:      null,
            metadata:      metadata || null,
        });
    }

    /**
     * Log an Apify scrape (1 compute unit recorded per call).
     */
    async logApify({ jobId, operation, metadata }) {
        await this._insert({
            job_id:        jobId || null,
            service:       'apify',
            operation,
            model:         null,
            input_tokens:  null,
            output_tokens: null,
            credits_used:  1,
            cost_usd:      null,
            metadata:      metadata || null,
        });
    }

    async _insert(row) {
        try {
            const pool = Database.pool;
            await pool.query(
                `INSERT INTO lpf_api_costs
                 (job_id, service, operation, model, input_tokens, output_tokens, credits_used, cost_usd, metadata)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                    row.job_id,
                    row.service,
                    row.operation,
                    row.model,
                    row.input_tokens,
                    row.output_tokens,
                    row.credits_used,
                    row.cost_usd  != null ? row.cost_usd.toFixed(8) : null,
                    row.metadata  ? JSON.stringify(row.metadata) : null,
                ]
            );
        } catch (_err) {
            // Cost tracking is non-critical — never block pipeline on failure
        }
    }

    /**
     * Aggregate totals for the top-bar cost summary.
     * Returns { openai_usd, apollo_credits, proxycurl_credits, apify_units, openai_input_tokens, openai_output_tokens }
     */
    async getTotals() {
        const pool = Database.pool;
        const res = await pool.query(`
            SELECT
                service,
                SUM(cost_usd)      AS total_usd,
                SUM(credits_used)  AS total_credits,
                SUM(input_tokens)  AS total_input,
                SUM(output_tokens) AS total_output
            FROM lpf_api_costs
            GROUP BY service
        `);
        const out = { openai_usd: 0, apollo_credits: 0, proxycurl_credits: 0, apify_units: 0,
                      openai_input_tokens: 0, openai_output_tokens: 0 };
        for (const row of res.rows) {
            if (row.service === 'openai') {
                out.openai_usd           = parseFloat(row.total_usd || 0);
                out.openai_input_tokens  = parseInt(row.total_input  || 0);
                out.openai_output_tokens = parseInt(row.total_output || 0);
            } else if (row.service === 'apollo') {
                out.apollo_credits = parseInt(row.total_credits || 0);
            } else if (row.service === 'proxycurl') {
                out.proxycurl_credits = parseInt(row.total_credits || 0);
            } else if (row.service === 'apify') {
                out.apify_units = parseInt(row.total_credits || 0);
            }
        }
        return out;
    }

    /**
     * Per-job cost summary for the job detail view.
     */
    async getJobCosts(jobId) {
        const pool = Database.pool;
        const res = await pool.query(
            `SELECT service, operation, model, input_tokens, output_tokens, credits_used, cost_usd, metadata, created_at
             FROM lpf_api_costs WHERE job_id = $1 ORDER BY created_at`,
            [jobId]
        );
        return res.rows;
    }
}

module.exports = new CostTrackerService();
