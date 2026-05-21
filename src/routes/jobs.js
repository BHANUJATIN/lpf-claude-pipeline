const express = require('express');
const DatabaseService = require('../database/DatabaseService');
const Logger = require('../Logger');

const router = express.Router();
const logger = new Logger('JobsRoute');
const db = new DatabaseService();

// GET /jobs — list jobs with optional filters
router.get('/', (req, res) => {
    const { limit = 50, offset = 0, processed } = req.query;
    const processedFilter = processed !== undefined
        ? (processed === 'true' || processed === '1' ? 1 : 0)
        : null;

    const jobs = db.getJobs({
        limit:     parseInt(limit),
        offset:    parseInt(offset),
        processed: processedFilter,
    });

    res.json({ count: jobs.length, jobs });
});

// GET /jobs/counts — summary counts
router.get('/counts', (_req, res) => {
    res.json(db.countJobs());
});

// GET /jobs/:id — single job detail
router.get('/:id', (req, res) => {
    const job = db.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });

    // Parse stored JSON fields for nicer response
    if (job.claude_result) {
        try { job.claude_result = JSON.parse(job.claude_result); } catch (_) {}
    }
    if (job.raw_payload) {
        try { job.raw_payload = JSON.parse(job.raw_payload); } catch (_) {}
    }

    res.json(job);
});

// POST /jobs/process — trigger Claude processing for unprocessed jobs
router.post('/process', async (req, res) => {
    const JobProcessor = require('../services/JobProcessor');
    const { limit = 20, dry_run = false } = req.body;

    logger.info('Manual processing triggered via API', { limit, dry_run });

    // Start processing in background, respond immediately
    res.json({ ok: true, message: `Processing up to ${limit} jobs...` });

    const processor = new JobProcessor();
    try {
        const result = await processor.run({ limit: parseInt(limit), dryRun: Boolean(dry_run) });
        logger.info('Manual processing complete', result);
    } catch (err) {
        logger.error('Manual processing failed', { error: err.message });
    }
});

module.exports = router;
