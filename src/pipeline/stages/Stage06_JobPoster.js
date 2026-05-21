/**
 * Stage 6 — Job Poster Extraction
 *
 * Replicates WB2.3 (2b3. Job Poster Extraction):
 *   Extracts the person who posted/manages the job from two sources:
 *   (a) job_poster_url from JPE (LinkedIn URL of the poster)
 *   (b) JD text — names, emails, LinkedIn URLs embedded in the description
 *       (e.g. "Contact Anna Müller at anna@company.com" or "Apply via linkedin.com/in/annamueller")
 *
 *   Col 10 JobPoster LI URL [Webhook]
 *   Col 14 Job Poster Info (extracted from JD text — LPF effective prompt)
 *   Col 15 JP Linkedin Profile Url
 *   Col 16 Job Poster Name
 *   Col 17 HTTP API (Apollo enrichment)
 *   Col 18 Enrich Person (Claygent — GPT extraction from JD)
 *   Col 19 JP Apollo Email
 *   Col 20 Validate Email
 *   Col 21 Validated Email
 *   Col 23 LinkedIn Profile URL
 *   Col 24 [Merged] LI Profile URL
 *   Col 27 Full Name [Merged]
 *   Col 28 First Name [Merged]
 *   Col 29 Last Name [Merged]
 *   Col 30 Job Title [Merged]
 *   Col 31 JP Location
 *   Col 33 IT Role Verification
 *   Col 34 German Gender Identification
 *   Col 35 Frau/Herr + Last Name
 *   Col 36 Write to Table 3a [JP Person]
 *   Col 37 Write to Hey Reach Table
 *   Col 38 HR Email Address
 *   Col 41 Normalized Company Name
 *   Col 44 Write to Table 3a [HR Email]
 */
const Apollo     = require('../../services/ApolloService');
const Findymail  = require('../../services/FindymailService');
const { askJSON} = require('../../services/OpenAIService');
const Logger     = require('../../Logger');
const { runCell } = require('../runCell');

const logger = new Logger('Stage06_JobPoster');

// LPF WB2.3 Col 18 effective prompt — extracts job poster from JD text
const JOB_POSTER_EXTRACTION_PROMPT = `You are analysing a job posting to find the person who created or manages this listing.

This person is typically:
- Mentioned by name as the hiring manager, recruiter, or point of contact
- Identified by phrases like "Contact [Name]", "Apply to [Name]", "Send CV to [Name]", "Questions to [Name]"
- Found with an email address embedded in the description (e.g. "anna@company.com", "send to jobs@company.com")
- Found with a LinkedIn URL embedded in the description (e.g. "linkedin.com/in/annamueller")
- Listed as "Ansprechpartner", "Kontakt", "Ansprechpartnerin" in German job postings
- Mentioned in "Reporting to [Name]" or "You will report to [Name]" sections

Job Title: {job_title}
Company: {company_name}
Job Poster LinkedIn URL (from scraper, if available): {job_poster_url}

Job Description:
{job_description}

Find the PRIMARY contact person for this job posting. Extract:
{
  "found": true or false,
  "full_name": "First Last or null",
  "first_name": "First or null",
  "last_name": "Last or null",
  "email": "email@domain.com or null (only if explicitly visible in JD)",
  "linkedin_url": "https://linkedin.com/in/... or null (only if explicitly in JD or matches job_poster_url)",
  "title": "their job title if mentioned or null",
  "extraction_source": "jd_text | job_poster_url | both | none"
}

If no contact person is found, return {"found": false} with all other fields null.
Do NOT invent names or emails. Only extract what is explicitly present.`;

class Stage06_JobPoster {
    constructor(db) { this.db = db; }

    async run(job) {
        let posterResult;
        await runCell({
            jobId: job.id,
            colId: 'stage6_job_poster',
            fn: async () => {
                posterResult = await this._runPosterExtraction(job);
                return posterResult.name || (posterResult.hasEmail ? 'email found' : null);
            }
        });

        if (!posterResult) return { rejected: false, message: 'Job poster extraction failed', fields: {} };

        return {
            rejected: false,
            message:  posterResult.message,
            summary:  posterResult.summary,
            logData:  posterResult.logData,
            fields:   posterResult.fields || {},
        };
    }

    async _runPosterExtraction(job) {
        // ── Step 1: Extract poster info from JD text (LPF WB2.3 Col 18) ──────
        let extracted = null;
        if (job.job_description || job.job_poster_url) {
            extracted = await this._extractPosterFromJD(job);
        }

        if (!extracted?.found && !job.job_poster_url) {
            return {
                name: null, hasEmail: false,
                message: 'No job poster found in JD text or poster URL — skipped',
                summary: {}, logData: {},
            };
        }

        // ── Step 2: Resolve LinkedIn URL — JD-extracted takes precedence ──────
        let posterLinkedInUrl = extracted?.linkedin_url || job.job_poster_url || null;

        // Validate the URL — drop fabricated or 404 URLs before we pay for
        // Apollo enrichment + persist them downstream. Same gate Stage 4/7 use.
        if (posterLinkedInUrl) {
            const LinkedInUrlValidator = require('../../services/LinkedInUrlValidator');
            const v = await LinkedInUrlValidator.validate(posterLinkedInUrl);
            if (!v.ok) {
                logger.info('Stage 6 dropped invalid job-poster LinkedIn URL', {
                    job_id: job.id, url: posterLinkedInUrl, reason: v.reason, status: v.status,
                });
                posterLinkedInUrl = null;
            }
        }

        // ── Step 3: Apollo person enrichment if LinkedIn URL available ───────
        let profile = null;
        if (posterLinkedInUrl) {
            profile = await this._safeCall(() => Apollo.enrichPerson(posterLinkedInUrl));
            if (profile) logger.debug('Apollo poster profile fetched', { name: profile.name });
        }

        // ── Step 4: Merge — Apollo > JD extraction > JPE source ──────────────
        const firstName  = profile?.first_name || extracted?.first_name || null;
        const lastName   = profile?.last_name  || extracted?.last_name  || null;
        const fullName   = profile?.name || extracted?.full_name
                         || [firstName, lastName].filter(Boolean).join(' ') || null;
        const title      = profile?.title  || extracted?.title  || null;
        const city       = profile?.city   || null;
        const country    = profile?.country || null;
        const liMerged   = profile?.linkedin_url || posterLinkedInUrl;

        // ── Step 5: Email — find then always verify via Findymail ─────────────
        let email       = extracted?.email || null;  // email found directly in JD text
        let emailSource = email ? 'jd_text' : null;
        let emailValid  = false;

        // Findymail by LinkedIn URL (pre-verified, no verify step needed)
        if (!email && posterLinkedInUrl) {
            const found = await this._safeCall(() => Findymail.findEmailByLinkedIn(posterLinkedInUrl));
            if (found?.email) { email = found.email; emailSource = 'findymail'; emailValid = true; }
        }

        // Apollo fallbacks if still no email
        if (!email) {
            if (posterLinkedInUrl) {
                const p = await this._safeCall(() => Apollo.enrichPerson(posterLinkedInUrl));
                if (p?.email) { email = p.email; emailSource = 'apollo'; }
            }
            if (!email && firstName && lastName && job.company_domain) {
                const p = await this._safeCall(() =>
                    Apollo.enrichByNameDomain(firstName, lastName, job.company_domain));
                if (p?.email) { email = p.email; emailSource = 'apollo'; }
            }
        }

        // Findymail by name+domain (pre-verified)
        if (!email && firstName && lastName && job.company_domain) {
            const found = await this._safeCall(() =>
                Findymail.findEmail(firstName, lastName, job.company_domain));
            if (found?.email) { email = found.email; emailSource = 'findymail'; emailValid = true; }
        }

        // Verify non-Findymail emails (Apollo, JD text)
        if (email && emailSource !== 'findymail') {
            const verification = await this._safeCall(() => Findymail.verifyEmail(email));
            if (verification === null) {
                logger.debug(`Job poster email undeliverable, discarding`, { email });
                email = null; emailSource = null;
            } else {
                emailValid = verification.valid;
            }
        }

        // ── Step 6: German gender + salutation (Col 34-35) ────────────────────
        let gender     = 'unknown';
        let salutation = fullName || '';
        if (firstName) {
            const gen  = await this._identifyGender(firstName, lastName, job.id);
            gender     = gen.gender;
            salutation = gen.salutation;
        }

        // ── Step 7: IT Role verification (Col 33) ─────────────────────────────
        const isITRole = title ? checkITRole(title) : false;

        // ── Step 8: Save as contact (type = job_poster) ───────────────────────
        if (firstName || email) {
            await this.db.insertContact({
                job_id:              job.id,
                company_url:         job.company_url,
                company_name:        job.company_name,
                first_name:          firstName,
                last_name:           lastName,
                full_name:           fullName,
                email,
                email_validated:     emailValid,
                email_source:        email ? emailSource : null,
                linkedin_url:        posterLinkedInUrl,
                linkedin_url_merged: liMerged,
                person_linkedin_url: posterLinkedInUrl,
                li_merged:           liMerged,
                title,
                city,
                country,
                is_dach:             isDACH(country),
                person_source:       'LPF JD Extract + Apollo',
                gender,
                salutation,
                source:              'job_poster',
                contact_type:        'job_poster',
                is_it_role:          isITRole,
                raw_data:            { profile, extracted },
            });
        }

        // ── Step 8b: Write poster fields back to lpf_jobs for the detail panel ──
        const posterFields = {};
        if (fullName)          posterFields.job_poster_name    = fullName;
        if (email)             posterFields.job_poster_email   = email;
        if (title)             posterFields.job_poster_title   = title;
        if (liMerged)          posterFields.job_poster_linkedin = liMerged;
        if (Object.keys(posterFields).length) {
            await this.db.updateJobFields(job.id, posterFields).catch(() => {});
        }

        // ── Step 9: HR Email extraction (WB2.3 Col 38) ────────────────────────
        if (job.company_domain) {
            await this._findHREmail(job);
        }

        // ── Step 10: Extract bare emails from JD text (careers@, jobs@, etc.) ──
        if (job.job_description) {
            await this._extractJDEmails(job, extracted?.email);
        }

        return {
            name:     fullName,
            hasEmail: Boolean(email),
            message:  `Job poster: ${fullName || 'unknown'} — email: ${email ? 'found' : 'not found'} — source: ${extracted?.extraction_source || 'poster_url'}`,
            summary:  { name: fullName, has_email: Boolean(email), is_it: isITRole, source: extracted?.extraction_source },
            logData:  { full_name: fullName, email_found: Boolean(email), salutation, extraction_source: extracted?.extraction_source },
            fields: {
                ...(fullName  ? { job_poster_name:    fullName    } : {}),
                ...(email     ? { job_poster_email:   email       } : {}),
                ...(title     ? { job_poster_title:   title       } : {}),
                ...(liMerged  ? { job_poster_linkedin: liMerged   } : {}),
            },
        };
    }

    async _extractPosterFromJD(job) {
        try {
            const prompt = JOB_POSTER_EXTRACTION_PROMPT
                .replace('{job_title}',       job.job_title       || '')
                .replace('{company_name}',    job.company_name    || '')
                .replace('{job_poster_url}',  job.job_poster_url  || 'not available')
                .replace('{job_description}', (job.job_description || '').slice(0, 3000));

            const result = await askJSON('Output ONLY valid JSON.', prompt,
                'gpt-4o-mini',
                { jobId: job.id, operation: 'stage6_jd_poster_extract' });
            return result;
        } catch (err) {
            logger.warn('JD poster extraction failed', { error: err.message });
            return null;
        }
    }

    async _extractJDEmails(job, posterEmail) {
        // Regex: find all email addresses in the JD text
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const found = [...new Set((job.job_description.match(emailRegex) || []))];
        if (!found.length) return;

        // Exclude poster email (already saved), noreply/info/support patterns
        const skip = new Set([
            posterEmail,
            ...(found.filter(e => /^(noreply|no-reply|donotreply|info|support|newsletter|unsubscribe)@/i.test(e))),
        ]);

        for (const email of found) {
            if (skip.has(email)) continue;
            try {
                await this.db.insertContact({
                    job_id:       job.id,
                    company_url:  job.company_url,
                    company_name: job.company_name,
                    email,
                    email_validated: false,
                    email_source: 'jd_text',
                    source:       'job_description',
                    contact_type: 'jd_email',
                    person_source:'extracted from JD',
                    is_dach:      false,
                    raw_data:     { extracted_from: 'job_description' },
                });
                logger.debug(`JD email contact inserted: ${email}`);
            } catch (_) {}
        }
    }

    async _findHREmail(job) {
        try {
            const hrPeople = await Apollo.searchPeople({
                domains:      [job.company_domain],
                personTitles: ['HR Director', 'HR Manager', 'Personalleiter', 'Head of HR'],
                perPage:      3,
            });
            for (const person of hrPeople) {
                if (person.email) {
                    const c = Apollo.normaliseApolloContact(person, job.id, job.company_url, 'hr', 'apollo');
                    if (c.first_name) {
                        const gen    = await this._identifyGender(c.first_name, c.last_name, job.id);
                        c.gender     = gen.gender;
                        c.salutation = gen.salutation;
                    }
                    await this.db.insertContact(c).catch(() => {});
                    break;
                }
            }
        } catch (_) {}
    }

    async _identifyGender(firstName, lastName, jobId = null) {
        try {
            const result = await askJSON(
                'Output ONLY valid JSON.',
                `German gender for name: first="${firstName}", last="${lastName || ''}".
{ "gender": "male"|"female"|"unknown", "salutation": "Herr [LastName]"|"Frau [LastName]"|"[FirstName] [LastName]" }`,
                'gpt-4o-mini',
                { jobId, operation: 'stage6_gender_id' }
            );
            return { gender: result.gender || 'unknown', salutation: result.salutation || `${firstName} ${lastName || ''}`.trim() };
        } catch (_) {
            return { gender: 'unknown', salutation: `${firstName} ${lastName || ''}`.trim() };
        }
    }

    async _safeCall(fn) {
        try { return await fn(); } catch (_) { return null; }
    }
}

function isDACH(country) {
    if (!country) return false;
    const c = country.toLowerCase();
    return c.includes('germany') || c.includes('austria') || c.includes('switzerland');
}

function checkITRole(title) {
    const t = title.toLowerCase();
    return ['it ', 'cto', 'engineer', 'developer', 'architect', 'software', 'sap', 'digital', 'data', 'cloud', 'technical'].some(k => t.includes(k));
}

module.exports = Stage06_JobPoster;
