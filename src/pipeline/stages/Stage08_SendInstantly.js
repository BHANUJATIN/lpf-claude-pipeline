/**
 * Stage 8 — Assemble & Send to Instantly
 *
 * Replicates:
 *   Table 3a → Write to Instantly action
 *   Table 2a Col 88 Send Jobs into CRM
 *   Table 2a Col 90 Send Company data
 *   WB2.2 Col 24 Write to Table 3a
 *   WB2.3 Col 36 Write to Table 3a [JP Person]
 *   WB2.3 Col 37 Write to Hey Reach Table
 *
 * Before sending, validates ALL required Instantly fields are present.
 * Logs every send attempt to lpf_sends.
 */
const Instantly = require('../../services/InstantlyService');
const Logger    = require('../../Logger');
const axios     = require('axios');

const logger = new Logger('Stage08_SendInstantly');

const CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID;
// Clay campaign name — skip sending if email already exists in this campaign
const CLAY_CAMPAIGN_NAME = process.env.INSTANTLY_CLAY_CAMPAIGN_NAME || 'Clay - "Local perfect fit" 1k PD';

class Stage08_SendInstantly {
    constructor(db) { this.db = db; }

    async run(job) {
        // Load the default Instantly connection's saved config (mapping + campaign).
        // Falls back to env vars when no connection row exists.
        let connConfig = {};
        try {
            const Connections = require('../../services/ConnectionService');
            const conn = await Connections.getDefault('api_key', 'instantly').catch(() => null);
            if (conn?.config) connConfig = conn.config;
        } catch (_) { /* connection lookup is best-effort */ }

        const campaignIdDefault = connConfig.campaign_id || CAMPAIGN_ID;
        const fieldMapping      = connConfig.field_mapping || null;
        const customVarKeys     = connConfig.custom_variable_keys || null;

        if (!campaignIdDefault) {
            logger.warn('No Instantly campaign id set (neither connection config nor env) — skipping send');
            return {
                rejected: false,
                message:  'Instantly campaign ID not configured — send skipped',
                fields:   {},
            };
        }

        const contacts = await this.db.getContactsForJob(job.id);
        // Only send contacts that are approved (or have no explicit decision — for backward compat)
        // Never send skipped contacts.
        const eligible = contacts.filter(c =>
            !c.sent_to_instantly &&
            c.email &&
            c.send_decision !== 'skipped'
        );

        if (eligible.length === 0) {
            return {
                rejected: false,
                message:  'No eligible contacts to send (missing email or already sent)',
                summary:  { eligible: 0, sent: 0, failed: 0 },
            };
        }

        // Build the full job context object needed for Instantly payload
        const jobContext = this._buildJobContext(job);

        let sent   = 0;
        let failed = 0;
        const failures = [];

        for (const contact of eligible) {
            // ── Instantly duplicate check ─────────────────────────────────────
            const alreadyInClay = await this._isEmailInClayCampaign(contact.email);
            if (alreadyInClay) {
                logger.info(`Skipped (already in Clay campaign): ${contact.email}`);
                failed++;
                await this.db.logSend(job.id, contact.id, CAMPAIGN_ID, null, null, false,
                    'Email already in Clay LPF campaign — skipped to avoid duplicate');
                continue;
            }

            // Resolve campaign — contact override → connection config → env default
            const campaignId = contact.send_campaign_id || campaignIdDefault;
            if (!campaignId) {
                logger.warn(`No campaign ID for contact ${contact.id} — skipped`);
                failed++;
                continue;
            }

            // ── Validate all required fields before sending ───────────────────
            const validation = Instantly.validatePayload(contact, jobContext);
            if (!validation.valid) {
                logger.warn(`Contact ${contact.id} missing fields — skipped`, {
                    missing: validation.missing.join(', '),
                    name:    contact.full_name,
                });
                await this.db.logSend(job.id, contact.id, campaignId, null, null, false,
                    `Missing: ${validation.missing.join(', ')}`);
                failed++;
                failures.push({ contact_id: contact.id, missing: validation.missing });
                continue;
            }

            const destination = contact.send_destination || 'instantly';

            // ── Send to Instantly ─────────────────────────────────────────────
            if (destination === 'instantly') {
                try {
                    const sendOpts = { fieldMapping, customVariableKeys: customVarKeys, campaignId };
                    const response = await Instantly.addLead(campaignId, contact, jobContext, sendOpts);
                    await this.db.markContactSent(contact.id, response?.id || null);
                    await this.db.logSend(job.id, contact.id, campaignId,
                        Instantly.buildInstantlyPayload(campaignId, contact, jobContext, sendOpts),
                        response, true, null);
                    sent++;
                    logger.info(`Sent to Instantly: ${contact.full_name} <${contact.email}>`, {
                        job_id: job.id, contact_id: contact.id, type: contact.contact_type,
                    });
                    await sleep(300);
                } catch (err) {
                    failed++;
                    failures.push({ contact_id: contact.id, error: err.message });
                    await this.db.logSend(job.id, contact.id, campaignId, null, null, false, err.message);
                    logger.error(`Instantly send failed for contact ${contact.id}`, { error: err.message });

                    // ── Terminal-error detection ─────────────────────────────
                    // Some Instantly responses mean "this contact will NEVER be
                    // accepted no matter how many times we retry" — blocklist,
                    // invalid email, account-suppression. Mark the contact as
                    // `send_decision='skipped'` so the stranded-send sweep
                    // (Pipeline.sweepStrandedContacts) stops banging on it.
                    // Transient errors (5xx, timeouts) are NOT marked skipped —
                    // those should be retried on the next sweep tick.
                    const body    = err.responseBody || {};
                    const message = String(body.message || '').toLowerCase();
                    const isTerminal =
                        message.includes('blocklist') ||
                        message.includes('block list') ||
                        message.includes('is invalid') ||
                        message.includes('not a valid email') ||
                        message.includes('suppression') ||
                        message.includes('unsubscribed') ||
                        (err.status === 400 && message.includes('email'));
                    if (isTerminal) {
                        const reason = `Instantly: ${body.message || err.message}`.slice(0, 500);
                        await this.db.updateContact(contact.id, {
                            send_decision:    'skipped',
                            send_skip_reason: reason,
                        }).catch(() => {});
                        logger.warn(`Contact ${contact.id} marked skipped — ${reason}`);
                    }
                }
            } else if (destination === 'heyreach') {
                // HeyReach — log for now, implement when API key available
                logger.warn(`HeyReach destination not yet implemented — contact ${contact.id} skipped`);
                await this.db.logSend(job.id, contact.id, campaignId, null, null, false, 'HeyReach not yet configured');
                failed++;
            }
        }

        await this.db.db.query(
            `UPDATE lpf_jobs SET sent_at = NOW() WHERE id = $1 AND $2 > 0`,
            [job.id, sent]
        );

        return {
            rejected: false,
            message:  `Sent ${sent}/${eligible.length} contacts to Instantly`,
            summary:  { eligible: eligible.length, sent, failed },
            logData:  { sent, failed, failures },
        };
    }

    /**
     * Check if an email already exists in the Clay LPF campaign on Instantly.
     * Returns true (skip) if: email is found AND the campaign name matches CLAY_CAMPAIGN_NAME.
     * Condition mirrors Clay: (!existing || campaignName !== CLAY_CAMPAIGN_NAME) → send
     */
    async _isEmailInClayCampaign(email) {
        const apiKey = process.env.INSTANTLY_API_KEY;
        if (!apiKey || !email) return false;
        try {
            const resp = await axios.get('https://api.instantly.ai/api/v1/lead/get', {
                params: { email, api_key: apiKey, campaign_id: CAMPAIGN_ID },
                timeout: 8000,
            });
            const leads = Array.isArray(resp.data) ? resp.data : [];
            if (leads.length === 0) return false;
            // Skip if any matching lead is in the Clay campaign
            return leads.some(lead => lead?.campaign_name === CLAY_CAMPAIGN_NAME);
        } catch (err) {
            // Non-200 (e.g. 404 not found) means email not in campaign → safe to send
            if (err.response?.status === 404) return false;
            logger.warn(`Instantly pre-check failed for ${email} — proceeding with send`, { error: err.message });
            return false;
        }
    }

    /**
     * Build the full job context object.
     * This must contain every custom variable Instantly uses in email templates.
     */
    _buildJobContext(job) {
        return {
            // Job
            job_title:               job.job_title,
            job_url:                 job.job_url,
            city:                    job.city,
            country:                 job.country,
            source:                  job.source,

            // Company
            company_name:            job.company_name,
            company_url:             job.company_url,
            company_linkedin_url:    job.company_linkedin_url,
            company_domain:          job.company_domain,
            company_description:     job.company_description,
            company_industry:        job.company_industry,
            company_employee_count:  job.company_employee_count,
            company_dach_employees:  job.company_dach_employees,
            company_hq_city:         job.company_hq_city,
            company_hq_country:      job.company_hq_country,

            // SAP / tech variables (Stage 3)
            sap_modules:                        job.sap_modules,
            sap_skills_comma:                   job.sap_skills_comma,
            tech_combined:                      job.tech_combined,
            tech_short:                         job.tech_short,
            tech_short2:                        job.tech_short2,
            tech_compressed:                    job.tech_compressed,
            tech_longer:                        job.tech_longer,
            top_job_tech_comma:                 job.top_job_tech_comma,
            primary_tech:                       job.primary_tech || 'SAP',
            dev_or_engineer:                    job.dev_or_engineer,
            a_dev_or_engineer:                  job.a_dev_or_engineer,
            dev_or_eng:                         job.dev_or_eng,
            shorter_tech_description:           job.shorter_tech_description || job.tech_short,
            shorter_tech_description_scrambled: job.shorter_tech_description_scrambled,
            shorter_tech_comma:                 job.shorter_tech_comma || job.top_job_tech_comma,
            comma_tech_description:             job.comma_tech_description || job.sap_skills_comma,
            imagined_city:                      job.imagined_city || job.city,
            imagined_nearby_city:               job.imagined_nearby_city,
            imagined_industry:                  job.imagined_industry || job.company_industry,

            // Quality signals
            quality_score:           job.quality_score,
            ctr_fit:                 job.ctr_fit,
            seniority:               job.seniority,
        };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = Stage08_SendInstantly;
