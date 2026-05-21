/**
 * Stage 2 — Company Enrichment
 *
 * Sources (Proxycurl removed — no API key):
 *   1. Apollo organizations/enrich — primary: domain → name, description, industry, employees, HQ
 *   2. Apify website-content-crawler — scrapes company homepage for extra context
 *   3. GPT — extracts/merges DACH offices + supplements missing fields
 *   4. Clearbit — fallback domain lookup if domain still unknown
 *   5. GPT DACH employee estimate
 */
const Apollo  = require('../../services/ApolloService');
const Apify   = require('../../services/ApifyService');
const { askJSON, askWithWebSearch } = require('../../services/OpenAIService');
const Connections = require('../../services/ConnectionService');
const GSheet     = require('../../services/GoogleSheetsServiceV2');
const Logger  = require('../../Logger');
const axios   = require('axios');
const { setCellState, emitCellState } = require('../runCell');

const logger = new Logger('Stage02_CompanyEnrich');

class Stage02_CompanyEnrich {
    constructor(db) { this.db = db; }

    async run(job) {
        // ── Company cache check (with 30-day cooldown) ───────────────────────
        // Operator rule: if a company posts another SAP job after 30 days, we
        // re-enrich (don't reuse the cached row). Cache HIT requires:
        //   • cached.company_domain present
        //   • cached.updated_at (or created_at) within COMPANY_COOLDOWN_DAYS
        const { COMPANY_TTL_DAYS } = require('../../services/RetentionService');
        const cached = job.company_url
            ? await this.db.getCompanyByUrl(job.company_url)
            : null;

        // lpf_companies uses `last_seen` (refreshed on every upsert) — not updated_at.
        const cacheTs = cached ? new Date(cached.last_seen || cached.created_at || 0).getTime() : 0;
        const cacheAgeDays = cacheTs ? (Date.now() - cacheTs) / 86_400_000 : Infinity;
        const cacheIsFresh = cached?.company_domain && cacheAgeDays < COMPANY_TTL_DAYS;

        if (cacheIsFresh) {
            logger.debug('Company cache hit (within cooldown)', {
                company: job.company_url, cache_age_days: cacheAgeDays.toFixed(1),
            });
            this._emitCells(job.id, cached.company_domain, cached.company_industry, cached.employee_count);
            return {
                rejected: false,
                message:  `Company enriched from cache: ${cached.company_domain}`,
                fields: {
                    company_domain:         cached.company_domain,
                    company_description:    cached.company_description,
                    company_employee_count: cached.employee_count,
                    company_dach_employees: cached.dach_employees,
                    company_hq_city:        cached.hq_city,
                    company_hq_country:     cached.hq_country,
                    company_industry:       cached.company_industry,
                },
            };
        } else if (cached?.company_domain) {
            // Cache row exists but is past the cooldown — log it, then fall
            // through to re-enrich. Stage 2's upsertCompany at the bottom
            // updates the row in place with fresh data + bumped updated_at.
            logger.info(`Company cache STALE (${cacheAgeDays.toFixed(1)}d > ${COMPANY_TTL_DAYS}d cooldown) — re-enriching`, {
                job_id: job.id, company: job.company_url,
            });
        }

        // ── 0. Optional Google Sheet lookup (Connections tab → company_enrich) ──
        // If the operator has wired a sheet, try it first. The row may be hand-curated
        // text — we ask GPT to parse it into our schema so downstream stages get the
        // same shape as a fresh Apollo enrichment.
        const sheetEnriched = await this._tryCompanySheetLookup(job);
        if (sheetEnriched?.company_domain) {
            await this.db.upsertCompany({ ...sheetEnriched, company_url: job.company_url || sheetEnriched.company_url });
            this._emitCells(job.id, sheetEnriched.company_domain, sheetEnriched.company_industry, sheetEnriched.employee_count);
            return {
                rejected: false,
                message:  `Company enriched from Google Sheet: ${sheetEnriched.company_domain}`,
                summary:  { source: 'gsheet', domain: sheetEnriched.company_domain },
                fields: {
                    company_domain:         sheetEnriched.company_domain,
                    company_description:    sheetEnriched.company_description,
                    company_employee_count: sheetEnriched.employee_count,
                    company_dach_employees: sheetEnriched.dach_employees,
                    company_hq_city:        sheetEnriched.hq_city,
                    company_hq_country:     sheetEnriched.hq_country,
                    company_industry:       sheetEnriched.company_industry,
                },
                logData: { source: 'gsheet' },
            };
        }

        let enriched = null;

        // ── 0. CRM cache — RecruiterFlow already has this company? ────────────
        // Save 1 Proxycurl + 1 Apollo credit + 1 Apify CU per pipeline run if RF
        // already knows the company. Lookup by name AND by LinkedIn URL.
        if (process.env.RECRUITERFLOW_API_KEY) {
            const crmHit = await this._tryCRMCompanyLookup(job);
            if (crmHit) {
                enriched = crmHit;
                logger.info('CRM company HIT — skipping Proxycurl/Apify', {
                    job_id: job.id, rf_client_id: crmHit.rf_client_id, domain: enriched.company_domain,
                });
            }
        }

        // ── 1. Apollo organization enrichment (primary, if not in CRM) ────────
        const domain = enriched?.company_domain || extractDomain(job.company_url) || extractDomain(job.company_linkedin_url);
        if (!enriched && domain) {
            try {
                const org = await Apollo.enrichCompany(domain);
                if (org) {
                    enriched = Apollo.normaliseApolloCompany(org, job.company_url);
                    logger.debug('Apollo company enriched', { domain: enriched.company_domain });
                }
            } catch (err) {
                logger.warn('Apollo company enrichment failed', { error: err.message });
            }
        }

        // ── 2. Clearbit domain fallback ───────────────────────────────────────
        if (!enriched?.company_domain && job.company_name) {
            try {
                const d = await this._clearbitDomain(job.company_name);
                if (d) {
                    enriched = enriched || { company_url: job.company_url };
                    enriched.company_domain = d;
                }
            } catch (err) {
                logger.warn('Clearbit fallback failed', { error: err.message });
            }
        }

        // ── 3. Apify — scrape company website for extra context ───────────────
        const websiteUrl = enriched?.company_domain
            ? `https://${enriched.company_domain}`
            : (job.company_url?.startsWith('http') ? job.company_url : null);

        let apifyText = null;
        if (websiteUrl) {
            try {
                apifyText = await Apify.scrapeCompanyWebsite(websiteUrl);
                if (apifyText) logger.debug('Apify scraped', { url: websiteUrl, chars: apifyText.length });
            } catch (err) {
                logger.warn('Apify scrape failed (non-critical)', { error: err.message });
            }
        }

        // Emit stage2_apify cell state
        try {
            const apifyState = apifyText ? 'success' : 'success_empty';
            const apifyVal   = apifyText ? `${apifyText.length} chars` : null;
            await setCellState(job.id, 'stage2_apify', apifyState, { value: apifyVal }).catch(() => {});
            emitCellState(job.id, 'stage2_apify', apifyState, { value: apifyVal });
        } catch (_) {}

        // ── 4. GPT — supplement from Apify content ────────────────────────────
        if (apifyText) {
            try {
                const gpt = await this._extractFromWebsite(apifyText, job.company_name, enriched, job.id);
                if (gpt) {
                    enriched = enriched || { company_url: job.company_url };
                    if (!enriched.company_description && gpt.description)  enriched.company_description = gpt.description;
                    if (!enriched.company_industry    && gpt.industry)     enriched.company_industry    = gpt.industry;
                    if (!enriched.hq_city             && gpt.hq_city)      enriched.hq_city             = gpt.hq_city;
                    if (!enriched.hq_country          && gpt.hq_country)   enriched.hq_country          = gpt.hq_country;
                    if (!enriched.employee_count      && gpt.employee_estimate) enriched.employee_count = gpt.employee_estimate;
                    if (gpt.dach_offices?.length) enriched.dach_offices = gpt.dach_offices.join(', ');
                }
            } catch (err) {
                logger.warn('GPT website extraction failed', { error: err.message });
            }
        }

        // ── 4b. LinkedIn company info prompt (web search) — fill missing fields ──
        const liUrl = job.company_linkedin_url;
        const liDomain = enriched?.company_domain || domain;
        const needsLinkedInEnrich = liUrl && enriched && (
            !enriched.company_description || !enriched.company_industry ||
            !enriched.hq_city || !enriched.hq_country
        );
        if (needsLinkedInEnrich) {
            try {
                const li = await this._enrichFromLinkedIn(liUrl, liDomain, job.id);
                if (li) {
                    if (!enriched.company_description && li['Company Description']) enriched.company_description = li['Company Description'];
                    if (!enriched.company_industry    && li['Industry'])            enriched.company_industry    = li['Industry'];
                    if (!enriched.hq_city             && li['Company City'])        enriched.hq_city             = li['Company City'];
                    if (!enriched.hq_country          && li['Company Country'])     enriched.hq_country          = li['Company Country'];
                    if (!enriched.company_domain      && li['Website'])             enriched.company_domain      = extractDomain(li['Website']);
                    logger.debug('LinkedIn company info enriched', { name: li['Company Name'] });
                }
            } catch (err) {
                logger.warn('LinkedIn company info prompt failed (non-critical)', { error: err.message });
            }
        }

        // ── 5. GPT DACH employee estimate ─────────────────────────────────────
        if (enriched && !enriched.dach_employees && enriched.employee_count) {
            enriched.dach_employees = await this._estimateDACHEmployees(
                job.company_name, enriched.employee_count, enriched.hq_country, enriched.dach_offices, job.id
            );
        }

        // ── 6. LAST-DITCH: ask GPT for the real domain ────────────────────────
        // If every previous step failed to find a domain but we DO have a
        // company name + country (the operator always provides these), ask
        // GPT to identify the canonical company domain. This handles the case
        // where the webhook sent a synthetic test URL but the company itself
        // is well-known (e.g. "BMW Group" + "Germany" → "bmw.de").
        //
        // Hard rule from operator: NO BLIND GUESSING. We only use the model's
        // answer if it returns a domain string; if it returns blank, the job
        // is rejected here and never reaches Stages 3-8.
        if ((!enriched || !enriched.company_domain) && job.company_name && job.country) {
            const aiDomain = await this._findDomainViaAI(job.company_name, job.country, job.id);
            if (aiDomain) {
                logger.info(`Stage 2: AI resolved domain "${aiDomain}" for ${job.company_name} (${job.country})`, { job_id: job.id });
                enriched = enriched || { company_url: job.company_url };
                enriched.company_domain = aiDomain;
                enriched._domain_source = 'gpt_lookup';
            }
        }

        // ── Hard reject if STILL no domain — operator rule: don't process further ──
        if (!enriched || !enriched.company_domain) {
            const reason = `No company domain resolvable for "${job.company_name || '(unknown)'}" in ${job.country || '(unknown country)'}. ` +
                'Tried: webhook payload, RecruiterFlow CRM, Apollo enrichment, Apify scrape, LinkedIn enrichment, GPT domain lookup. ' +
                'Job cannot be processed without a real domain (needed for email lookups + Instantly sends).';
            logger.warn(`Stage 2: rejecting job ${job.id} — ${reason}`);
            try {
                await setCellState(job.id, 'stage2_enrich', 'error', { errorMsg: 'no domain', errorKind: 'no_domain' });
                emitCellState(job.id, 'stage2_enrich', 'error', { error_msg: 'no domain', error_kind: 'no_domain' });
            } catch (_) {}
            return { rejected: true, reason };
        }

        // ── Persist to companies cache ─────────────────────────────────────────
        await this.db.upsertCompany({ ...enriched, company_url: job.company_url || enriched.company_url });

        this._emitCells(job.id, enriched.company_domain, enriched.company_industry, enriched.employee_count);

        // ── Save freshly-enriched company back to the Google Sheet (if configured) ──
        this._writeCompanyToSheet(job, enriched).catch(err =>
            logger.warn('Company sheet write-back failed', { error: err.message })
        );

        const source = enriched.rf_client_id ? `crm_${enriched._crm_via}` : 'apollo+apify+gpt';
        return {
            rejected: false,
            message:  `Company enriched: ${enriched.company_domain} (source: ${source})`,
            summary:  { domain: enriched.company_domain, employees: enriched.employee_count, city: enriched.hq_city, source },
            fields: {
                company_domain:         enriched.company_domain,
                company_description:    enriched.company_description,
                company_employee_count: enriched.employee_count,
                company_dach_employees: enriched.dach_employees,
                company_hq_city:        enriched.hq_city,
                company_hq_country:     enriched.hq_country,
                company_industry:       enriched.company_industry,
                // Persist the RF client id so Stage 4 + the final CRM push can reuse it
                // instead of looking up the company again.
                ...(enriched.rf_client_id ? { rf_client_id: enriched.rf_client_id } : {}),
            },
            logData: { source, domain: enriched.company_domain, rf_client_id: enriched.rf_client_id || null },
        };
    }

    /**
     * Look the company up in RecruiterFlow CRM. If we already have a client row
     * with this name or LinkedIn URL, pull its enrichment data (industry, HQ
     * location, headcount custom_fields) and use that instead of paying for a
     * fresh Proxycurl + Apify + Apollo round-trip.
     *
     * Returns the enriched-shape object on hit, null on miss.
     */
    async _tryCRMCompanyLookup(job) {
        const RF = require('../../services/RecruiterFlowService');
        try {
            // Lookup by name first (cheapest), then LinkedIn URL
            let hit = null;
            if (job.company_name) {
                const r = await RF.lookupCompanyByName(job.company_name);
                if (r?.found) hit = { clientId: r.clientId, via: 'name' };
            }
            if (!hit && job.company_linkedin_url) {
                const r = await RF.lookupCompanyByLinkedin(job.company_linkedin_url);
                if (r?.found) hit = { clientId: r.clientId, via: 'linkedin' };
            }
            if (!hit) return null;

            // Pull full company record so we get industry, HQ, headcount
            const company = await RF.getCompany(hit.clientId);
            if (!company) return null;

            // Map RF shape → our internal enriched shape
            // RF custom_fields[0].value (id=2) holds the employee count by convention
            const empField = (company.custom_fields || []).find(f => f.id === 2 || (f.name || '').toLowerCase().includes('employee'));
            return {
                company_url:         job.company_url || company.website || '',
                company_domain:      company.domain  || extractDomain(company.website) || extractDomain(job.company_url),
                company_description: company.description || '',
                company_industry:    company.industry || (company.industries?.[0] || ''),
                employee_count:      empField?.value ? Number(empField.value) || null : null,
                dach_employees:      null,
                hq_city:             company.location?.city    || company.address?.city    || '',
                hq_country:          company.location?.country || company.address?.country || '',
                rf_client_id:        hit.clientId,
                _crm_via:            hit.via,
            };
        } catch (err) {
            logger.warn('CRM company lookup failed (non-fatal)', { error: err.message });
            return null;
        }
    }

    /**
     * Look the company up in the operator-configured Google Sheet (purpose='company_enrich').
     *
     * The operator picks two things in the Connections drawer:
     *   • lookup_pipeline_field  — which job-row field provides the lookup value
     *                              (e.g. 'company_domain' → job.company_domain)
     *   • lookup_sheet_column    — which sheet header to match against
     *
     * If lookup_pipeline_field isn't set we fall back to the legacy multi-candidate
     * sweep (domain → URL → name) so older connections keep working.
     *
     * If found: row is fed through GPT to normalise into our schema (the cells may
     * contain free-form notes — the LLM extracts the structured fields we need).
     */
    async _tryCompanySheetLookup(job) {
        const conn = await Connections.getDefault('google_sheet', 'company_enrich').catch(() => null);
        if (!conn) return null;

        // Build the list of (pipeline_field → value) pairs to try, in priority order
        let candidates;
        const explicitField = conn.config?.lookup_pipeline_field;
        if (explicitField) {
            // Operator picked one field explicitly — honour it (single try)
            const val = _readJobField(job, explicitField);
            if (!val) return null;
            candidates = [{ key: explicitField, val }];
        } else {
            // Back-compat: legacy single lookup_column path → try domain/URL/name
            candidates = [
                { key: 'company_domain', val: extractDomain(job.company_url) || extractDomain(job.company_linkedin_url) },
                { key: 'company_url',    val: job.company_url },
                { key: 'company_name',   val: job.company_name },
            ].filter(c => c.val);
        }

        for (const { key, val } of candidates) {
            try {
                const hit = await GSheet.lookupRow(conn.config, val);
                if (hit?.found) {
                    logger.info('Company sheet HIT', { value: val, via: key, sheet: conn.name });
                    return await this._parseSheetRowWithGPT(hit.row, job);
                }
            } catch (err) {
                logger.warn('Company sheet lookup error', { error: err.message, value: val, via: key });
            }
        }
        return null;
    }

    /**
     * Pass a sheet row (which may be free-form text in some cells) through GPT
     * to normalise into the canonical Stage 2 output schema. This is what the
     * spec means by "output from this sheet have to be formatted using ai".
     */
    async _parseSheetRowWithGPT(row, job) {
        try {
            const parsed = await askJSON(
                'You extract structured company facts from a row of a hand-curated CSV. Output ONLY valid JSON. Empty string for unknown.',
                `Given this row's columns (header → value), output a normalised company record:
${JSON.stringify(row, null, 2)}

Schema:
{
  "company_domain":      "the cleanest domain (no protocol/www), or empty",
  "company_description": "1–2 sentence company description, or empty",
  "company_industry":    "industry label, or empty",
  "employee_count":      <integer headcount or null>,
  "dach_employees":      <integer DACH-only headcount or null>,
  "hq_city":             "HQ city or empty",
  "hq_country":          "full country name (e.g. 'Germany'), or empty"
}

Context (may not exist in the row):
- Company name: ${job.company_name || ''}
- Company URL:  ${job.company_url  || ''}`,
                'gpt-4o-mini',
                { jobId: job.id, operation: 'company_sheet_parse' }
            );
            return {
                company_url:         job.company_url,
                company_domain:      parsed.company_domain || extractDomain(job.company_url),
                company_description: parsed.company_description || '',
                company_industry:    parsed.company_industry    || '',
                employee_count:      parsed.employee_count      || null,
                dach_employees:      parsed.dach_employees      || null,
                hq_city:             parsed.hq_city             || '',
                hq_country:          parsed.hq_country          || '',
            };
        } catch (err) {
            logger.warn('GPT sheet-row parse failed', { error: err.message });
            return null;
        }
    }

    /**
     * After successful enrichment, append the row back to the company sheet so
     * the next pipeline run can hit the cache instead of paying for Apollo + Apify.
     * Uses the same column_mapping the operator set up for lookup.
     */
    async _writeCompanyToSheet(job, enriched) {
        const conn = await Connections.getDefault('google_sheet', 'company_enrich').catch(() => null);
        if (!conn) return;

        const record = {
            company_url:         job.company_url || '',
            company_name:        job.company_name || '',
            company_domain:      enriched.company_domain || '',
            company_description: enriched.company_description || '',
            company_industry:    enriched.company_industry || '',
            employee_count:      enriched.employee_count != null ? String(enriched.employee_count) : '',
            dach_employees:      enriched.dach_employees != null ? String(enriched.dach_employees) : '',
            hq_city:             enriched.hq_city || '',
            hq_country:          enriched.hq_country || '',
            company_linkedin_url: job.company_linkedin_url || '',
            enriched_at:         new Date().toISOString(),
        };

        // Upsert by the explicit pipeline_field (new) or legacy lookup_column.
        // This is the same key the lookup step uses — keeps insert/update symmetric.
        const lookupField = conn.config.lookup_pipeline_field || conn.config.lookup_column;
        const lookupVal = (lookupField && record[lookupField])
            || record.company_domain
            || record.company_url;
        await GSheet.upsertRow(conn.config, lookupVal, record);
        logger.info('Company written back to sheet', { sheet: conn.name, key: lookupVal, via: lookupField });
    }

    _emitCells(jobId, domain, industry, employees) {
        try {
            const enrichVal = domain || null;
            setCellState(jobId, 'stage2_enrich', enrichVal ? 'success' : 'success_empty', { value: enrichVal }).catch(() => {});
            emitCellState(jobId, 'stage2_enrich', enrichVal ? 'success' : 'success_empty', { value: enrichVal });

            const indVal = industry || null;
            setCellState(jobId, 'stage2_industry', indVal ? 'success' : 'success_empty', { value: indVal }).catch(() => {});
            emitCellState(jobId, 'stage2_industry', indVal ? 'success' : 'success_empty', { value: indVal });

            const empVal = employees != null ? String(employees) : null;
            setCellState(jobId, 'stage2_employees', empVal ? 'success' : 'success_empty', { value: empVal }).catch(() => {});
            emitCellState(jobId, 'stage2_employees', empVal ? 'success' : 'success_empty', { value: empVal });
        } catch (_) {}
    }

    async _extractFromWebsite(pageText, companyName, existing, jobId = null) {
        return await askJSON(
            'You extract structured company information from website text. Output ONLY valid JSON.',
            `Company: ${companyName || 'unknown'}
Known so far: ${JSON.stringify({ industry: existing?.company_industry, hq: existing?.hq_city, employees: existing?.employee_count })}

Website content (first 4000 chars):
${pageText.slice(0, 4000)}

Supplement only what is missing. Respond:
{
  "description": "1-2 sentence description or null",
  "industry": "industry or null",
  "hq_city": "city or null",
  "hq_country": "country or null",
  "dach_offices": ["city1"] or [],
  "employee_estimate": number or null
}`,
            'gpt-4o-mini',
            { jobId, operation: 'stage2_website_extract' }
        );
    }

    async _clearbitDomain(companyName) {
        if (!process.env.CLEARBIT_API_KEY) return null;
        const res = await axios.get('https://company.clearbit.com/v1/domains/find', {
            params:  { name: companyName },
            headers: { Authorization: `Basic ${Buffer.from(process.env.CLEARBIT_API_KEY + ':').toString('base64')}` },
        });
        return res.data?.domain || null;
    }

    /**
     * Use GPT web search to retrieve company info from LinkedIn company page.
     * Returns structured JSON matching the LinkedIn company info prompt spec.
     */
    async _enrichFromLinkedIn(linkedinUrl, domain, jobId = null) {
        const prompt = `Retrieve the following company details from LinkedIn, using the provided LinkedIn URL and Company Domain as inputs:
1. Company Name
2. Company Industry (as listed on LinkedIn)
3. Company Description
4. Company Website (if available)
5. Company Location (as listed on LinkedIn)
6. Company Country (full country name, not code)
7. Company City (from the LinkedIn address field)

LinkedIn URL: ${linkedinUrl}
Company Domain: ${domain || 'unknown'}

Instructions:
- From the LinkedIn company page, extract all fields above.
- If a field is not found, return an empty string "" for that field.
- If no data is found at all, return "not found".
- Company Country must be the full country name (e.g. "Germany", not "DE").
- Company City is only the city name (e.g. if address is "Munich, Germany" return "Munich").

Output format (JSON):
{
  "Company Name": "...",
  "Industry": "...",
  "Company Description": "...",
  "Website": "...",
  "Location": "...",
  "Company Country": "...",
  "Company City": "..."
}`;

        try {
            const rawText = await askWithWebSearch('Output ONLY valid JSON. No markdown.', prompt,
                { jobId, operation: 'stage2_linkedin_enrich' });
            // Extract JSON from text output
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) return null;
            const parsed = JSON.parse(match[0]);
            if (parsed === 'not found') return null;
            return parsed;
        } catch (err) {
            logger.warn('_enrichFromLinkedIn parse failed', { error: err.message });
            return null;
        }
    }

    async _estimateDACHEmployees(companyName, total, hqCountry, dachOffices, jobId = null) {
        const isDACH = ['germany','austria','switzerland'].some(c => (hqCountry||'').toLowerCase().includes(c));
        if (isDACH) return Math.round(total * 0.8);
        try {
            const r = await askJSON('Output ONLY valid JSON.',
                `Estimate DACH employees for ${companyName}. Total: ${total}. HQ: ${hqCountry||'unknown'}. DACH offices: ${dachOffices||'none'}.
Respond: { "dach_employees": number }`,
                'gpt-4o-mini',
                { jobId, operation: 'stage2_dach_employee_estimate' });
            return r.dach_employees || null;
        } catch (_) { return null; }
    }

    /**
     * Ask GPT for the canonical company domain when every other source failed.
     * Operator rule: NO BLIND GUESSING — if the model returns blank, we accept
     * blank and let Stage 2 reject the job. Only confident answers count.
     *
     * Returns a lowercase domain string (no protocol, no www) or null.
     */
    async _findDomainViaAI(companyName, country, jobId = null) {
        try {
            const r = await askJSON(
                'You identify canonical company domains. Output ONLY valid JSON. ' +
                'If you are not highly confident, return an empty string — never guess.',
                `Find the canonical primary domain for this company.

Company name: ${companyName}
Country:      ${country}

Rules:
- Return the company's MAIN domain only (no protocol, no www, no path).
  Examples: "bmw.de", "siemens.com", "datev.de", "sap.com".
- If multiple TLDs exist (e.g. bmw.com vs bmw.de), pick the one matching the country.
- If you are NOT highly confident this is a real, well-known company, return "".
- If the company name looks synthetic (test data, numeric suffix, random tokens), return "".
- Do not guess. Do not invent. Empty string is better than a wrong domain.

Output JSON: { "domain": "<domain or empty>", "confidence": "high"|"medium"|"low", "reasoning": "<one sentence>" }`,
                'gpt-4o-mini',
                { jobId, operation: 'stage2_ai_domain_lookup' }
            );
            const raw = (r.domain || '').toString().trim().toLowerCase();
            const cleaned = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
            if (!cleaned) return null;
            // Reject low-confidence answers — operator wants only confident matches
            if (r.confidence === 'low') {
                logger.info(`Stage 2: AI low-confidence domain "${cleaned}" rejected — leaving blank`, { companyName, country, reasoning: r.reasoning });
                return null;
            }
            // Basic sanity check — must look like a domain (contains a dot, no spaces)
            if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(cleaned)) {
                logger.warn(`Stage 2: AI returned malformed domain "${cleaned}" — rejecting`, { companyName });
                return null;
            }
            return cleaned;
        } catch (err) {
            logger.warn('AI domain lookup failed', { error: err.message, companyName });
            return null;
        }
    }
}

function extractDomain(url) {
    if (!url) return null;
    try {
        const normalized = url.includes('://') ? url : 'https://' + url;
        return new URL(normalized).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch (_) {
        return url.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?#].*$/, '').toLowerCase() || null;
    }
}

/**
 * Resolve a "pipeline field" name to a value on the job row. Most fields are
 * straight column reads; a few have computed fallbacks (e.g. company_domain
 * derived from company_url when not stored explicitly).
 */
function _readJobField(job, fieldName) {
    if (!job || !fieldName) return null;
    if (fieldName === 'company_domain') {
        return job.company_domain
            || _domain(job.company_url)
            || _domain(job.company_linkedin_url)
            || null;
    }
    return job[fieldName] ?? null;
}
function _domain(url) {
    if (!url) return null;
    try {
        const u = url.includes('://') ? url : 'https://' + url;
        return new URL(u).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch { return null; }
}

module.exports = Stage02_CompanyEnrich;
