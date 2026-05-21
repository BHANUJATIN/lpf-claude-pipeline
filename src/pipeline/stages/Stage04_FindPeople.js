/**
 * Stage 4 — Find People
 *
 * Mirrors the Clay LPF + WB2.1 design — multi-source people discovery:
 *
 *   ── Free sources (always run, no API credits) ──
 *   0. CRM (RecruiterFlow listCompanyContacts) — existing contacts at the company
 *   1. Apollo Harvest  (/v1/contacts/search) — Apollo's account-wide contact pool
 *
 *   ── Paid sources (run when credits / keys are available) ──
 *   2. Apollo paid search — split into 3 pillars per WB2 spec:
 *        HR (9-8000 emp), CEO (9-350 emp), Tech+SAP (4-8000 emp)
 *      Each pillar runs its own person_titles set + employee_range filter.
 *   3. Apollo name-fallback — if domain search returns 0
 *
 *   ── AI web search (runs even when Apollo is dead — uses OpenAI) ──
 *   4. WB2 prompt set 1 — CEO/Owners DACH (verbatim Clay prompt)
 *   5. WB2 prompt set 2 — IT/Tech DACH
 *   6. WB2 prompt set 3 — HR DACH
 *
 * Each source is wrapped so that a single failure (auth, quota, hang) NEVER
 * stops the others — we collect whatever each returns and dedup at the end.
 * Target: 15-20 leads minimum per company, up to 100-200 on a rich match.
 */
const Apollo    = require('../../services/ApolloService');
const Logger    = require('../../Logger');
const { setCellState, emitCellState } = require('../runCell');
const wb2Prompts                       = require('../../prompts/wb2_people_search');
const { askWithWebSearch }             = require('../../services/OpenAIService');

const logger = new Logger('Stage04_FindPeople');

// ── Title lists ──────────────────────────────────────────────────────────────

const HR_TITLES = [
    'HR Director', 'VP HR', 'VP People', 'Head of HR', 'Head of People',
    'CHRO', 'Chief People Officer', 'HR Manager', 'Personalleiter', 'Personalleiterin',
    'Head of Talent', 'VP of Human Resources', 'Director of People',
    'Head of Talent Acquisition', 'Head of Recruiting',
    'Personalentwicklerin', 'Personalbeschaffer', 'Personalbeschafferin',
    'Leiter Personalwesen', 'Leiter Recruiting', 'Leiter Talent Acquisition',
    'HR-Leiter', 'Chief of Staff', 'Recruiter', 'Recruiterin',
];

const CEO_TITLES = [
    'CEO', 'Chief Executive Officer', 'Geschäftsführer', 'Geschäftsführerin',
    'Vorstandsvorsitzender', 'Founder', 'Co-Founder', 'Mitbegründer', 'Mitbegründerin',
    'Owner', 'Inhaber', 'President', 'COO', 'Managing Director',
    'Geschäftsführender Gesellschafter', 'Geschäftsleitung', 'Geschäftsführender',
    'Mitgesellschafter', 'Gesellschafter', 'Vorstand',
];

const TECH_TITLES = [
    'CTO', 'Chief Technology Officer', 'Chief Technical Officer',
    'VP Engineering', 'Vice President Engineering', 'Vice President of Engineering',
    'CTPO', 'CPTO',
    'VP Software', 'Vice President Software', 'Director Software',
    'Head of Software', 'Head of Engineering', 'Head of IT', 'Head of Technology',
    'IT Director', 'Director of Technology', 'Engineering Director',
    'Software Development Director', 'Software Engineering Manager',
    'Software Development Manager', 'Software Manager',
    'Head of Software Engineering', 'Head of Application Development',
    'Software Development Lead', 'Tech Lead', 'Technical Lead',
    'Engineering Manager', 'Chief Engineer', 'Chief Information Officer', 'CIO',
    'Head Information Technology', 'Leiterin IT',
    'IT-Leiter', 'Leiter IT', 'Technischer Leiter', 'Technologiechef',
    'Leiter Softwareentwicklung', 'Leiter Software', 'Leiter der Softwareentwicklung',
    'Leiter der Technik', 'Leiter Informationstechnologie',
    'Leiter Anwendungsentwicklung', 'Software-Direktor', 'Entwicklungsdirektor',
    'Manager für Softwareentwicklung', 'Softwaremanager',
    'Leiterin Softwareengineering', 'Leiter Softwareengineering',
    'VP der Softwareentwicklung',
];

const SAP_TITLES = [
    'SAP Manager', 'Head of SAP', 'SAP Director', 'VP IT',
    'Head of Application', 'Head of ERP', 'SAP Programme Manager', 'SAP Program Manager',
    'IT Manager', 'Leiter SAP', 'SAP Projektleiter',
    'Director of ERP', 'ERP Manager', 'SAP Practice Manager',
    'SAP Project Manager', 'SAP Solution Architect',
    'SAP Center of Excellence Manager', 'ABAP Team Lead', 'Head of ABAP',
    'SAP Integration Specialist', 'SAP Team Lead', 'SAP Lead',
    'Head ERP', 'Lead ERP',
    'Direktor für ERP', 'SAP-Praxis-Manager', 'Leiter SAP-Projekt',
    'ERP-Manager', 'SAP-Lösungsarchitekt', 'SAP-Programm-Manager',
    'ABAP-Teamleiter', 'Leiter ABAP', 'SAP-Integrationsspezialist',
];

// All titles combined — sent as one Apollo request (up to 100 results)
const ALL_TITLES = [...new Set([...HR_TITLES, ...CEO_TITLES, ...TECH_TITLES, ...SAP_TITLES])];

// Sales/marketing keywords — contacts whose title matches any of these are excluded
const SALES_MARKETING_KEYWORDS = [
    'sales', 'marketing', 'business development', 'account manager',
    'account executive', 'commercial director', 'commercial manager',
    'revenue', 'demand generation', 'growth hacker', 'brand manager',
    'digital marketing', 'seo', 'sem', 'paid media', 'social media',
    'content manager', 'community manager', 'pr manager', 'public relation',
    'customer success', 'customer acquisition', 'lead generation',
];

function isSalesMarketing(title) {
    if (!title) return false;
    const t = title.toLowerCase();
    return SALES_MARKETING_KEYWORDS.some(k => t.includes(k));
}

class Stage04_FindPeople {
    constructor(db) { this.db = db; }

    async run(job) {
        const domain    = cleanDomain(job.company_domain) || cleanDomain(job.company_url);
        const locations = countryToLocations(job.country);

        if (!domain) {
            try {
                await setCellState(job.id, 'stage4_apollo',      'success_empty', { value: '0' });
                emitCellState(job.id, 'stage4_apollo',      'success_empty', { value: '0' });
                await setCellState(job.id, 'stage4_linkedin',     'success_empty', { value: '0' });
                emitCellState(job.id, 'stage4_linkedin',     'success_empty', { value: '0' });
                await setCellState(job.id, 'stage4_people_total', 'success_empty', { value: '0' });
                emitCellState(job.id, 'stage4_people_total', 'success_empty', { value: '0' });
            } catch (_) {}
            return {
                rejected: false,
                message:  'Skipped people search — no domain available',
                fields:   { apollo_people_found: 0, li_people_found: 0, total_people_found: 0 },
            };
        }

        // Live-emit helper: writes one cell state to DB AND fires SSE in one go.
        // We flip cells from "running" → "success/success_empty" as each source
        // finishes so the dashboard never shows a cell stuck running while the
        // pipeline is actually elsewhere.
        const flush = async (colId, count) => {
            try {
                const state = count > 0 ? 'success' : 'success_empty';
                const val   = String(count);
                await setCellState(job.id, colId, state, { value: val });
                emitCellState(job.id, colId, state, { value: val });
            } catch (_) {}
        };

        // ── 0. CRM harvest — pull existing RF contacts for this company FIRST ──
        // Free, fast, and gives us emails the operator already curated.
        let contacts = await this._harvestCrmContacts(job);
        const crmCount = contacts.length;
        if (crmCount > 0) {
            logger.info(`Harvested ${crmCount} contact(s) from RecruiterFlow`, {
                job_id: job.id, rf_client_id: job.rf_client_id,
            });
        }
        // Flush CRM cell immediately — even before we run Apollo / WB2
        await flush('stage4_linkedin', crmCount);

        // ── 0.5. Apollo HARVEST — credit-free search of account's prior contacts ──
        // Hits /v1/contacts/search (not /mixed_people/search). Free, even when
        // the credit breaker is tripped. Returns people we've previously
        // searched into Apollo for this company — emails included when verified.
        let harvestCount = 0;
        try {
            const harvested = await Apollo.harvestContacts({
                companyName:     job.company_name || undefined,
                domain,
                personTitles:    ALL_TITLES,
                personLocations: locations,
                perPage:         100,
                jobId:           job.id,
                operation:       'apollo_harvest',
            });
            const harvestContacts = harvested
                .filter(p => !isSalesMarketing(p.title))
                .map(p => Apollo.normaliseHarvestContact(p, job.id, domain, this._guessType(p.title)));
            harvestCount = harvestContacts.length;
            contacts.push(...harvestContacts);
            if (harvestCount > 0) {
                logger.info(`Apollo harvest found ${harvestCount} prior contact(s) — free (no credits used)`, {
                    job_id: job.id, company: job.company_name, domain,
                });
            }
        } catch (err) {
            logger.warn('Apollo harvest failed (will fall through to paid search)', {
                error: err.message, status: err.status, job_id: job.id,
            });
        }

        // ── Apollo paid search — 3 pillars per WB2 spec (HR, CEO, Tech+SAP) ───
        // Each pillar uses its own title set + employee_range filter from the
        // Clay LPF Table 2a columns 15/18/19. We run them in parallel and dedup
        // at the end. If credit breaker is tripped, we skip all three cleanly.
        let apolloCount        = 0;
        const apolloPillarHits = { hr: 0, ceo: 0, tech_sap: 0 };
        let apolloError        = null;
        let apolloErrKind      = null;

        if (Apollo.isCreditBreakerTripped()) {
            apolloError   = 'Apollo: account has 0 credits — paid search disabled. Apollo Harvest + WB2 AI prompts still run.';
            apolloErrKind = 'apollo_no_credits';
            logger.warn('Apollo paid skipped — credit breaker tripped', { job_id: job.id, domain });
        } else {
            const pillarKeys = Object.keys(wb2Prompts.APOLLO_TITLE_SETS);
            const pillarRuns = await Promise.allSettled(pillarKeys.map(async (key) => {
                const cfg = wb2Prompts.APOLLO_TITLE_SETS[key];
                const people = await Apollo.searchPeople({
                    domains:       [domain],
                    personTitles:  cfg.titles,
                    employeeRange: cfg.employeeRange,
                    perPage:       100,
                    jobId:         job.id,
                    operation:     `people_search_${key}`,
                });
                return { key, people };
            }));

            for (const r of pillarRuns) {
                if (r.status === 'fulfilled') {
                    const { key, people } = r.value;
                    const pillarContacts = (people || [])
                        .filter(p => !locations.length || isInLocations(p.country, locations))
                        .filter(p => !isSalesMarketing(p.title))
                        .map(p => Apollo.normaliseApolloContact(p, job.id, domain, this._guessType(p.title), `apollo_${key}`));
                    apolloPillarHits[key] = pillarContacts.length;
                    apolloCount          += pillarContacts.length;
                    contacts.push(...pillarContacts);
                } else {
                    const err = r.reason || {};
                    if (err instanceof Apollo.ApolloCreditError) {
                        apolloError   = `Apollo: insufficient credits — top up your Apollo account to enable paid search. Provider said: "${err.providerMsg || err.message}"`;
                        apolloErrKind = 'apollo_no_credits';
                        logger.error('Apollo OUT OF CREDITS during pillar search', { job_id: job.id, domain });
                        break; // breaker will be tripped — no point running other pillars
                    } else {
                        logger.warn('Apollo pillar search failed', { error: err.message, status: err.status, job_id: job.id });
                    }
                }
            }
            logger.info('Apollo 3-pillar search summary', {
                job_id: job.id, hr: apolloPillarHits.hr, ceo: apolloPillarHits.ceo, tech_sap: apolloPillarHits.tech_sap, total: apolloCount,
            });
        }

        // ── Flush Apollo cell NOW (don't wait for WB2 which is slower) ─────────
        // After Apollo paid + Apollo harvest finish, mark the apollo cell so the
        // dashboard immediately reflects its outcome — even though WB2 prompts
        // (OpenAI web search) are still running. Same for the CRM/linkedin cell.
        await flush('stage4_apollo', apolloCount + harvestCount);

        // ── WB2 — 3-pillar AI prompt sets (CEO/Owners · IT/Tech · HR) ─────────
        // Runs OpenAI with web_search_preview — independent of Apollo's state.
        // Per-prompt 30s timeout to stop the stage from hanging forever when
        // OpenAI's web-search tool gets bogged down. Each pillar that returns
        // empty/errors is logged; pipeline always moves on.
        let wb2Count = 0;
        const wb2PillarHits = { ceo_owners: 0, it_tech: 0, hr: 0 };
        const wb2Inputs = {
            company_name:     job.company_name || '',
            company_website:  job.company_url  || (domain ? `https://${domain}` : ''),
            company_linkedin: job.company_linkedin_url || '',
        };

        const WB2_TIMEOUT_MS = parseInt(process.env.WB2_PROMPT_TIMEOUT_MS || '45000', 10);
        const withTimeout = (p, ms, label) => Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
        ]);

        const wb2Runs = await Promise.allSettled([
            { key: 'ceo_owners', userFn: wb2Prompts.CEO_OWNERS_USER_PROMPT, defaultType: 'ceo'  },
            { key: 'it_tech',    userFn: wb2Prompts.IT_TECH_USER_PROMPT,    defaultType: 'tech' },
            { key: 'hr',         userFn: wb2Prompts.HR_USER_PROMPT,         defaultType: 'hr'   },
        ].map(async ({ key, userFn, defaultType }) => {
            try {
                const raw = await withTimeout(
                    askWithWebSearch(
                        wb2Prompts.SYSTEM_PROMPT,
                        userFn(wb2Inputs),
                        { jobId: job.id, operation: `wb2_${key}` }
                    ),
                    WB2_TIMEOUT_MS, `WB2 ${key}`,
                );
                // The output_text may include prose around a JSON block — extract { … }
                const match = (raw || '').match(/\{[\s\S]*\}/);
                if (!match) return { key, leads: [], defaultType };
                let parsed;
                try { parsed = JSON.parse(match[0]); } catch (_) { return { key, leads: [], defaultType }; }
                return { key, leads: Array.isArray(parsed?.leads) ? parsed.leads : [], defaultType };
            } catch (err) {
                logger.warn(`WB2 ${key} aborted`, { error: err.message });
                return { key, leads: [], defaultType };
            }
        }));
        for (const r of wb2Runs) {
            if (r.status !== 'fulfilled') {
                logger.warn('WB2 pillar prompt failed', { error: r.reason?.message });
                continue;
            }
            const { key, leads, defaultType } = r.value;
            const mapped = leads
                .filter(l => l.linkedin_url || (l.first_name && l.last_name))
                .filter(l => !isSalesMarketing(l.title))
                .filter(l => !/-\d{8,}$/.test(l.linkedin_url || ''))  // drop fabricated -12345678 URLs
                .map(l => ({
                    job_id:              job.id,
                    company_url:         job.company_url,
                    company_name:        job.company_name,
                    first_name:          l.first_name || null,
                    last_name:           l.last_name  || null,
                    full_name:           [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || null,
                    email:               l.email      || null,
                    email_validated:     false,
                    email_source:        l.email ? 'wb2_ai_search' : null,
                    linkedin_url:        l.linkedin_url || null,
                    linkedin_url_merged: l.linkedin_url || null,
                    person_linkedin_url: l.linkedin_url || null,
                    li_merged:           l.linkedin_url || null,
                    title:               l.title || null,
                    city:                l.city  || null,
                    country:             l.country || null,
                    is_dach:             null,        // Stage 5 verifies via LinkedIn
                    person_source:       `WB2 ${key}`,
                    source:              `wb2_${key}`,
                    contact_type:        this._guessType(l.title || '') || defaultType,
                    raw_data:            l,
                }));
            wb2PillarHits[key] = mapped.length;
            wb2Count          += mapped.length;
            contacts.push(...mapped);
        }
        logger.info('WB2 3-pillar AI search summary', {
            job_id: job.id, ceo_owners: wb2PillarHits.ceo_owners, it_tech: wb2PillarHits.it_tech, hr: wb2PillarHits.hr, total: wb2Count,
        });

        // ── Fallback: search by company name if domain search yielded nothing ──
        // Skip if the breaker tripped — same account, same problem.
        if (apolloCount === 0 && job.company_name && !Apollo.isCreditBreakerTripped()) {
            try {
                const people = await Apollo.searchPeopleByName({
                    companyName:  job.company_name,
                    personTitles: ALL_TITLES,
                    perPage:      100,
                    locations,
                    jobId:        job.id,
                    operation:    'people_search_by_name',
                });
                const named = people
                    .filter(p => !isSalesMarketing(p.title))
                    .map(p => Apollo.normaliseApolloContact(p, job.id, null, this._guessType(p.title), 'apollo'));
                contacts.push(...named);
                apolloCount = named.length;
                if (named.length > 0) {
                    apolloError   = null;    // fallback recovered
                    apolloErrKind = null;
                    logger.debug('Name fallback found people', { count: named.length });
                }
            } catch (err) {
                if (err instanceof Apollo.ApolloCreditError) {
                    apolloError   = `Apollo: insufficient credits — top up your Apollo account. Provider said: "${err.providerMsg || err.message}"`;
                    apolloErrKind = 'apollo_no_credits';
                } else if (!apolloError) {
                    apolloError   = `Apollo (name fallback): ${err.message}`;
                    apolloErrKind = err.status === 401 || err.status === 403 ? 'auth' : 'provider_error';
                }
                logger.warn('Apollo name-based search failed', { error: err.message, company: job.company_name, status: err.status });
            }
        }

        // ── LinkedIn URL validity gate ─────────────────────────────────────
        // Drop contacts whose LinkedIn URL is fabricated (sequential digits) or
        // 404. Contacts WITHOUT a LinkedIn URL pass through (we can email them).
        // Static check is always on; live HEAD check is on unless LINKEDIN_LIVE_CHECK=false.
        const LinkedInUrlValidator = require('../../services/LinkedInUrlValidator');
        const { kept: validatedContacts, dropped: invalidLi } = await LinkedInUrlValidator.filterValid(contacts);
        if (invalidLi.length) {
            logger.info(`Dropped ${invalidLi.length} contact(s) with invalid LinkedIn URLs`, {
                job_id: job.id,
                samples: invalidLi.slice(0, 3).map(d => ({ name: d.contact.full_name, url: d.contact.linkedin_url, reason: d.reason })),
            });
        }

        // ── Dedup and save ────────────────────────────────────────────────────
        const deduped  = this._dedup(validatedContacts);
        let savedCount = 0;
        for (const c of deduped) {
            try {
                await this.db.insertContact({ ...c, job_id: job.id, company_url: job.company_url });
                savedCount++;
            } catch (err) {
                logger.warn('Contact insert failed', { error: err.message, name: c.full_name });
            }
        }

        logger.info('Stage 4 — people found summary', {
            job_id: job.id,
            crm: crmCount,
            apollo_harvest: harvestCount,
            apollo_paid_total: apolloCount,
            apollo_pillars: apolloPillarHits,
            wb2_total: wb2Count,
            wb2_pillars: wb2PillarHits,
            saved_after_dedup: savedCount,
        });

        // ── Emit cell states ──────────────────────────────────────────────────
        const total = deduped.length;
        try {
            const apolloStr = String(apolloCount);
            const totalStr  = String(total);

            // Apollo cell: the value combines harvested + paid-search results so a
            // credit-out account still shows non-zero when the harvest succeeded.
            // We only flag `error` state when the PAID search failed AND harvest
            // also returned nothing — otherwise the user gets actionable contacts.
            const combinedApollo = apolloCount + harvestCount;
            const combinedStr    = String(combinedApollo);

            if (apolloError && combinedApollo === 0) {
                await setCellState(job.id, 'stage4_apollo', 'error', {
                    value:     '0',
                    errorMsg:  apolloError,
                    errorKind: apolloErrKind,
                });
                emitCellState(job.id, 'stage4_apollo', 'error', {
                    value:      '0',
                    error_msg:  apolloError,
                    error_kind: apolloErrKind,
                });
            } else {
                await setCellState(job.id, 'stage4_apollo', combinedApollo > 0 ? 'success' : 'success_empty', { value: combinedStr });
                emitCellState(job.id, 'stage4_apollo', combinedApollo > 0 ? 'success' : 'success_empty', { value: combinedStr });
            }

            await setCellState(job.id, 'stage4_linkedin', crmCount > 0 ? 'success' : 'success_empty', { value: String(crmCount) });
            emitCellState(job.id, 'stage4_linkedin', crmCount > 0 ? 'success' : 'success_empty', { value: String(crmCount) });
            await setCellState(job.id, 'stage4_people_total', total > 0 ? 'success' : 'success_empty', { value: totalStr });
            emitCellState(job.id, 'stage4_people_total', total > 0 ? 'success' : 'success_empty', { value: totalStr });
        } catch (_) {}

        // Build a human message that calls out every source
        let message = `Found ${total} contacts — CRM:${crmCount}, Apollo-harvest:${harvestCount} (free), Apollo-paid:${apolloCount} (HR:${apolloPillarHits.hr}/CEO:${apolloPillarHits.ceo}/Tech-SAP:${apolloPillarHits.tech_sap}), WB2 AI:${wb2Count} (CEO:${wb2PillarHits.ceo_owners}/Tech:${wb2PillarHits.it_tech}/HR:${wb2PillarHits.hr}) — ${savedCount} saved after dedup`;
        if (apolloError && (apolloCount + harvestCount) === 0 && wb2Count === 0) {
            message += ` — ${apolloError}`;
        }

        return {
            rejected: false,
            message,
            summary:  {
                crm:            crmCount,
                apollo_harvest: harvestCount,
                apollo_paid:    apolloCount,
                saved:          savedCount,
                total,
                apollo_error:   apolloError,
            },
            // Only persist columns that actually exist on lpf_jobs. The
            // harvest/paid split is reported via summary + logData + cell value,
            // so we don't need extra DB columns for it.
            fields: {
                apollo_people_found: apolloCount + harvestCount,
                li_people_found:     crmCount,
                total_people_found:  total,
            },
            logData: {
                crm:             crmCount,
                apollo_harvest:  harvestCount,
                apollo_paid:     apolloCount,
                saved:           savedCount,
                apollo_error:    apolloError,
                apollo_err_kind: apolloErrKind,
            },
        };
    }

    /**
     * Pull existing RecruiterFlow contacts for the job's company. We use the
     * rf_client_id Stage 2 captured if available; otherwise we look the company
     * up by name first. Contacts come back with emails the operator already
     * curated, so we get usable outreach data without spending an Apollo credit.
     *
     * Returns an array of normalised contact rows ready for db.insertContact().
     */
    async _harvestCrmContacts(job) {
        if (!process.env.RECRUITERFLOW_API_KEY) return [];
        try {
            const RF = require('../../services/RecruiterFlowService');
            let clientId = job.rf_client_id;

            // If Stage 2 didn't persist an id, try a lookup now
            if (!clientId && job.company_name) {
                const r = await RF.lookupCompanyByName(job.company_name);
                if (r?.found) clientId = r.clientId;
            }
            if (!clientId && job.company_linkedin_url) {
                const r = await RF.lookupCompanyByLinkedin(job.company_linkedin_url);
                if (r?.found) clientId = r.clientId;
            }
            if (!clientId) return [];

            const rfContacts = await RF.listCompanyContacts(clientId, { limit: 50 });
            if (!rfContacts.length) return [];

            // Filter out sales/marketing roles client-side (same gate Apollo uses)
            return rfContacts
                .filter(c => !isSalesMarketing(c.title || c.position))
                .map(c => this._normaliseRfContact(c, job));
        } catch (err) {
            logger.warn('CRM contact harvest failed', { error: err.message });
            return [];
        }
    }

    /**
     * Convert an RF contact row into the pipeline's contact shape.
     */
    _normaliseRfContact(c, job) {
        const email = Array.isArray(c.email) && c.email.length
            ? (c.email.find(e => e.is_primary === 1 || e.is_primary === true)?.email || c.email[0]?.email)
            : c.email || c.work_email || null;
        const linkedinUrl = c.linkedin_profile || c.linkedin_url || c.linkedin || null;
        const firstName = c.first_name || c.firstName || (c.full_name || c.name || '').split(' ')[0] || null;
        const lastName  = c.last_name  || c.lastName  || (c.full_name || c.name || '').split(' ').slice(1).join(' ') || null;

        return {
            job_id:              job.id,
            company_url:         job.company_url,
            first_name:          firstName,
            last_name:           lastName,
            full_name:           c.full_name || c.name || [firstName, lastName].filter(Boolean).join(' '),
            email:               email,
            email_validated:     !!email,
            email_source:        email ? 'recruiterflow_crm' : null,
            linkedin_url:        linkedinUrl,
            linkedin_url_merged: linkedinUrl,
            person_linkedin_url: linkedinUrl,
            li_merged:           linkedinUrl,
            title:               c.title || c.position || null,
            city:                c.location?.city    || c.address?.city    || null,
            country:             c.location?.country || c.address?.country || null,
            person_source:       'recruiterflow_crm',
            source:              'crm',
            contact_type:        this._guessType(c.title || c.position),
            is_dach:             null,           // Stage 5 confirms via LinkedIn
            raw_data:            { rf_contact_id: c.id, rf_client_id: c.client_company_id || c.client_id },
        };
    }

    _guessType(title) {
        if (!title) return 'hr';
        const t = title.toLowerCase();
        if (['ceo','geschäftsführer','founder','coo','president','owner','managing'].some(k => t.includes(k))) return 'ceo';
        if (['cto','head of it','it director','technology','engineering','sap','erp','software','cloud'].some(k => t.includes(k))) return 'tech';
        return 'hr';
    }

    _dedup(contacts) {
        const seen = new Set();
        return contacts.filter(c => {
            const key = c.linkedin_url || c.email || c.full_name;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
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

function countryToLocations(country) {
    if (!country) return ['Germany', 'Austria', 'Switzerland', 'Deutschland', 'Österreich', 'Schweiz'];
    const c = country.toLowerCase();
    if (c.includes('germany') || c.includes('deutschland') || c === 'de') return ['Germany', 'Deutschland'];
    if (c.includes('austria') || c.includes('österreich')  || c === 'at') return ['Austria', 'Österreich'];
    if (c.includes('switzerland') || c.includes('schweiz') || c.includes('suisse') || c === 'ch') return ['Switzerland', 'Schweiz'];
    return ['Germany', 'Austria', 'Switzerland', 'Deutschland', 'Österreich', 'Schweiz'];
}

function isInLocations(contactCountry, locations) {
    if (!contactCountry) return true;
    const c = contactCountry.toLowerCase();
    return locations.some(l => c.includes(l.toLowerCase()));
}

module.exports = Stage04_FindPeople;
