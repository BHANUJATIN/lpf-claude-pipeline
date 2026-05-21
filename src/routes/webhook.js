const express = require('express');
const DatabaseService = require('../database/DatabaseService');
const Logger = require('../Logger');

const router = express.Router();
const logger = new Logger('WebhookRoute');
const db = new DatabaseService();

/**
 * POST /webhook/lpf
 *
 * Receives the top job per company from JPE (CTR client).
 * Accepts both new flat format and legacy JPE nested format.
 * Responds 200 immediately — processing happens in background pipeline.
 */
router.post('/lpf', async (req, res) => {
    try {
        const payload = normalise(req.body);

        if (!payload.job_url) {
            logger.warn('Webhook received payload with no job_url', { keys: Object.keys(req.body || {}).join(', ') });
            return res.status(400).json({ ok: false, error: 'missing job_url' });
        }

        // ── Dedup gate (runs BEFORE any DB insert) ──────────────────────────
        const dup = await db.checkJobDedupe(payload).catch(() => ({ duplicate: false }));
        if (dup.duplicate) {
            logger.info('Webhook rejected — duplicate', {
                title:   payload.job_title,
                company: payload.company_url || payload.company_name,
                kind:    dup.match_kind,
                reason:  dup.reason,
            });
            return res.status(200).json({
                ok:               true,
                skipped:          true,
                reason:           dup.reason,
                match_kind:       dup.match_kind,
                existing_job_id:  dup.existing_job_id,
                existing_stage:   dup.existing_stage,
            });
        }

        const row = await db.upsertJob(payload);

        logger.info('Job received from JPE', {
            job_id:  row.id,
            stage:   row.stage,
            title:   payload.job_title,
            company: payload.company_url,
            country: payload.country,
        });

        res.status(200).json({ ok: true, job_id: row.id, stage: row.stage, received_at: new Date().toISOString() });
    } catch (err) {
        logger.error('Webhook processing error', { error: err.message });
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /webhook/lpf-batch
 * Bulk import — body is array or { jobs: [] }. Each job goes through the same
 * dedup gate as POST /lpf — duplicates are skipped silently (count returned).
 */
router.post('/lpf-batch', async (req, res) => {
    try {
        const items = Array.isArray(req.body) ? req.body : (req.body.jobs || []);
        let saved = 0, skipped = 0;
        const skippedReasons = [];
        for (const raw of items) {
            const p = normalise(raw);
            if (!p.job_url) { skipped++; continue; }
            const dup = await db.checkJobDedupe(p).catch(() => ({ duplicate: false }));
            if (dup.duplicate) {
                skipped++;
                skippedReasons.push({ url: p.job_url, reason: dup.reason, kind: dup.match_kind });
                continue;
            }
            await db.upsertJob(p);
            saved++;
        }
        logger.info('Batch import', { saved, skipped, total: items.length });
        res.status(200).json({ ok: true, saved, skipped, total: items.length, skipped_details: skippedReasons });
    } catch (err) {
        logger.error('Batch import error', { error: err.message });
        res.status(500).json({ ok: false, error: err.message, saved: 0 });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Generic ingestion — any sender can POST to /webhook or /webhook/<any-slug>
// ─────────────────────────────────────────────────────────────────────────────
//
//   POST /webhook                          ← root (no slug)
//   POST /webhook/ctr-001                  ← slug stored as `source` for tracking
//   POST /webhook/clay                     ← same idea
//   POST /webhook/<anything>?source=foo    ← override slug via query string
//
// Payload is permissive — any field name variant gets mapped to our lpf_jobs
// shape. A single job per request, OR { jobs: [...] }, OR a raw array. Returns
// the inserted row id(s). The job is parked at stage = 'received' and the
// pipeline picks it up on the next cycle.
//
// Health/info: GET /webhook/<anything> returns a sender-friendly probe so a
// third party can verify the endpoint exists without writing test data.
// ─────────────────────────────────────────────────────────────────────────────

// Slugs that are RESERVED by the dedicated handlers above. Anything else is
// treated as a generic slug used purely for source-tagging.
const RESERVED_SLUGS = new Set(['lpf', 'lpf-batch']);

router.get('/', (_req, res) => {
    res.json({
        ok:        true,
        message:   'LPF generic webhook is live. POST a job (or { jobs: [...] }) to ingest. See README for payload shape.',
        endpoint:  'POST /webhook  or  POST /webhook/<your-slug>',
        ts:        new Date().toISOString(),
    });
});

router.get('/:slug', (req, res) => {
    if (RESERVED_SLUGS.has(req.params.slug)) {
        return res.status(405).json({
            ok:    false,
            error: `Slug "${req.params.slug}" is reserved — use POST, not GET`,
        });
    }
    res.json({
        ok:       true,
        message:  `Webhook slug "${req.params.slug}" is live. POST to this URL to ingest a job.`,
        slug:     req.params.slug,
        endpoint: `POST /webhook/${req.params.slug}`,
        ts:       new Date().toISOString(),
    });
});

// Root POST — no slug
router.post('/', async (req, res) => handleGenericIngest(req, res, null));

// Slug POST — anything except the reserved ones falls through to handleGenericIngest.
// Reserved slugs already matched above, so any /:slug that reaches here is a third-party sender.
router.post('/:slug', async (req, res) => {
    if (RESERVED_SLUGS.has(req.params.slug)) {
        // Shouldn't happen because the explicit handlers are registered first,
        // but guard anyway so we never accidentally double-handle.
        return res.status(404).json({ ok: false, error: `Use POST /webhook/${req.params.slug} (handled above)` });
    }
    return handleGenericIngest(req, res, req.params.slug);
});

async function handleGenericIngest(req, res, slug) {
    const startedAt = Date.now();
    try {
        const body = req.body;
        if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
            return res.status(400).json({ ok: false, error: 'Empty body — POST a JSON object or array' });
        }

        // Accept three shapes: single object, raw array, or { jobs: [...] }
        const items = Array.isArray(body)
            ? body
            : Array.isArray(body.jobs) ? body.jobs
            : [body];

        const sourceTag = slug || req.query.source || req.get('x-source') || 'generic_webhook';

        const results = [];
        let savedCount   = 0;
        let skippedCount = 0;

        let dedupedCount = 0;
        for (const raw of items) {
            const p = looseNormalise(raw);
            if (!p.job_url) {
                skippedCount++;
                results.push({ ok: false, error: 'missing job_url / url / link', input_keys: raw ? Object.keys(raw) : [] });
                continue;
            }
            // Tag the source so we can trace which sender ingested the job
            if (!p.source) p.source = sourceTag;
            p.search_term = p.search_term || sourceTag;

            // ── Dedup gate — same rule as /lpf, runs BEFORE we touch the DB ──
            const dup = await db.checkJobDedupe(p).catch(() => ({ duplicate: false }));
            if (dup.duplicate) {
                dedupedCount++;
                results.push({
                    ok:              false,
                    deduped:         true,
                    job_url:         p.job_url,
                    title:           p.job_title,
                    reason:          dup.reason,
                    match_kind:      dup.match_kind,
                    existing_job_id: dup.existing_job_id,
                });
                continue;
            }

            const row = await db.upsertJob(p);
            savedCount++;
            results.push({
                ok:       true,
                job_id:   row.id,
                stage:    row.stage,
                job_url:  p.job_url,
                title:    p.job_title,
                company:  p.company_name || p.company_url,
            });
        }

        logger.info('Generic webhook ingest', {
            slug:        sourceTag,
            received:    items.length,
            saved:       savedCount,
            skipped:     skippedCount,
            deduped:     dedupedCount,
            duration_ms: Date.now() - startedAt,
        });

        res.status(200).json({
            ok:        savedCount > 0,
            slug:      sourceTag,
            received:  items.length,
            saved:     savedCount,
            skipped:   skippedCount,
            deduped:   dedupedCount,
            results,
            ts:        new Date().toISOString(),
        });
    } catch (err) {
        logger.error('Generic webhook error', { error: err.message, stack: err.stack });
        res.status(500).json({ ok: false, error: err.message });
    }
}

// ── Normalise both payload formats (strict) ──────────────────────────────────

function normalise(raw) {
    if (!raw) return {};
    // Legacy /lpf endpoint also goes through looseNormalise so it gets the
    // same trim/sanitize/empty-string handling as the generic /webhook path.
    // Backward compatible — looseNormalise covers every alias the old code
    // expected.
    return looseNormalise(raw);
}

// ── Lenient field mapper for the generic /webhook endpoint ───────────────────
//
// Accepts a wide variety of common field names so third-party senders don't
// need to match our exact schema. First non-empty alias wins.
//
// Edge cases handled (real JPE payload examples):
//   • `country: " Switzerland"`             → trim leading/trailing whitespace
//   • `company_url: "groupemutuel.ch"`      → auto-prefix with "https://"
//   • `application_count_string` (snake)    → mapped to applicant_count
//   • `job_poster: ""` / `job_poster_url: ""` → treated as null (not URL)
//   • Empty strings on any field            → treated as missing (null)
function looseNormalise(raw) {
    if (!raw || typeof raw !== 'object') return {};

    // pick(...keys) — first non-empty value across the alias list. Trims
    // strings and treats whitespace-only as empty.
    const pick = (...keys) => {
        for (const k of keys) {
            const v = k.includes('.') ? deepGet(raw, k) : raw[k];
            if (v == null) continue;
            if (typeof v === 'string') {
                const t = v.trim();
                if (t !== '') return t;
            } else if (typeof v === 'number') {
                return String(v);
            } else if (v !== '') {
                return v;
            }
        }
        return null;
    };

    // Company name: also accept the legacy `company` string OR `company.name`
    let companyName = pick('company_name', 'companyName');
    if (!companyName && typeof raw.company === 'string') companyName = raw.company.trim() || null;
    if (!companyName && raw.company?.name) companyName = String(raw.company.name).trim() || null;

    // Company URL/LinkedIn — same pick + sanitize URL
    let companyUrl = pick('company_url', 'companyUrl', 'companyWebsite', 'company.url', 'company.website');
    companyUrl     = _sanitizeUrl(companyUrl);
    let companyLi  = pick('company_linkedin_url', 'companyLinkedinUrl', 'companyLinkedInURL', 'company.linkedInURL', 'company.linkedin');
    companyLi      = _sanitizeUrl(companyLi);

    // Job-poster URL only — `job_poster` from the JPE payload is a NAME field
    // (often empty), NOT a URL. We only pull the URL aliases.
    const jobPosterUrl = _sanitizeUrl(
        pick('job_poster_url', 'jobPosterUrl', 'jobPosterURL', 'poster_url', 'posterLinkedin')
    );

    return {
        job_url:              _sanitizeUrl(pick('job_url', 'jobUrl', 'url', 'link', 'posting_url', 'postingUrl', 'job_link')),
        job_title:            pick('job_title', 'jobTitle', 'title', 'position', 'role', 'job_name'),
        job_description:      pick('job_description', 'jobDescription', 'description', 'body', 'content', 'job_text', 'jd'),
        city:                 pick('city', 'job_city', 'location_city', 'location.city'),
        country:              pick('country', 'job_country', 'location_country', 'location.country'),
        company_url:          companyUrl,
        company_linkedin_url: companyLi,
        company_name:         companyName,
        job_poster_url:       jobPosterUrl,
        source:               pick('source', 'origin', 'platform'),
        // ADD application_count_string (snake) — that's what the JPE payload uses
        applicant_count:      pick('applicant_count', 'applicantCount', 'application_count_string', 'applicantCountString', 'applicants'),
        search_term:          pick('search_term', 'searchTerm', 'keyword', 'tag'),
    };
}

/**
 * URL sanitizer — handles real-world variations seen in webhook payloads:
 *   "groupemutuel.ch"          → "https://groupemutuel.ch"
 *   " https://foo.com/ "       → "https://foo.com/"
 *   ""                         → null
 *   "/relative/path"           → null (relative paths aren't useful here)
 *
 * If the input contains a protocol (http:/https:), preserve it; otherwise add
 * https://. Returns null for empty / whitespace-only / clearly-invalid input.
 */
function _sanitizeUrl(input) {
    if (input == null) return null;
    const trimmed = String(input).trim();
    if (!trimmed) return null;
    // Already has a protocol — return as-is (lowercased scheme)
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed.replace(/^HTTP/i, 'http').replace(/^HTTPS/i, 'https');
    }
    // Reject relative paths like "/jobs/123" (no point storing these)
    if (trimmed.startsWith('/')) return null;
    // Heuristic: if it looks like "host.tld" or "host.tld/path", add https://
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) {
        return 'https://' + trimmed;
    }
    return trimmed; // last-ditch — let downstream URL parsing fail visibly
}

function deepGet(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

module.exports = router;
