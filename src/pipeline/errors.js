/**
 * classifyError — maps a caught Error into one of the spec's closed enum values.
 * Pure function, no side-effects, safe to call anywhere.
 *
 * Enum: network | rate_limit | validation | auth | timeout | provider_error | unknown
 */

const PATTERNS = [
    {
        kind: 'rate_limit',
        test: e => e.status === 429
            || /rate.?limit|too many requests|quota exceeded/i.test(e.message),
    },
    {
        kind: 'auth',
        test: e => e.status === 401
            || e.status === 403
            || /unauthorized|forbidden|invalid.?api.?key|api key/i.test(e.message),
    },
    {
        kind: 'timeout',
        test: e => e.code === 'ETIMEDOUT'
            || /timeout|timed.?out|ETIMEDOUT/i.test(e.message),
    },
    {
        kind: 'network',
        test: e => ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE'].includes(e.code)
            || /network|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(e.message),
    },
    {
        kind: 'validation',
        test: e => e.status === 400
            || e.status === 422
            || /invalid|validation|malformed|bad request|parse error/i.test(e.message),
    },
    {
        kind: 'provider_error',
        test: e => (e.status >= 500 && e.status < 600)
            || /server error|internal error|service unavailable|bad gateway/i.test(e.message),
    },
];

function classifyError(err) {
    if (!err) return 'unknown';
    for (const { kind, test } of PATTERNS) {
        try { if (test(err)) return kind; } catch (_) {}
    }
    return 'unknown';
}

module.exports = { classifyError };
