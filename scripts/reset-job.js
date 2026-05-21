// Usage: node scripts/reset-job.js <jobId>
require('dotenv').config();
const DatabaseService = require('../src/database/DatabaseService');
const db = new DatabaseService();

const jobId = parseInt(process.argv[2] || '1');

(async () => {
    await db.db.query('DELETE FROM lpf_contacts WHERE job_id = $1', [jobId]);
    await db.db.query('DELETE FROM lpf_pipeline_log WHERE job_id = $1', [jobId]);
    await db.db.query('DELETE FROM lpf_sends WHERE job_id = $1', [jobId]);
    await db.db.query(
        "UPDATE lpf_jobs SET stage = 'received', processed_at = NULL, sent_at = NULL, stage_error = NULL WHERE id = $1",
        [jobId]
    );
    console.log('Job ' + jobId + ' reset to received');
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
