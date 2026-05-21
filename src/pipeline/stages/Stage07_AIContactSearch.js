/**
 * Stage 7 — AI Contact Search
 *
 * Replicates WB2.1 (2b1. AI Prompts For Contact Search):
 *   Col 6  [SEARCH] ONLY CEO/Owners - DACH          (Claygent web research)
 *   Col 7  [ENSURE] Lead Verification (CEO/Owners)
 *   Col 9  Write To Table - 2b2 [CEO/Owners]
 *   Col 12 [SEARCH] IT & Tech Roles - DACH
 *   Col 14 [ENSURE] Lead Verification (IT/Tech)
 *   Col 17 Write to Table - 2b2 (Tech/IT)
 *   Col 19 [SEARCH] HR Roles - DACH
 *   Col 21 [ENSURE] Lead Verification (HR)
 *   Col 24 Write to Table - 2b2 (HR)
 *
 * Uses GPT-4o mini with web search (via Serper for Google results context)
 * to replicate Claygent's web research capability.
 */
const { askJSON, askWithWebSearch }      = require('../../services/OpenAIService');
const { findEmail, findEmailByLinkedIn } = require('../../services/FindymailService');
const Findymail = { findEmail, findEmailByLinkedIn };
const Logger                         = require('../../Logger');
const axios                          = require('axios');
const { runCell }                    = require('../runCell');

const logger = new Logger('Stage07_AIContactSearch');

class Stage07_AIContactSearch {
    constructor(db) { this.db = db; }

    async run(job) {
        const companyName   = job.company_name || job.company_url;
        const companyDomain = job.company_domain || job.company_url;
        const companyLI     = job.company_linkedin_url;

        if (!companyName) {
            return { rejected: false, message: 'No company name — skipped AI search', fields: {} };
        }

        let summary;
        await runCell({
            jobId: job.id,
            colId: 'stage7_ai_search',
            fn: async () => {
                const [ceoLeads, techLeads, hrLeads] = await Promise.all([
                    this._searchCEO(companyName, companyDomain, companyLI, job.id),
                    this._searchITTech(companyName, companyDomain, companyLI, job.id),
                    this._searchHR(companyName, companyDomain, companyLI, job.id),
                ]);
                summary = { ceo: ceoLeads, tech: techLeads, hr: hrLeads, total: ceoLeads + techLeads + hrLeads };
                return String(summary.total);
            }
        });

        if (!summary) return { rejected: false, message: 'AI search failed — no result', fields: {} };

        return {
            rejected: false,
            message:  `AI search found ${summary.total} additional contacts`,
            summary:  { ceo: summary.ceo, tech: summary.tech, hr: summary.hr },
            logData:  { totalFound: summary.total },
        };
    }

    // ── CEO / Owners (verbatim WB2.1 Col 6 prompt) ───────────────────────────
    async _searchCEO(companyName, companyDomain, companyLI, jobId) {
        const systemPrompt = `AI Lead Generation Agent Instructions:
Identify and evaluate at least five leads at {{company_name}} who hold senior technology-related positions. Focus specifically on C-suite executives, Presidents, Vice Presidents, Directors, and other senior leaders with a technology focus in their title. Exclude any Manager-level or lower titles, and avoid roles related to Sales, Marketing, UI/UX, or other non-technology departments.

DACH Region Only: Leads must be based in Germany, Austria, or Switzerland.
Focus Area: Strictly target senior-level roles, specifically CEOs, Owners, founders and other C-level roles, including Tech-specific C-level positions (e.g., CTO, VP of Engineering).
Language Variations: For CEO roles, include variations such as Geschäftsführer, Vorstandsvorsitzender. For Director roles: Direktor, Leiter, Abtungsleiter.

Output valid JSON ONLY:
{
  "leads": [
    {
      "first_name": "",
      "last_name": "",
      "title": "",
      "linkedin_url": "",
      "city": "",
      "country": ""
    }
  ]
}
If no leads found, return { "leads": [] }`;

        return this._runAISearch(
            systemPrompt,
            `Company: ${companyName}\nWebsite: ${companyDomain || '—'}\nLinkedIn: ${companyLI || '—'}`,
            jobId, companyName, companyDomain, 'ceo', 'ai_search'
        );
    }

    // ── IT & Tech Roles (WB2.1 Col 12) ───────────────────────────────────────
    async _searchITTech(companyName, companyDomain, companyLI, jobId) {
        const systemPrompt = `AI Lead Generation Agent — IT & Technology Roles at DACH companies.
Identify senior IT and Engineering leaders at the given company.
Target: CTO, VP Engineering, Head of IT, Head of Technology, IT Director, Head of Software Engineering, Head of Application Development, Head of ERP/SAP.
DACH region only (Germany, Austria, Switzerland). Both English and German titles.
German equivalents: IT-Leiter, Leiter Informationstechnologie, Leiter Softwareentwicklung, Leiter Anwendungsentwicklung.

Output valid JSON ONLY:
{
  "leads": [
    { "first_name": "", "last_name": "", "title": "", "linkedin_url": "", "city": "", "country": "" }
  ]
}`;

        return this._runAISearch(
            systemPrompt,
            `Company: ${companyName}\nWebsite: ${companyDomain || '—'}\nLinkedIn: ${companyLI || '—'}`,
            jobId, companyName, companyDomain, 'tech', 'ai_search'
        );
    }

    // ── HR Roles (WB2.1 Col 19) ───────────────────────────────────────────────
    async _searchHR(companyName, companyDomain, companyLI, jobId) {
        const systemPrompt = `AI Lead Generation Agent — HR and People Operations Roles at DACH companies.
Identify senior HR and People leaders at the given company.
Target: CHRO, Chief People Officer, VP HR, VP People, HR Director, Head of HR, Head of People, Head of Talent Acquisition, Head of Recruiting.
DACH region only (Germany, Austria, Switzerland). Both English and German titles.
German equivalents: Personalleiter, HR-Leiter, Leiter Personalwesen, Leiter Recruiting, Leiter Talent Acquisition.

Output valid JSON ONLY:
{
  "leads": [
    { "first_name": "", "last_name": "", "title": "", "linkedin_url": "", "city": "", "country": "" }
  ]
}`;

        return this._runAISearch(
            systemPrompt,
            `Company: ${companyName}\nWebsite: ${companyDomain || '—'}\nLinkedIn: ${companyLI || '—'}`,
            jobId, companyName, companyDomain, 'hr', 'ai_search'
        );
    }

    async _runAISearch(systemPrompt, userPrompt, jobId, companyName, companyDomain, contactType, source) {
        try {
            // Add web search context via Serper if key available
            let enrichedPrompt = userPrompt;
            if (process.env.SERPER_API_KEY) {
                const searchResults = await this._serperSearch(`${companyName} ${contactType} DACH`);
                if (searchResults) {
                    enrichedPrompt += `\n\nWeb search context:\n${searchResults}`;
                }
            }

            const raw = await askWithWebSearch(systemPrompt, enrichedPrompt,
                { jobId, operation: `stage7_ai_search_${contactType}` });

            // Parse JSON out of the response
            let parsed;
            try {
                const match = raw.match(/\{[\s\S]*\}/);
                parsed = match ? JSON.parse(match[0]) : { leads: [] };
            } catch (_) {
                parsed = { leads: [] };
            }

            const leads = parsed.leads || [];

            // ── LinkedIn URL validity gate ────────────────────────────────────
            // Same shared validator that Stage 4 uses. Catches fabricated URLs
            // (sequential-digit patterns) AND 404s via a HEAD probe. Leads
            // without a LinkedIn URL pass through (we can still email them
            // through name+domain Findymail).
            const LinkedInUrlValidator = require('../../services/LinkedInUrlValidator');
            const presieved = [];
            let droppedByValidator = 0;
            for (const l of leads) {
                if (!l.linkedin_url) { presieved.push(l); continue; }
                const v = await LinkedInUrlValidator.validate(l.linkedin_url);
                if (v.ok) {
                    presieved.push(l);
                } else {
                    droppedByValidator++;
                    logger.debug('Stage 7 dropped lead with invalid LinkedIn URL', {
                        url: l.linkedin_url, reason: v.reason, status: v.status, name: `${l.first_name||''} ${l.last_name||''}`.trim(),
                    });
                }
            }
            if (droppedByValidator) {
                logger.warn(`Stage 7 dropped ${droppedByValidator} lead(s) with invalid LinkedIn URLs (404/fabricated/wrong shape)`, { companyName });
            }

            // De-duplicate by (first_name + last_name) — same person sometimes appears twice
            const seenNames = new Set();
            const deduped = presieved.filter(l => {
                const k = `${(l.first_name||'').toLowerCase()} ${(l.last_name||'').toLowerCase()}`.trim();
                if (!k || seenNames.has(k)) return false;
                seenNames.add(k);
                return true;
            });

            // ── Verify each lead (WB2.1 [ENSURE] columns) ─────────────────────
            const verified = await this._verifyLeads(deduped, companyName, jobId);

            // ── Save verified leads ────────────────────────────────────────────
            let saved = 0;
            for (const lead of verified) {
                if (!lead.first_name && !lead.linkedin_url) continue;

                // Gender + salutation
                let gender = 'unknown', salutation = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
                if (lead.first_name) {
                    const gen  = await this._identifyGender(lead.first_name, lead.last_name, jobId);
                    gender     = gen.gender;
                    salutation = gen.salutation;
                }

                // Email via Findymail — LinkedIn URL first (pre-verified), then name+domain
                let email = null, emailValidated = false, emailSource = null;
                if (lead.linkedin_url) {
                    const found = await this._safeCall(() => Findymail.findEmailByLinkedIn(lead.linkedin_url));
                    if (found?.email) { email = found.email; emailValidated = true; emailSource = 'findymail'; }
                }
                if (!email && lead.first_name && lead.last_name && companyDomain) {
                    const found = await this._safeCall(() =>
                        Findymail.findEmail(lead.first_name, lead.last_name, companyDomain));
                    if (found?.email) { email = found.email; emailValidated = true; emailSource = 'findymail'; }
                }

                await this.db.insertContact({
                    job_id:              jobId,
                    company_url:         null,
                    company_name:        companyName,
                    first_name:          lead.first_name,
                    last_name:           lead.last_name,
                    full_name:           [lead.first_name, lead.last_name].filter(Boolean).join(' '),
                    email,
                    email_validated:     emailValidated,
                    email_source:        emailSource,
                    linkedin_url:        lead.linkedin_url,
                    linkedin_url_merged: lead.linkedin_url,
                    person_linkedin_url: lead.linkedin_url,
                    li_merged:           lead.linkedin_url,
                    title:               lead.title,
                    city:                lead.city,
                    country:             lead.country,
                    is_dach:             isDACH(lead.country),
                    person_source:       'AI Web Search',
                    gender,
                    salutation,
                    source,
                    contact_type:        contactType,
                    raw_data:            lead,
                }).catch(() => {});
                saved++;
            }

            return saved;
        } catch (err) {
            logger.warn(`AI search (${contactType}) failed`, { error: err.message });
            return 0;
        }
    }

    // WB2.1 [ENSURE] — verify the AI found real current employees
    async _verifyLeads(leads, companyName, jobId = null) {
        if (leads.length === 0) return [];
        try {
            const result = await askJSON(
                'Output ONLY valid JSON. Be ruthless about removing fabrications — if you have ANY doubt that a name+title+url is real, drop it.',
                `You are verifying AI-generated leads for ${companyName}.

For each lead, decide whether they are likely a REAL current employee:
• Real-looking LinkedIn URL (no placeholder digit sequences like "-12345678" or "-23456789")
• Same person not present twice with different titles
• A plausible title that matches the company's industry
• No fake-looking patterns (sequential names, identical surnames, copy-paste templates)

If a lead fails ANY check, DROP it. Better to return 0 leads than fabricated ones.

Input leads:
${JSON.stringify(leads, null, 2)}

Return: { "verified_leads": [ ...same structure, only keep valid ones... ] }`,
                'gpt-4o-mini',
                { jobId, operation: 'stage7_lead_verify' }
            );
            return result.verified_leads || leads;
        } catch (_) {
            return leads;
        }
    }

    async _serperSearch(query) {
        try {
            const res = await axios.post('https://google.serper.dev/search', {
                q:  query,
                gl: 'de',
                hl: 'de',
                num: 5,
            }, {
                headers: {
                    'X-API-KEY':    process.env.SERPER_API_KEY,
                    'Content-Type': 'application/json',
                },
            });
            const results = res.data?.organic || [];
            return results.map(r => `${r.title}: ${r.snippet}`).join('\n');
        } catch (_) {
            return null;
        }
    }

    async _safeCall(fn) {
        try { return await fn(); } catch (_) { return null; }
    }

    async _identifyGender(firstName, lastName, jobId = null) {
        try {
            const result = await askJSON(
                'Output ONLY valid JSON.',
                `German gender for: first="${firstName}", last="${lastName || ''}". { "gender": "male"|"female"|"unknown", "salutation": "Herr [Last]"|"Frau [Last]"|"[First] [Last]" }`,
                'gpt-4o-mini',
                { jobId, operation: 'stage7_gender_id' }
            );
            return { gender: result.gender || 'unknown', salutation: result.salutation || `${firstName} ${lastName || ''}`.trim() };
        } catch (_) {
            return { gender: 'unknown', salutation: `${firstName} ${lastName || ''}`.trim() };
        }
    }
}

function isDACH(country) {
    if (!country) return false;
    const c = country.toLowerCase();
    return c.includes('germany') || c.includes('austria') || c.includes('switzerland');
}

module.exports = Stage07_AIContactSearch;
