/**
 * HeyReach API + content generation (LPF Table 4 parity).
 *
 * Pipeline per contact (verbatim from the operator's spec):
 *
 *   ┌── master gate ─────────────────────────────────────────────────────┐
 *   │   RecipientCountry ∈ {germany, de, switzerland}   AND              │
 *   │   contact IS A JOB POSTER                                          │
 *   └────────────────────────────────────────────────────────────────────┘
 *           │
 *   ① DACH-by-LinkedIn check (askWithWebSearch → 'yes' | 'no' | '')
 *           │  if 'yes':
 *   ② Prompt 1 — job_posting_intro
 *           │
 *   ③ Prompt 2 — imagined_city_sentence
 *           │
 *   ④ Prompt 3 — imagined_industry_sentence
 *           │
 *   ⑤ Assemble English InMail (string concat — no GPT call)
 *           │
 *   ⑥ Translate English InMail → German
 *           │
 *   ⑦ Connection Request (≤299 chars, German)
 *           ▼
 *   Persist every intermediate value onto lpf_contacts so the operator can
 *   see what each prompt produced + why a contact was skipped.
 *
 * Required env vars for the API actions (not the generation):
 *   HEYREACH_API_KEY
 *   HEYREACH_LIST_ID
 *   HEYREACH_CAMPAIGN_FREE_INMAIL   (default '145461' — LPF JD 2)
 *   HEYREACH_CAMPAIGN_CONREQ_INMAIL
 *   HEYREACH_CAMPAIGN_CONNECT_ONLY
 */
const https      = require('https');
const { askJSON, askWithWebSearch, computeCostUSD } = require('./OpenAIService');
const Logger     = require('../Logger');

const logger   = new Logger('HeyReach');

// Campaign IDs (defaults captured from live Clay inspection 2026-05-18)
const CAMPAIGNS = {
    free_inmail:        process.env.HEYREACH_CAMPAIGN_FREE_INMAIL    || '145461',
    conreq_plus_inmail: process.env.HEYREACH_CAMPAIGN_CONREQ_INMAIL  || '',
    connect_only:       process.env.HEYREACH_CAMPAIGN_CONNECT_ONLY   || '',
};

const DACH_TOKENS = ['germany', 'de', 'deutschland', 'switzerland', 'schweiz', 'austria', 'österreich', 'at'];

// ─── HTTP helper (HeyReach send actions) ─────────────────────────────────────

function getApiKey() { return process.env.HEYREACH_API_KEY || ''; }

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic discovery for the Connections UI — fetched live from HeyReach so
// operators can pick a campaign + customise the lead/customFields mapping
// without us hardcoding anything.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET all HeyReach campaigns. Used by the dashboard's Connections tab to
 * populate the "Send to which campaign" dropdown per route (free_inmail,
 * conreq_plus_inmail, connect_only).
 */
async function fetchCampaigns(apiKey) {
    const key = apiKey || getApiKey();
    if (!key) throw new Error('No HeyReach API key');
    // HeyReach's /campaign/GetAll wants an empty body; uses our post() above
    // which reads getApiKey() — so set it temporarily if a key was passed in.
    const prev = process.env.HEYREACH_API_KEY;
    if (apiKey) process.env.HEYREACH_API_KEY = apiKey;
    try {
        const res = await post('/campaign/GetAll', {});
        process.env.HEYREACH_API_KEY = prev;
        const rows = Array.isArray(res) ? res
                   : Array.isArray(res?.items) ? res.items
                   : Array.isArray(res?.data) ? res.data
                   : Array.isArray(res?.campaigns) ? res.campaigns
                   : [];
        return rows.map(c => ({
            id:     c.id || c.campaignId,
            name:   c.name || c.campaignName || '(unnamed)',
            status: c.status,
        }));
    } catch (err) {
        process.env.HEYREACH_API_KEY = prev;
        throw err;
    }
}

/**
 * HeyReach's lead schema is fixed (firstName/lastName/email/linkedInUrl/
 * companyName/position) PLUS customFields (an array of {key, value}). This
 * function returns the FIXED schema + the standard customField keys our
 * pipeline emits, for the mapping editor.
 */
function getLeadSchema() {
    return {
        // Fixed lead fields — names are not configurable on HeyReach's side,
        // but operator can re-map the source-of-value (e.g. pick the contact's
        // li_merged URL or person_linkedin_url for `linkedInUrl`).
        standard: ['firstName','lastName','email','linkedInUrl','companyName','position','connectionRequest','inMailMessage'],
        // Custom fields — operator can add/remove these from the connection config.
        customFields: ['job_url','salutation','title','company_domain','tech_short','tech_longer','imagined_city','imagined_industry','primary_tech','created'],
    };
}

const HEYREACH_DEFAULT_RESOLVERS = {
    firstName:         (c)    => c.first_name || '',
    lastName:          (c)    => c.last_name  || '',
    email:             (c)    => c.email      || '',
    linkedInUrl:       (c)    => c.person_linkedin_url || c.linkedin_url_merged || c.li_merged || c.linkedin_url || '',
    companyName:       (c, j) => j?.company_name || c.company_name || '',
    position:          (c)    => c.title        || '',
    connectionRequest: (c)    => c.connection_req || '',
    inMailMessage:     (c)    => c.inmail_body_de || '',
    // Custom fields
    job_url:           (c, j) => j?.job_url || c.job_url || '',
    salutation:        (c)    => c.salutation || '',
    title:             (c)    => c.title || '',
    company_domain:    (c, j) => j?.company_domain || '',
    tech_short:        (c, j) => j?.tech_short  || '',
    tech_longer:       (c, j) => j?.tech_longer || '',
    imagined_city:     (c, j) => j?.imagined_city || '',
    imagined_industry: (c, j) => j?.imagined_industry || '',
    primary_tech:      (c, j) => j?.primary_tech || 'SAP',
    created:           (c)    => c.created_at ? String(c.created_at) : '',
};

function _heyreachResolve(target, contact, job, fieldMapping) {
    const m = fieldMapping?.[target];
    if (typeof m === 'string') {
        if (m.startsWith('literal:')) return m.slice('literal:'.length);
        if (m.startsWith('contact.')) return contact[m.slice('contact.'.length)] ?? '';
        if (m.startsWith('job.'))     return job?.[m.slice('job.'.length)] ?? '';
        return m;
    }
    const fn = HEYREACH_DEFAULT_RESOLVERS[target];
    return fn ? fn(contact, job) : '';
}

/**
 * Build a HeyReach lead with a saved field_mapping applied (overrides default
 * resolvers). Called by Stage 8's HeyReach send + by the Connections UI's
 * preview.
 */
function buildHeyReachLead(contact, job, opts = {}) {
    const fm = opts.fieldMapping || null;
    const schema = getLeadSchema();
    const lead = {};
    for (const k of schema.standard) lead[k] = _heyreachResolve(k, contact, job, fm);
    // Custom fields → array shape
    const cf = [];
    const cfKeys = (opts.customFieldKeys && opts.customFieldKeys.length) ? opts.customFieldKeys : schema.customFields;
    for (const k of cfKeys) {
        const v = _heyreachResolve(k, contact, job, fm);
        cf.push({ key: k, value: String(v == null ? '' : v) });
    }
    if (cf.length) lead.customFields = cf;
    return lead;
}

function post(path, body) {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        if (!apiKey) return reject(new Error('HEYREACH_API_KEY not configured'));

        const data = JSON.stringify(body);
        const opts = {
            hostname: 'api.heyreach.io',
            path:     '/api/public' + path,
            method:   'POST',
            headers: {
                'X-API-KEY':      apiKey,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
        };

        const req = https.request(opts, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    if (res.statusCode >= 400) return reject(new Error(parsed?.message || `HTTP ${res.statusCode}`));
                    resolve(parsed);
                } catch (_) {
                    if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                    resolve({ raw });
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ─── Routing (mirrors Clay cols 44–59) ───────────────────────────────────────

function determineRoute(contact) {
    if ((contact.person_source || contact.source || '').toLowerCase().includes('job')) {
        return 'conreq_plus_inmail';
    }
    if (contact.is_it_role) return 'conreq_plus_inmail';
    if (contact.email_validated || contact.email) return 'conreq_plus_inmail';
    return 'connect_only';
}

// ─── Step 1 — DACH-by-LinkedIn check ─────────────────────────────────────────

/**
 * Verbatim prompt from the operator. Uses askWithWebSearch so the model can
 * actually visit the profile (Responses API + web_search_preview tool).
 *
 * The model is told to output ONLY 'yes' / 'no' / '' — we wrap it for JSON
 * parsing on this side so we capture cost + reasoning alongside the answer.
 */
async function checkDachByLinkedIn(linkedinUrl, opts = {}) {
    const sys = 'You are a careful researcher. You must follow output instructions exactly.';
    const usr = `You are an AI assistant that determines whether a person is based in Germany or Switzerland using their LinkedIn profile.

1. Visit the provided LinkedIn profile URL.
2. Extract the person's location from the profile.
3. Decide if the location is in Germany or Switzerland.
   • If the person is in any of two countries, output 'yes'.
   • If the person is not in these countries, output 'no'.
   • If you are unable to determine the location or there is any issue, output '' (leave it blank).

Important:
• The output must be only 'yes', 'no', or empty (no additional text).
• If the profile location is unclear, do not guess — leave the output blank.
• Do not provide explanations or comments.

LinkedIn URL: ${linkedinUrl}

Respond as JSON ONLY: {"response":"yes"|"no"|"","reasoning":"<short why — for our internal log>","confidence":"high"|"medium"|"low"}`;

    let raw, costMeta = null;
    try {
        raw = await askWithWebSearch(sys, usr, { jobId: opts.jobId, operation: 'heyreach_dach_check' });
    } catch (err) {
        logger.warn('DACH-by-LinkedIn web search failed — falling back to plain JSON ask', { error: err.message });
        const r = await askJSON(sys,
            usr.replace('Respond as JSON ONLY:', 'You cannot browse the web. Reply blank "" if you cannot tell from the URL alone. Respond as JSON ONLY:'),
            'gpt-4o-mini', { jobId: opts.jobId, operation: 'heyreach_dach_check_fallback' });
        return _stampCost({ response: (r.response || '').toLowerCase(), reasoning: r.reasoning || '', confidence: r.confidence || 'low' }, 'gpt-4o-mini', 0, 0);
    }
    // Parse JSON from the model output (may include leading prose)
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    let parsed = { response: '', reasoning: '', confidence: 'low' };
    if (match) {
        try { parsed = { response: '', reasoning: '', confidence: 'low', ...JSON.parse(match[0]) }; } catch (_) {}
    }
    parsed.response = String(parsed.response || '').toLowerCase().trim();
    if (!['yes', 'no', ''].includes(parsed.response)) parsed.response = '';
    return parsed;
}

// ─── Steps 2–4 — three sentence-construction prompts ────────────────────────

/**
 * Prompt 1 — job_posting_intro
 * "noticed your {job_posting_name} job posting and I have a candidate who:"
 *
 *   job_posting_name ← tech_names_person (= tech_name_person_type_merged + Subject)
 *                        OR shorter_tech_scrambled if the former is empty
 */
async function generateJobPostingIntro({ techNamesPerson, shorterTechScrambled }, jobId) {
    const sys = 'You construct exactly one short sentence. Output JSON only.';
    const usr = `I need you to construct a sentence which has following structure:

"noticed your {job_posting_name} job posting and I have a candidate who:"

The value of "job_posting_name" variable needs to be replaced by "tech_names_person" input variable value which I will provide you. Just in case value of "tech_names_person" is empty or blank, then use "shorter_tech_scrambled" input variable value in its place.

Return only the constructed sentence without any quotes.

INPUT:
tech_names_person      = ${techNamesPerson      || ''}
shorter_tech_scrambled = ${shorterTechScrambled || ''}

Respond as JSON ONLY: {"response":"<the constructed sentence>"}`;
    const r = await askJSON(sys, usr, 'gpt-4o-mini', { jobId, operation: 'heyreach_job_posting_intro' });
    return (r?.response || '').trim();
}

/**
 * Prompt 2 — imagined_city_sentence
 * "Lives in {imagined_nearby_city} drivable from {imagined_city}"
 * OR "Lives in {imagined_city}" when imagined_nearby_city is blank.
 */
async function generateImaginedCitySentence({ imaginedCity, imaginedNearbyCity }, jobId) {
    const sys = 'You construct exactly one short sentence. Output JSON only. Do not add a full stop.';
    const usr = `I need you to construct a sentence with following structure:

"Lives in {imagined_nearby_city} drivable from {imagined_city}"

I will provide you the values for "imagined_nearby_city" and "imagined_city" as inputs. Just in case "imagined_nearby_city" value is empty or blank, then change the sentence structure to this: "Lives in {imagined_city}"

Return only the constructed sentence and nothing else. Don't put full stop at the end of the sentence.

INPUT:
imagined_nearby_city = ${imaginedNearbyCity || ''}
imagined_city        = ${imaginedCity       || ''}

Respond as JSON ONLY: {"response":"<the constructed sentence>"}`;
    const r = await askJSON(sys, usr, 'gpt-4o-mini', { jobId, operation: 'heyreach_imagined_city_sentence' });
    return (r?.response || '').trim();
}

/**
 * Prompt 3 — imagined_industry_sentence
 * "Has previously worked on a project in {imagined_industry} industry"
 * OR "Has previously worked for SAP consultancy" when imagined_industry === "SAP".
 */
async function generateImaginedIndustrySentence({ imaginedIndustry }, jobId) {
    const sys = 'You construct exactly one short sentence. Output JSON only. Do not add a full stop.';
    const usr = `I need you to construct a sentence with following structure:

"Has previously worked on a project in {imagined_industry} industry"

I am going to provide you the value of the "imagined_industry" variable as input. Just in case "imagined_industry" variable value is "SAP", then change the sentence structure to this: "Has previously worked for SAP consultancy"

Return only the constructed sentence and nothing else. Don't put full stop at the end of the sentence.

INPUT:
imagined_industry = ${imaginedIndustry || ''}

Respond as JSON ONLY: {"response":"<the constructed sentence>"}`;
    const r = await askJSON(sys, usr, 'gpt-4o-mini', { jobId, operation: 'heyreach_imagined_industry_sentence' });
    return (r?.response || '').trim();
}

// ─── Step 5 — English InMail assembly (exact concat from the spec) ──────────

/**
 *   "Hallo " + {{Frau / Herr + Last Name}} + ", I " + {{Job_posting_intro}}.response
 *   + "\n\n- " + {{imagined_city_sentence}}.response
 *   + "\n- "  + {{imagined_industry_sentence}}.response
 *   + "\n- Has experience with " + {{longer_tech_description}}
 *   + "\n- Speaks fluent German and is looking for permanent work.\r\n\r"
 *   + "Have time for a quick chat to discuss?\r"
 */
function assembleEnglishInMail({ salutation, intro, citySentence, industrySentence, longerTech }) {
    return `Hallo ${salutation}, I ${intro}\n\n- ${citySentence}\n- ${industrySentence}\n- Has experience with ${longerTech}\n- Speaks fluent German and is looking for permanent work.\r\n\rHave time for a quick chat to discuss?\r`;
}

// ─── Step 6 — German translation (verbatim Clay prompt) ─────────────────────

async function translateToGerman(englishInmail, jobId) {
    const sys = 'You are a professional German business translator. Output JSON only.';
    const usr = `Convert this email message into german

${englishInmail}

In your output i only want the message in German i do not want any thoughts or opinion from you.

Respond as JSON ONLY: {"text":"<the German message only>"}`;
    const r = await askJSON(sys, usr, 'gpt-4o-mini', { jobId, operation: 'heyreach_german_translate' });
    return (r?.text || '').trim();
}

// ─── Step 7 — Connection Request (verbatim Clay prompt, ≤299 chars) ─────────

async function generateConReq(firstName, inMailDe, jobId) {
    const sys = 'You write German LinkedIn connection request messages for a DACH recruitment agency. Output JSON only.';
    const usr = `Using the longer inmail message found in {inmail body German} create a shorter linked in connection request.

The message must be a maximum of 299 characters and needs to remain in German language.

Try and include the tech, langauge skills an location as long as you can keep it within 299 characters.

An example connection request message could be

Hallo NAME, ich habe Ihre Anzeige für einen SAP APO Berater gesehen und habe einen starken Kandidaten aus Nürnberg. Er hat Erfahrung mit SAP, HCM und ABAP in der Fertigungsindustrie und spricht fließend Deutsch. Hätten Sie Zeit für ein kurzes Gespräch?

remember the German message needs to be below 299 characters.

Often when English is converted to German, the German text is longer so be sure to consider this when composing the message.

Dont worry about ending the message with someting like with things like [you name], Viele Grüße, Beste Grüße, MfG, Mit freundlichen Grüßen.

Instead end it with Hätten Sie Zeit für ein kurzes Gespräch? everytime

Always use the persons first name found in {first_name}

Never use the word NAME.

Instead end it with Hätten Sie Zeit für ein kurzes Gespräch? everytime

{inmail body German}:
${inMailDe}

{first_name}: ${firstName}

Respond as JSON ONLY: {"response":"<the German connection request, max 299 chars>"}`;
    const r = await askJSON(sys, usr, 'gpt-4o-mini', { jobId, operation: 'heyreach_connection_req' });
    let text = (r?.response || '').trim();
    if (text.length > 299) text = text.slice(0, 296) + '…';
    return text;
}

// ─── Orchestrator: generateContent ───────────────────────────────────────────

/**
 * Run the entire HeyReach generation pipeline for one contact.
 *
 * Returns one of two shapes:
 *
 *   SKIPPED (gate failed or DACH check returned no/empty):
 *   {
 *     skipped:               true,
 *     skip_reason:           string,
 *     heyreach_dach_check:   'yes'|'no'|''|null,
 *     heyreach_dach_reasoning: string|null,
 *   }
 *
 *   GENERATED:
 *   {
 *     skipped:                              false,
 *     english_inmail:                       string,
 *     inmail_body_de:                       string,
 *     connection_req:                       string,
 *     heyreach_job_posting_intro:           string,
 *     heyreach_imagined_city_sentence:      string,
 *     heyreach_imagined_industry_sentence:  string,
 *     heyreach_dach_check:                  'yes',
 *     heyreach_dach_reasoning:              string,
 *     heyreach_route:                       string,
 *     heyreach_generated_at:                Date,
 *     heyreach_error:                       null,
 *     heyreach_skip_reason:                 null,
 *   }
 *
 * The caller persists the entire returned object via `db.updateContact()`.
 */
async function generateContent(contact, job) {
    const liUrl = contact.li_merged || contact.linkedin_url_merged
               || contact.person_linkedin_url || contact.linkedin_url;
    if (!liUrl) {
        return _skip('no_linkedin_url');
    }

    // ── Master gate: RecipientCountry in DACH list AND contact IS A JOB POSTER ──
    const country = (contact.country || '').toLowerCase();
    const isDachCountry = DACH_TOKENS.some(t => country.includes(t));
    const isJobPoster = contact.contact_type === 'job_poster'
                      || (contact.person_source || contact.source || '').toLowerCase().includes('job');

    if (!isDachCountry) return _skip(`recipient_country_not_dach (country="${contact.country || ''}")`);
    if (!isJobPoster)   return _skip(`contact_is_not_job_poster (contact_type="${contact.contact_type || ''}", source="${contact.person_source || contact.source || ''}")`);

    // ── Step 1: DACH-by-LinkedIn check ───────────────────────────────────────
    const dach = await checkDachByLinkedIn(liUrl, { jobId: job?.id });
    if (dach.response !== 'yes') {
        return _skip(`dach_linkedin_check=${dach.response || 'empty'}`, dach);
    }

    // ── Steps 2–4: build the three sentences ─────────────────────────────────
    const techNamesPerson      = job?.tech_short2 || job?.tech_names_person_type || '';
    const shorterTechScrambled = job?.shorter_tech_description_scrambled || job?.shorter_tech_description || '';
    const intro            = await generateJobPostingIntro({ techNamesPerson, shorterTechScrambled }, job?.id);
    const citySentence     = await generateImaginedCitySentence({
        imaginedCity:       job?.imagined_city       || contact.city,
        imaginedNearbyCity: job?.imagined_nearby_city,
    }, job?.id);
    const industrySentence = await generateImaginedIndustrySentence({
        imaginedIndustry: job?.imagined_industry,
    }, job?.id);

    // ── Step 5: assemble English InMail ──────────────────────────────────────
    const salutation = contact.salutation
        || `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
        || contact.first_name || 'there';
    const longerTech = job?.longer_tech_description || job?.tech_longer || job?.shorter_tech_description || 'SAP';
    const englishInmail = assembleEnglishInMail({
        salutation,
        intro,
        citySentence,
        industrySentence,
        longerTech,
    });

    // ── Step 6: translate to German ──────────────────────────────────────────
    const germanInmail = await translateToGerman(englishInmail, job?.id);

    // ── Step 7: Connection Request ───────────────────────────────────────────
    const firstName = contact.first_name || (contact.full_name || '').split(' ')[0] || 'Hi';
    const connectionReq = await generateConReq(firstName, germanInmail, job?.id);

    return {
        skipped:                              false,
        english_inmail:                       englishInmail,
        inmail_body_de:                       germanInmail,
        connection_req:                       connectionReq,
        heyreach_job_posting_intro:           intro,
        heyreach_imagined_city_sentence:      citySentence,
        heyreach_imagined_industry_sentence:  industrySentence,
        heyreach_dach_check:                  dach.response,
        heyreach_dach_reasoning:              dach.reasoning || null,
        heyreach_route:                       determineRoute(contact),
        heyreach_generated_at:                new Date(),
        heyreach_error:                       null,
        heyreach_skip_reason:                 null,
    };
}

function _skip(reason, dach = null) {
    return {
        skipped:                  true,
        heyreach_skip_reason:     reason,
        heyreach_dach_check:      dach?.response   || null,
        heyreach_dach_reasoning:  dach?.reasoning  || null,
        heyreach_generated_at:    new Date(),     // mark "tried" so we don't retry next pass
        heyreach_error:           null,
    };
}
function _stampCost(x, model, inputTokens, outputTokens) {
    const usd = computeCostUSD(model, inputTokens, outputTokens);
    return { ...x, _cost: { model, inputTokens, outputTokens, costUsd: usd } };
}

// ─── HeyReach API calls (unchanged from previous version) ───────────────────

async function addLead(contact, listId) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('HEYREACH_API_KEY not set in .env');

    const liUrl = contact.person_linkedin_url || contact.linkedin_url_merged
               || contact.li_merged          || contact.linkedin_url || null;
    if (!liUrl) throw new Error(`Contact ${contact.id} has no LinkedIn URL — required for HeyReach`);

    const targetList = listId || process.env.HEYREACH_LIST_ID || '';
    if (!targetList) throw new Error('HEYREACH_LIST_ID not set in .env');

    const lead = {
        firstName:    contact.first_name  || '',
        lastName:     contact.last_name   || '',
        email:        contact.email       || '',
        linkedInUrl:  liUrl,
        companyName:  contact.company_name || '',
        position:     contact.title        || '',
        summary:      contact.job_url      || '',
        customFields: [
            { key: 'created', value: contact.created_at ? String(contact.created_at) : '' },
            { key: 'jon_URL', value: contact.job_url || '' },
        ],
    };

    const result = await post('/lead/AddLeadsToList', { listId: targetList, leads: [lead] });
    logger.debug('HeyReach lead added', { contact_id: contact.id, list: targetList });
    return result?.leadIds?.[0] || result?.id || null;
}

async function addLeadToCampaign(contact, route, opts = {}) {
    // Campaign ID resolution: explicit opts > env-fallback CAMPAIGNS table
    const campaignId = opts.campaignId || CAMPAIGNS[route] || CAMPAIGNS.free_inmail;
    if (!campaignId) throw new Error(`No campaign ID configured for route: ${route}`);

    const liUrl = contact.li_merged || contact.linkedin_url || contact.person_linkedin_url;
    if (!liUrl) throw new Error('No LinkedIn URL for HeyReach');

    // Build the lead with optional saved field-mapping applied. When the
    // operator hasn't customised the mapping, this produces exactly the same
    // payload we sent before — backwards-compatible.
    const lead = buildHeyReachLead(contact, opts.job || {}, {
        fieldMapping:    opts.fieldMapping || null,
        customFieldKeys: opts.customFieldKeys || null,
    });
    // Always honour the LinkedIn URL we resolved above (defensive — the mapping
    // editor shouldn't be able to break the one field HeyReach requires)
    if (!lead.linkedInUrl) lead.linkedInUrl = liUrl;

    const payload = { campaignId, leads: [lead] };

    const result = await post('/campaign/AddLeadsToCampaign', payload);
    const leadId = result?.leadIds?.[0] || result?.id || null;
    logger.debug('HeyReach campaign lead added', { contact_id: contact.id, campaign: campaignId, route, leadId });
    // Return both the lead id AND the full response so the caller can persist it
    // on the contact row — surfaced in the dashboard's "Sent ✅" detail drawer.
    return {
        leadId,
        response: { campaignId, route, ...result, _request_payload: payload },
    };
}

async function addLeads(contacts, listId) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('HEYREACH_API_KEY not set in .env');

    const targetList = listId || process.env.HEYREACH_LIST_ID || '';
    const valid = contacts.filter(c =>
        c.person_linkedin_url || c.linkedin_url_merged || c.li_merged || c.linkedin_url
    );
    if (!valid.length) throw new Error('No contacts with LinkedIn URLs for HeyReach');

    const leads = valid.map(c => ({
        firstName:   c.first_name  || '',
        lastName:    c.last_name   || '',
        email:       c.email       || '',
        linkedInUrl: c.person_linkedin_url || c.linkedin_url_merged || c.li_merged || c.linkedin_url,
        companyName: c.company_name || '',
        position:    c.title        || '',
    }));

    const result = await post('/lead/AddLeadsToList', { listId: targetList, leads });
    logger.info(`HeyReach: added ${valid.length} leads to list ${targetList}`);
    return result;
}

module.exports = {
    addLead,
    addLeads,
    addLeadToCampaign,
    generateContent,
    determineRoute,
    checkDachByLinkedIn,
    generateJobPostingIntro,
    generateImaginedCitySentence,
    generateImaginedIndustrySentence,
    assembleEnglishInMail,
    translateToGerman,
    generateConReq,
    CAMPAIGNS,
    DACH_TOKENS,
    // Dynamic discovery for Connections UI
    fetchCampaigns,
    getLeadSchema,
    buildHeyReachLead,
    HEYREACH_DEFAULT_RESOLVERS,
};
