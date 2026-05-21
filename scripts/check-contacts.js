require('dotenv').config();
const DatabaseService = require('../src/database/DatabaseService');
const db = new DatabaseService();

(async () => {
    for (const jobId of [1, 2, 3]) {
        const contacts = await db.getContactsForJob(jobId);
        console.log('\nJob ' + jobId + ' — ' + contacts.length + ' contacts:');
        contacts.forEach(c => {
            const email     = c.email ? c.email : 'no email';
            const validated = c.email_validated ? '✓' : '✗';
            const type      = (c.contact_type || '').padEnd(12);
            const name      = (c.full_name    || '').padEnd(25);
            const src       = c.source || '';
            console.log('  ' + type + ' ' + name + ' ' + email.padEnd(32) + ' ' + validated + ' ' + src);
        });
    }
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
