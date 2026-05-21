const OpenAI       = require('openai');
const costTracker  = require('./CostTrackerService');

let _client = null;

function getClient() {
    if (!_client) {
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
        // 60s default per-request timeout — keeps a single prompt from blocking
        // a stage for the OpenAI SDK's default of 10 minutes. With 2 max retries
        // a worst-case call is ~3 min; the per-stage watchdog in Pipeline.js
        // (240s) is the outer safety net.
        _client = new OpenAI({
            apiKey:     process.env.OPENAI_API_KEY,
            timeout:    parseInt(process.env.OPENAI_TIMEOUT_MS || '60000', 10),
            maxRetries: 2,
        });
    }
    return _client;
}

const MODEL_FAST   = 'gpt-4o-mini';
const MODEL_SEARCH = 'gpt-4o-mini';

// Per-million-token pricing per model (USD). Source: OpenAI public pricing.
// Update this table when adding a new model so the dashboard cost figures stay accurate.
const MODEL_PRICING = {
    'gpt-4o-mini':  { input: 0.15,  output: 0.60  },
    'gpt-4.1-nano': { input: 0.10,  output: 0.40  },
    'gpt-4.1-mini': { input: 0.40,  output: 1.60  },
    'gpt-4o':       { input: 2.50,  output: 10.00 },
    'gpt-4.1':      { input: 2.00,  output: 8.00  },
};

function priceFor(model) { return MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini']; }

function computeCostUSD(model, inputTokens, outputTokens) {
    const p = priceFor(model);
    return ((inputTokens || 0) * p.input + (outputTokens || 0) * p.output) / 1_000_000;
}

// Tracks the most recent OpenAI call for the per-call cost-bubble shown in the UI.
let _lastCost = null;
function getLastCost() { return _lastCost; }

/**
 * Core call — returns parsed JSON from GPT.
 * Logs token usage to lpf_api_costs after every call AND records the cost on the
 * call result so UI code can surface "this prompt cost $0.0023" inline.
 *
 * The shape returned by askJSON is the parsed JSON body (back-compat), but each
 * call also stamps `_lastCost` on this module. Use `askJSONWithCost()` if you
 * want the cost back inline.
 */
async function askJSON(systemPrompt, userPrompt, model = MODEL_FAST, opts = {}) {
    const res = await _callRaw(systemPrompt, userPrompt, model, opts);
    return res.json;
}

/**
 * Same as askJSON but returns { json, cost } so callers can show the cost in the UI.
 */
async function askJSONWithCost(systemPrompt, userPrompt, model = MODEL_FAST, opts = {}) {
    return _callRaw(systemPrompt, userPrompt, model, opts);
}

async function _callRaw(systemPrompt, userPrompt, model, opts) {
    const client = getClient();
    const res = await client.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
    });

    const usage = res.usage || {};
    const inputTokens  = usage.prompt_tokens     || 0;
    const outputTokens = usage.completion_tokens || 0;
    const costUsd      = computeCostUSD(model, inputTokens, outputTokens);

    const costRecord = {
        model,
        operation: opts.operation || 'askJSON',
        inputTokens,
        outputTokens,
        costUsd,
    };
    _lastCost = costRecord;

    costTracker.logOpenAI({
        jobId:        opts.jobId    || null,
        operation:    opts.operation || 'askJSON',
        model,
        inputTokens,
        outputTokens,
    }).catch(() => {});

    const raw = res.choices[0].message.content;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`OpenAI returned non-JSON (${e.message}): ${raw.slice(0, 120)}`);
    }
    return { json: parsed, cost: costRecord };
}

/**
 * Web-search enhanced call — for Stage 7 AI contact search.
 * Falls back to regular call if web search tool not available.
 */
async function askWithWebSearch(systemPrompt, userPrompt, opts = {}) {
    const client = getClient();
    try {
        const res = await client.responses.create({
            model: 'gpt-4o-mini',
            tools: [{ type: 'web_search_preview' }],
            input: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt },
            ],
        });

        const usage = res.usage || {};
        costTracker.logOpenAI({
            jobId:        opts.jobId    || null,
            operation:    opts.operation || 'askWithWebSearch',
            model:        'gpt-4o-mini',
            inputTokens:  usage.input_tokens  || usage.prompt_tokens     || 0,
            outputTokens: usage.output_tokens || usage.completion_tokens || 0,
        }).catch(() => {});

        return res.output_text || res.choices?.[0]?.message?.content || '';
    } catch (_err) {
        const res = await client.chat.completions.create({
            model:    MODEL_SEARCH,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt },
            ],
            temperature: 0.2,
        });

        const usage = res.usage || {};
        costTracker.logOpenAI({
            jobId:        opts.jobId    || null,
            operation:    opts.operation || 'askWithWebSearch_fallback',
            model:        MODEL_SEARCH,
            inputTokens:  usage.prompt_tokens     || 0,
            outputTokens: usage.completion_tokens || 0,
        }).catch(() => {});

        return res.choices[0].message.content;
    }
}

module.exports = {
    askJSON,
    askJSONWithCost,
    askWithWebSearch,
    computeCostUSD,
    getLastCost,
    MODEL_FAST,
    MODEL_PRICING,
};
