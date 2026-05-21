/**
 * Stage 5 — Enrich Contacts
 *
 * Email waterfall (first provider wins):
 *   0. QC Google Sheet lookup by LinkedIn slug   → pre-verified, no re-verify
 *   1. Findymail by LinkedIn URL                 → pre-verified
 *   2. Apollo enrichPerson (LinkedIn URL)        → verify with Findymail
 *   3. Apollo enrichByNameDomain                 → verify with Findymail
 *   4. Harvest API by LinkedIn URL               → verify with Findymail
 *   5. Trykitt.ai by LinkedIn URL                → verify with Findymail
 *   6. Findymail find (name + domain)            → pre-verified
 *   7. Trykitt.ai by name + domain               → verify with Findymail
 *
 * Per-provider cells: stage5_fm, stage5_ap, stage5_hv, stage5_tk
 * Replicates LPF Table 3a + WB2.2 enrichment columns.
 */
const Apollo    = require('../../services/ApolloService');
const Findymail = require('../../services/FindymailService');
const Harvest   = require('../../services/HarvestService');
const LinkedIn  = require('../../services/LinkedInApifyService');
const QCSheet   = require('../../services/GoogleSheetsService');
const Trykitt   = require('../../services/TrykittService');
const Connections = require('../../services/ConnectionService');
const GSheet      = require('../../services/GoogleSheetsServiceV2');
const { askJSON } = require('../../services/OpenAIService');
const Logger    = require('../../Logger');
const { setCellState, emitCellState } = require('../runCell');

// Strip a LinkedIn URL down to just the username/slug, used as the lookup key
// for the people-email Google Sheet integration.
function linkedinSlug(url) {
    if (!url) return null;
    return String(url)
        .toLowerCase()
        .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '')
        .replace(/^https?:\/\/[a-z]{2}\.linkedin\.com\/in\//i, '')
        .replace(/\/$/, '')
        .trim() || null;
}

const logger = new Logger('Stage05_EnrichContacts');

class Stage05_EnrichContacts {
    constructor(db) { this.db = db; }

    async run(job) {
        const summary = await this._runEnrichment(job);

        // ── Per-provider cell states ─────────────────────────────────────────
        const bs = summary.bySource || {};
        const provCells = [
            { id: 'stage5_fm', v: bs.findymail  || 0 },
            { id: 'stage5_ap', v: bs.apollo      || 0 },
            { id: 'stage5_hv', v: bs.harvest     || 0 },
            { id: 'stage5_tk', v: bs.trykitt     || 0 },
        ];
        for (const { id, v } of provCells) {
            const state = v > 0 ? 'success' : 'success_empty';
            await setCellState(job.id, id, state, { value: String(v) }).catch(() => {});
            emitCellState(job.id, id, state, { value: String(v) });
        }

        return {
            rejected: false,
            message:  `Enriched ${summary.enriched}/${summary.total} — emails found: ${summary.emailsFound} (fm:${bs.findymail||0} ap:${bs.apollo||0} hv:${bs.harvest||0} tk:${bs.trykitt||0})`,
            summary:  { enriched: summary.enriched, emailsFound: summary.emailsFound, verified: summary.verified, skipped: summary.skipped },
            logData:  summary,
        };
    }

    async _runEnrichment(job) {
        const contacts = await this.db.getContactsForJob(job.id);
        if (contacts.length === 0) {
            return { total: 0, enriched: 0, emailsFound: 0, verified: 0, skipped: 0, bySource: {} };
        }

        // ── Batch LinkedIn enrichment (Apify, one run for all with LI URLs) ──
        const liUrls = contacts
            .filter(c => c.linkedin_url && (!c.city || !c.country || !c.title))
            .map(c => c.linkedin_url);

        let liProfiles = {};
        if (liUrls.length > 0) {
            liProfiles = await LinkedIn.enrichProfiles(liUrls);
            logger.debug('LinkedIn batch enrichment', { requested: liUrls.length, got: Object.keys(liProfiles).length });
        }

        let enriched  = 0;
        let emailsFound = 0;
        let verified  = 0;
        let skipped   = 0;
        const bySource = {};

        // Derive a REAL company name from the company LinkedIn slug when the
        // job's `company_name` looks like a synthetic test value (very long
        // numeric suffix) or is blank. Used as fallback for Apollo Harvest +
        // Findymail name lookups so we don't search for "BMW Group Sheet Test
        // 1779335646" — we search for "BMW Group" instead.
        const derivedCompanyName = this._deriveRealCompanyName(job);

        for (const contact of contacts) {
            try {
                const liProfile = liProfiles[contact.linkedin_url] || null;
                const resolvedDomain = cleanDomain(job.company_domain)
                    || cleanDomain(job.company_url)
                    || cleanDomain(job.company_linkedin_url)
                    || cleanDomain(contact.company_url)
                    || cleanDomain(contact.company_name && `${contact.company_name.replace(/\s+/g,'').toLowerCase()}.com`);
                const result    = await this._enrichContact(contact, resolvedDomain, liProfile, {
                    derivedCompanyName,
                    job,
                });
                enriched++;
                if (result.emailFound) {
                    emailsFound++;
                    if (result.emailSource) bySource[result.emailSource] = (bySource[result.emailSource] || 0) + 1;
                } else if (result.emailSkipReason) {
                    // Persist WHY this contact didn't get an email — surfaces in dashboard
                    await this.db.updateContact(contact.id, { email_skip_reason: result.emailSkipReason }).catch(() => {});
                }
                if (result.emailVerified) verified++;
            } catch (err) {
                logger.warn(`Enrich failed for contact ${contact.id}`, { error: err.message, name: contact.full_name });
                await this.db.updateContact(contact.id, { email_skip_reason: `Enrich threw: ${err.message}` }).catch(() => {});
                skipped++;
            }
        }

        return { total: contacts.length, enriched, emailsFound, verified, skipped, bySource };
    }

    /**
     * Get a real company name to use for email-finder lookups when the
     * webhook-supplied `company_name` looks synthetic (test data, very long
     * numeric suffix, or generic placeholder). Falls back through:
     *   1. company_linkedin_url slug   → "linkedin.com/company/bmw-group" → "BMW Group"
     *   2. company_name (if reasonable length and no test markers)
     *   3. company_url hostname        → "bmwgroup.com" → "Bmwgroup"
     */
    _deriveRealCompanyName(job) {
        const isSynthetic = (name) => !name || /\b(test|sheet|e2e|smoke|sample|fresh|final|clean|dummy|placeholder)\b/i.test(name) || /\d{8,}/.test(name);

        // 1. LinkedIn slug — most reliable because the operator typically wires
        //    `company_linkedin_url` to the real LinkedIn page even in tests.
        const liUrl = job?.company_linkedin_url;
        if (liUrl) {
            const m = liUrl.match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i);
            if (m) {
                const slug = m[1].replace(/-/g, ' ').replace(/[_.]/g, ' ').trim();
                if (slug) return slug.replace(/\b\w/g, c => c.toUpperCase());
            }
        }

        // 2. job.company_name — if it doesn't look synthetic
        if (!isSynthetic(job?.company_name)) return job.company_name;

        // 3. Fall back to extracting from company_url
        if (job?.company_url) {
            try {
                const host = new URL(job.company_url.startsWith('http') ? job.company_url : 'https://' + job.company_url).hostname.replace(/^www\./, '');
                const root = host.split('.')[0];
                if (root && !isSynthetic(root)) return root.replace(/\b\w/g, c => c.toUpperCase());
            } catch (_) {}
        }
        return job?.company_name || null;  // last-ditch — even synthetic is better than nothing
    }

    async _enrichContact(contact, companyDomain, liProfile = null, ctx = {}) {
        // `ctx.job` was passed in by `run()` so we can reach job.rf_client_id +
        // any other job-level field from inside the email waterfall. Old code
        // referenced `job.*` as a free variable which threw with "job is not
        // defined" — `ctx.job` is the right way.
        const job = ctx.job || null;
        const updates = {};
        let emailFound    = false;
        let emailVerified = false;
        let emailSource   = null;

        // ── LinkedIn profile fill (city/country/title) ────────────────────────
        if (liProfile) {
            if (!contact.city    && liProfile.city)    updates.city    = liProfile.city;
            if (!contact.country && liProfile.country) updates.country = liProfile.country;
            if (!contact.title   && liProfile.title)   updates.title   = liProfile.title;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Email waterfall — strict priority chain (per operator spec):
        //   1. Google Sheet           — operator-curated cache (free, instant)
        //   2. CRM (RecruiterFlow)    — emails already in our client's CRM
        //   3. Trykitt.ai             — cheap LinkedIn-based finder
        //   4. Harvest                — Apollo /contacts/search (free, no credits)
        //   5. Findymail              — name+domain + LinkedIn finder (pre-verified)
        //   6. Apollo                 — paid enrichment, LAST resort (costs credits)
        // Stop at the first hit. Sources 1+2+5 are pre-verified — others get
        // run through Findymail.verifyEmail() before persisting.
        // ─────────────────────────────────────────────────────────────────────
        let email      = contact.email || null;
        let src        = contact.email_source || null;
        let preVerified = false;

        const liUrl = contact.linkedin_url || contact.li_merged
                   || contact.linkedin_url_merged || contact.person_linkedin_url;

        // ─── 1. Google Sheet ─────────────────────────────────────────────────
        // 1a. Operator-configured Google Sheet (purpose='people_email'),
        //     lookup by LinkedIn slug — see _lookupEmailInSheet helper below.
        if (!email && liUrl) {
            const found = await this._lookupEmailInSheet(liUrl);
            if (found?.email) { email = found.email; src = 'people_sheet'; preVerified = true; }
        }
        // 1b. Legacy QC Google Sheet (env-configured, back-compat).
        if (!email && contact.linkedin_url) {
            const qc = await this._safeCall(() => QCSheet.lookupEmail(contact.linkedin_url));
            if (qc) { email = qc; src = 'qc_sheet'; preVerified = true; }
        }

        // ─── 2. CRM (RecruiterFlow) ─────────────────────────────────────────
        // Search RF for contacts on this job's company (rf_client_id, set by
        // Stage 2 when the company already existed in CRM). Match by LinkedIn
        // URL first, then by name. Pre-verified — these are operator-curated.
        if (!email && job?.rf_client_id && process.env.RECRUITERFLOW_API_KEY) {
            const RF = require('../../services/RecruiterFlowService');
            const crmHit = await this._safeCall(() => RF.findContactEmailInCompany(job.rf_client_id, {
                linkedinUrl: contact.linkedin_url,
                firstName:   contact.first_name,
                lastName:    contact.last_name,
            }));
            if (crmHit?.email) { email = crmHit.email; src = 'crm_recruiterflow'; preVerified = true; }
        }

        // ─── 3. Trykitt.ai ───────────────────────────────────────────────────
        // 3a. By LinkedIn URL
        if (!email && contact.linkedin_url) {
            const t = await this._safeCall(() => Trykitt.findByLinkedIn(contact.linkedin_url));
            if (t) { email = t; src = 'trykitt'; preVerified = false; }
        }
        // 3b. By name + domain
        if (!email && contact.first_name && contact.last_name && companyDomain) {
            const t = await this._safeCall(() =>
                Trykitt.findByNameDomain(contact.first_name, contact.last_name, companyDomain));
            if (t) { email = t; src = 'trykitt'; preVerified = false; }
        }

        // ─── 4. Harvest (Apollo /contacts/search — credit-free) ──────────────
        if (!email && contact.linkedin_url) {
            const found = await this._safeCall(() => Harvest.findEmailByLinkedIn(contact.linkedin_url));
            if (found?.email) { email = found.email; src = 'harvest'; preVerified = false; }
        }

        // ─── 5. Findymail ────────────────────────────────────────────────────
        // Track WHY findymail didn't find an email so we can persist a
        // human-readable skip_reason on the contact.
        const findymailReasons = [];
        // 5a. By LinkedIn URL (pre-verified by Findymail itself)
        if (!email && contact.linkedin_url) {
            const found = await this._safeCall(() => Findymail.findEmailByLinkedIn(contact.linkedin_url));
            if (found?.email) { email = found.email; src = 'findymail'; preVerified = true; }
            else if (found?.error) findymailReasons.push(`by-LinkedIn: ${found.error}`);
        }
        // 5b. By name + domain (pre-verified)
        if (!email && contact.first_name && contact.last_name && companyDomain) {
            const found = await this._safeCall(() =>
                Findymail.findEmail(contact.first_name, contact.last_name, companyDomain));
            if (found?.email) { email = found.email; src = 'findymail'; preVerified = true; }
            else if (found?.error) findymailReasons.push(`by-name+domain (${companyDomain}): ${found.error}`);
        }

        // ─── 5c. Apollo Harvest by NAME + REAL company name ─────────────────
        // Credit-free Apollo /v1/contacts/search lookup. Best fallback when:
        //   - The contact has no LinkedIn URL (Findymail's strongest path fails)
        //   - The company domain looks synthetic (test data, fake URL)
        // We use the *derived* real company name (e.g. "BMW Group" from the
        // LinkedIn slug) instead of the synthetic test name.
        const realCompanyName = ctx.derivedCompanyName || contact.company_name;
        const harvestByNameReasons = [];
        if (!email && contact.first_name && contact.last_name && realCompanyName) {
            const found = await this._safeCall(() =>
                Apollo.harvestEmailByName({
                    firstName:   contact.first_name,
                    lastName:    contact.last_name,
                    companyName: realCompanyName,
                    jobId:       contact.job_id,
                    operation:   'stage5_harvest_by_name',
                }));
            if (found?.email) {
                email = found.email; src = 'apollo_harvest_by_name'; preVerified = false;
            } else {
                harvestByNameReasons.push(`Apollo Harvest by name (${realCompanyName}): not in account pool`);
            }
        } else if (!email) {
            harvestByNameReasons.push(`Apollo Harvest skipped: ${!realCompanyName ? 'no company name' : 'no first/last name'}`);
        }

        // (no domain guessing — Stage 2 is now responsible for resolving the
        // real domain via the AI domain-finder fallback; if it can't, the job
        // is rejected outright + Stage 5 never runs)
        const findymailGuessReasons = [];

        // ─── 6. Apollo (paid — LAST resort) ─────────────────────────────────
        // Skipped automatically when ApolloService's credit breaker is tripped.
        const apolloBreakerTripped = (() => {
            try { return require('../../services/ApolloService').isCreditBreakerTripped(); }
            catch (_) { return false; }
        })();
        if (!apolloBreakerTripped) {
            // 6a. By LinkedIn URL
            if (!email && contact.linkedin_url) {
                const p = await this._safeCall(() => Apollo.enrichPerson(contact.linkedin_url));
                if (p?.email) { email = p.email; src = 'apollo'; preVerified = false; }
            }
            // 6b. By name + domain
            if (!email && contact.first_name && contact.last_name && companyDomain) {
                const p = await this._safeCall(() =>
                    Apollo.enrichByNameDomain(contact.first_name, contact.last_name, companyDomain));
                if (p?.email) { email = p.email; src = 'apollo'; preVerified = false; }
            }
        }

        // ── Verify non-pre-verified emails with Findymail ─────────────────────
        if (email && !preVerified) {
            const verification = await this._safeCall(() => Findymail.verifyEmail(email));
            if (!verification) {
                logger.debug('Email undeliverable — discarding', { email, contact_id: contact.id });
                email = null; src = null;
            } else {
                emailFound        = true;
                emailVerified     = verification.valid || false;
                emailSource       = src;
                updates.email          = email;
                updates.email_source   = src;
                updates.email_validated = verification.valid;
            }
        } else if (email && preVerified) {
            emailFound    = true;
            emailVerified = true;
            emailSource   = src;
            updates.email          = email;
            updates.email_source   = src;
            updates.email_validated = true;
        }

        // Write email back to QC sheet if found
        if (email && src !== 'qc_sheet' && contact.linkedin_url) {
            this._safeCall(() => QCSheet.writeEmail(contact.linkedin_url, email));
        }

        // Write email back to the operator-configured people-email sheet so future
        // pipeline runs hit the cache instead of paying for the email waterfall.
        if (email && src !== 'people_sheet' && (liProfile || contact.linkedin_url || contact.li_merged)) {
            this._writeEmailToPeopleSheet(contact, email, src, emailVerified).catch(err =>
                logger.warn('People sheet write-back failed', { error: err.message })
            );
        }

        // ── LinkedIn URL consolidation ────────────────────────────────────────
        if (contact.person_linkedin_url && !contact.li_merged) {
            updates.li_merged           = contact.person_linkedin_url;
            updates.linkedin_url_merged = contact.person_linkedin_url;
        }

        // ── DACH confirmation ─────────────────────────────────────────────────
        const countryForDach = updates.country || contact.country;
        updates.is_dach = isDACH(countryForDach);
        if (!updates.is_dach && contact.linkedin_url && !countryForDach) {
            const dachCheck = await this._checkDACHViaLinkedIn(contact.linkedin_url, contact.job_id);
            if (dachCheck === 'yes') updates.is_dach = true;
            else if (dachCheck === 'no') updates.is_dach = false;
        }

        // ── IT Role Verification ──────────────────────────────────────────────
        if (contact.title && !contact.is_it_role) {
            updates.is_it_role = isITRole(contact.title);
        }

        // HeyReach eligibility: (DACH or unknown location) + IT role
        updates.is_heyreach_eligible = (updates.is_dach || !countryForDach) &&
                                       (updates.is_it_role || contact.is_it_role || false);

        // ── Gender / Salutation ───────────────────────────────────────────────
        if (!contact.salutation && contact.first_name) {
            const gen      = await this._identifyGender(contact.first_name, contact.last_name, contact.job_id);
            updates.gender     = gen.gender;
            updates.salutation = gen.salutation;
        }

        // ── Write updates ─────────────────────────────────────────────────────
        if (Object.keys(updates).length > 0) {
            const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
            await this.db.db.query(
                `UPDATE lpf_contacts SET ${sets} WHERE id = $1`,
                [contact.id, ...Object.values(updates)]
            );
        }

        // Build a human-readable skip reason when no email was found, listing
        // every provider we tried + why each one fell through. Shows in the UI.
        let emailSkipReason = null;
        if (!emailFound) {
            const tried = [];
            if (!contact.linkedin_url)  tried.push('no LinkedIn URL (skips Findymail-by-LI, Trykitt-by-LI, Apollo enrich)');
            if (!companyDomain)         tried.push('no resolvable company domain (skips name+domain lookups)');
            if (findymailReasons.length)       tried.push(...findymailReasons.map(r => `Findymail ${r}`));
            if (harvestByNameReasons.length)   tried.push(...harvestByNameReasons);
            if (findymailGuessReasons.length)  tried.push(...findymailGuessReasons);
            const apolloBreakerTrippedNow = (() => {
                try { return require('../../services/ApolloService').isCreditBreakerTripped(); }
                catch (_) { return false; }
            })();
            if (apolloBreakerTrippedNow) tried.push('Apollo paid skipped — credit breaker tripped (out of credits)');
            if (!process.env.TRYKITT_API_KEY) tried.push('Trykitt skipped — TRYKITT_API_KEY not set');
            if (!process.env.HARVEST_API_KEY) tried.push('Harvest skipped — HARVEST_API_KEY not set');
            emailSkipReason = tried.length
                ? `No email found. Reasons: ${tried.join(' | ')}`
                : 'No email found. All providers tried returned no match.';
        }

        return { emailFound, emailVerified, emailSource, emailSkipReason };
    }

    async _checkDACHViaLinkedIn(linkedinUrl, jobId = null) {
        try {
            const result = await askJSON(
                'Output ONLY valid JSON — no markdown.',
                `Determine if this LinkedIn profile is based in Germany or Switzerland.
Visit the URL, extract their location, output:
{ "in_dach": "yes" | "no" | "" }

LinkedIn URL: ${linkedinUrl}`,
                'gpt-4o-mini',
                { jobId, operation: 'stage5_dach_linkedin_check' }
            );
            return (result?.in_dach || '').toLowerCase().trim();
        } catch (_) { return ''; }
    }

    async _identifyGender(firstName, lastName, jobId = null) {
        try {
            const result = await askJSON(
                'Output ONLY valid JSON.',
                `Identify gender from first name. Context: DACH region.
First name: "${firstName}", Last name: "${lastName || ''}"
Respond: { "gender": "male"|"female"|"unknown", "salutation": "Herr [LastName]"|"Frau [LastName]"|"[FirstName] [LastName]" }
Rules: male→"Herr [LastName]", female→"Frau [LastName]", unknown→"[FirstName] [LastName]"`,
                'gpt-4o-mini',
                { jobId, operation: 'stage5_gender_id' }
            );
            return {
                gender:     result.gender || 'unknown',
                salutation: result.salutation || `${firstName} ${lastName || ''}`.trim(),
            };
        } catch (_) {
            return { gender: 'unknown', salutation: `${firstName} ${lastName || ''}`.trim() };
        }
    }

    async _safeCall(fn) {
        try { return await fn(); } catch (_) { return null; }
    }

    /**
     * Look up an email for a LinkedIn URL in the operator-configured Google Sheet
     * (Connections tab → purpose='people_email'). The sheet's lookup column is
     * column_mapping.linkedin_username (e.g. 'LinkedIn URL' or 'Slug'); the email
     * is returned from column_mapping.email (e.g. 'Email Found').
     */
    async _lookupEmailInSheet(linkedinUrl) {
        try {
            const conn = await Connections.getDefault('google_sheet', 'people_email');
            if (!conn) return null;

            const slug = linkedinSlug(linkedinUrl);
            if (!slug) return null;

            // Build the list of candidate values to try.
            // • If the operator picked an explicit lookup_pipeline_field, use only that.
            //   - 'linkedin_username' → slug only
            //   - 'linkedin_url'      → full URL only
            //   - any other field     → not currently supported on the contact path
            // • Otherwise fall back to the legacy "try both" behavior.
            const explicit = conn.config?.lookup_pipeline_field;
            let candidates;
            if (explicit === 'linkedin_username') candidates = [slug];
            else if (explicit === 'linkedin_url') candidates = [linkedinUrl];
            else                                  candidates = [slug, linkedinUrl];

            for (const val of candidates) {
                const hit = await GSheet.lookupRow(conn.config, val).catch(() => null);
                if (hit?.found) {
                    const emailHeader = conn.config.column_mapping?.email || 'email';
                    const email = (hit.row[emailHeader] || hit.row.email || '').trim() || null;
                    if (email) {
                        logger.info('People sheet HIT', { value: val, email, sheet: conn.name });
                        return { email, rowNumber: hit.rowNumber };
                    }
                }
            }
            return null;
        } catch (err) {
            logger.warn('People sheet lookup error', { error: err.message });
            return null;
        }
    }

    /**
     * Save a freshly-found email back to the people-email sheet so we cache it for next time.
     * Uses the same column_mapping the operator configured for lookup — upsert keeps
     * the sheet de-duplicated on LinkedIn username.
     */
    async _writeEmailToPeopleSheet(contact, email, source, verified) {
        const conn = await Connections.getDefault('google_sheet', 'people_email').catch(() => null);
        if (!conn) return;

        const liUrl = contact.linkedin_url || contact.li_merged
                   || contact.linkedin_url_merged || contact.person_linkedin_url;
        const slug = linkedinSlug(liUrl);
        if (!slug || !email) return;

        const record = {
            linkedin_username: slug,
            linkedin_url:      liUrl,
            email,
            email_source:      source || '',
            email_verified:    verified ? 'TRUE' : 'FALSE',
            full_name:         contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
            first_name:        contact.first_name || '',
            last_name:         contact.last_name  || '',
            title:             contact.title      || '',
            company_name:      contact.company_name || '',
            country:           contact.country     || '',
            saved_at:          new Date().toISOString(),
        };
        await GSheet.upsertRow(conn.config, slug, record);
        logger.info('Email written back to people sheet', { sheet: conn.name, slug });
    }
}

function cleanDomain(str) {
    if (!str) return null;
    try {
        const normalized = str.includes('://') ? str : 'https://' + str;
        return new URL(normalized).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch (_) {
        return str.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '').toLowerCase() || null;
    }
}

function isDACH(country) {
    if (!country) return false;
    const c = country.toLowerCase();
    return c.includes('germany') || c.includes('deutschland') ||
           c.includes('austria') || c.includes('österreich') ||
           c.includes('switzerland') || c.includes('schweiz');
}

function isITRole(title) {
    if (!title) return false;
    const t = title.toLowerCase();
    return ['cto','it ','engineer','developer','architect','technical','technology',
            'software','sap','data','cloud','devops','infrastructure','head of',
            'vp engineering','digital','informatik','technisch'].some(k => t.includes(k));
}

module.exports = Stage05_EnrichContacts;
