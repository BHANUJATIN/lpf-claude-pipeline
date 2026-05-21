/**
 * CVGenerationService — full CV generation pipeline.
 *
 *  Step 1. Eligibility check
 *          POST https://bs-ctr-resume-lookup.onrender.com/api/cv/check-and-submit
 *          body: { domain, linkedinUrl } → { canGenerateCV, company, english, german }
 *          If canGenerateCV !== true, the whole flow stops.
 *
 *  Step 2. Generate ENGLISH CV (structured JSON) with the verbatim prompt provided
 *          by the operator. Returns a JSON object with the canonical CV placeholders
 *          (recruiterSummary, location, dateOfBirth, languages, nationality, linkedin,
 *           aboutMe, technicalSkills, experience, education, languagesDetailed,
 *           certifications, hobbiesAndInterests) plus token/cost metadata.
 *
 *  Step 3. Translate the English JSON into GERMAN with the second verbatim prompt.
 *
 *  Step 4. POST each variant to the Google Apps Script PDF renderer
 *          (https://script.google.com/.../exec) which returns docId, pdfId, docUrl, pdfUrl.
 *
 *  Outputs (returned by generateAll):
 *    {
 *      eligible:     true|false,
 *      eligibility:  <raw eligibility response>,
 *      english:      <structured JSON + cost metadata>,
 *      german:       <structured JSON + cost metadata>,
 *      englishPdf:   { docId, pdfId, docUrl, pdfUrl },
 *      germanPdf:    { docId, pdfId, docUrl, pdfUrl },
 *      costs:        { total: {usd, input, output}, english: {…}, german: {…} },
 *    }
 *
 *  All token counts + USD costs are computed against the same MODEL_PRICING table
 *  used everywhere else in the dashboard (see OpenAIService.js).
 */
const axios       = require('axios');
const Logger      = require('../Logger');
const costTracker = require('./CostTrackerService');
const { computeCostUSD } = require('./OpenAIService');

const logger = new Logger('CVGen');

// External integration URLs
const ELIGIBILITY_URL = 'https://bs-ctr-resume-lookup.onrender.com/api/cv/check-and-submit';
const PDF_RENDER_URL  = 'https://script.google.com/macros/s/AKfycbysP5EsSHpWe-3AC0Ft2axHNeXlrZjdPClNSpmksYB_qtopcXLYiRkIPT7dHpWkRtO19g/exec';

const OPENAI_URL      = 'https://api.openai.com/v1/chat/completions';
const PREFERRED_MODEL = 'gpt-4o-mini';
const FALLBACK_MODEL  = 'gpt-4.1-nano';

// ─── Verbatim prompts from the operator ──────────────────────────────────────

const ENGLISH_PROMPT_BODY = `ROLE

You are an expert SAP recruiter assistant with deep knowledge of the German SAP consulting market.

Your task is to invent a fully imaginary SAP consultant who would be a strong and realistic fit for the given role.

You must THINK for yourself and design the candidate holistically:

- career path

- seniority

- skills

- experience progression

- education timeline

- certifications

- personal profile

The CV content must feel human-written, imperfect, and natural, as if created by an experienced recruiter and a real consultant.

You are NOT filling a template mechanically.

You are designing a believable person.

---

IMPORTANT CONSTRAINTS (NON-NEGOTIABLE)

- Every section MUST be freshly generated.

- NO section may be static, copied, reused, or formulaic.

- Language, skills, experience, and wording must vary naturally each run.

- The candidate must plausibly fit the role described — but must NOT reference the job advert directly.

- NO bold formatting anywhere in the output.

- Do NOT use markdown-style emphasis (**, __, or similar) under any circumstance.

Do NOT explain your steps.

Do NOT reference the job advert.

Do NOT add commentary outside the placeholders.

---

OBJECTIVE

Generate realistic values for EACH placeholder below,

based on your own reasoning about:

- SAP role type

- seniority level

- market expectations in Germany

- realistic career timelines

---

PLACEHOLDER TEMPLATE (DO NOT MODIFY KEYS)

Recruiter Summary
<recruiterSummary>

Location – <location>
Date of Birth – <dateOfBirth>
Languages – <languages>
Nationality – <nationality>
LinkedIn – <linkedin>

About Me
<aboutMe>

Technical Skills
<technicalSkills>

Professional Experience
<experience>

Education
<education>

Languages
<languagesDetailed>

Certifications
<certifications>

Date of Birth
<dateOfBirth>

Hobbies & Interests
<hobbiesAndInterests>

---

CONTENT RULES (STRICT BUT INTELLIGENT)

GENERAL:

- EVERYTHING must be rewritten by you.
- Nothing is fixed or boilerplate.
- Content must read like a real consultant's CV.

LinkedIn:
- ALWAYS output exactly: "Available on request"
- Never generate or invent a LinkedIn URL.

Location:
- Use the provided INPUT Location exactly.
- Do NOT infer or change it.

Recruiter Summary:
- Written from recruiter perspective
- Natural, confident, slightly varied wording
- Do NOT reuse the same phrasing every time

About Me:
- 3–5 lines
- First-person
- Career motivation + SAP strengths
- Should align with experience level

Technical Skills:
- 10–12 bullet points
- SAP skills first (modules/tools relevant to role)
- Then 2–3 realistic supporting tools (e.g. Jira, Office 365, ServiceNow)
- Use this bullet character ONLY: •
- Avoid generic buzzword lists

Professional Experience:
- Reverse chronological
- Minimum 4 roles (5 if senior / lead / manager)
- Jobs 1–3 must be 2+ years
- Older roles can be 1–2 years
- NO company names
- Each role must include:
  - Job title and dates on the same line (plain text only, NO bold)
  - One-line context sentence
  - 4–6 bullet points using ONLY: •
- Insert exactly ONE blank line between roles
- Career progression must make sense

Education:
- Format exactly: Degree – Region (Grad Year)
- University timing must align with DOB
- No asterisks

Languages:
- German (native)
- English (fluent)
- One additional realistic language

Certifications:
- Minimum 3
- SAP or business-relevant
- Must align with the SAP stack implied by the role
- Use bullet character: •

Date of Birth:
- Format: DD.MM.YYYY
- Age between 30–48
- University start age must be 21–25

Hobbies & Interests:
- 2–3 realistic, human hobbies
- Avoid clichés and generic filler
- Use bullet character: •

---

REALISM & REDACTION RULES

- NEVER use real company names
- NEVER reuse job advert wording
- NEVER sound AI-polished or generic
- Vary sentence length and tone
- Slight imperfections are GOOD

---

OUTPUT RULES (NON-NEGOTIABLE)

- Output ONLY the populated placeholder values
- Output must conform EXACTLY to the JSON schema below
- No markdown
- No explanations
- No extra text

---

OUTPUT STRUCTURE (STRICT JSON)

{
  "recruiterSummary": "",
  "location": "",
  "dateOfBirth": "",
  "languages": "",
  "nationality": "",
  "linkedin": "Available on request",
  "aboutMe": "",
  "technicalSkills": "",
  "experience": "",
  "education": "",
  "languagesDetailed": "",
  "certifications": "",
  "hobbiesAndInterests": ""
}`;

const GERMAN_PROMPT_BODY = `CONTEXT

You are a professional German SAP recruitment translator.

You are given the OUTPUT of a previous prompt that generated
SAP consultant CV placeholder values in ENGLISH.

Your task is ONLY to TRANSLATE that content into NATIVE, PROFESSIONAL GERMAN.

You must NOT:
- Regenerate content
- Change meaning
- Add or remove information
- Improve, summarize, or rewrite
- Infer anything new

This is a STRICT TRANSLATION task.

---

OBJECTIVE

Translate EACH value into fluent, native-level German,
appropriate for a German SAP consultant CV sent to clients.

The output must:
- Sound natural to a German recruiter and SAP consultant
- Preserve tone (recruiter voice vs candidate voice)
- Preserve formatting, spacing, and line breaks
- Preserve bullet points exactly as-is
- Preserve dates, years, numbers, and SAP terminology

---

TRANSLATION RULES (VERY IMPORTANT)

- Translate faithfully — NOT creatively
- Keep SAP module names, tools, and certifications in their original form
  (e.g. SAP S/4HANA, SAP MM, Jira, ServiceNow)
- Job titles should be translated only if commonly done in German SAP CVs
  (e.g. "SAP Consultant" → "SAP Berater")
- Do NOT translate "Available on request" — keep it in English
- Do NOT change date formats (DD.MM.YYYY)
- Do NOT alter bullet counts or paragraph lengths

---

OUTPUT FORMAT (STRICT)

Return the SAME JSON structure as input, with ALL values translated into German.

{
  "recruiterSummary": "",
  "location": "",
  "dateOfBirth": "",
  "languages": "",
  "nationality": "",
  "linkedin": "",
  "aboutMe": "",
  "technicalSkills": "",
  "experience": "",
  "education": "",
  "languagesDetailed": "",
  "certifications": "",
  "hobbiesAndInterests": ""
}

---

STRICT OUTPUT RULES

- Output ONLY valid JSON
- No explanations
- No commentary
- No markdown
- No extra text before or after
- Preserve line breaks and spacing EXACTLY`;

// Canonical keys we expect from the model (everything else returned by it is stripped).
const CV_KEYS = [
    'recruiterSummary', 'location', 'dateOfBirth', 'languages', 'nationality', 'linkedin',
    'aboutMe', 'technicalSkills', 'experience', 'education', 'languagesDetailed',
    'certifications', 'hobbiesAndInterests',
];

// ─── Step 1: Eligibility check ───────────────────────────────────────────────

/**
 * Hits the external Render service that decides whether we may generate a CV
 * for this company. Returns the raw response which always carries `canGenerateCV`.
 */
async function checkEligibility({ domain, linkedinUrl }) {
    if (!domain && !linkedinUrl) {
        return { canGenerateCV: false, reason: 'no_domain_or_linkedin' };
    }
    const body = { domain: domain || '', linkedinUrl: linkedinUrl || '' };
    try {
        const r = await axios.post(ELIGIBILITY_URL, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
        });
        return r.data || { canGenerateCV: false };
    } catch (err) {
        const status = err.response?.status;
        const msg    = err.response?.data?.message || err.response?.data || err.message;
        logger.warn('Eligibility check failed', { status, error: msg });
        return { canGenerateCV: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200) };
    }
}

// ─── Step 2 + 3: OpenAI call helpers ────────────────────────────────────────

async function _callOpenAI({ userPrompt, jobId, operation }) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    const tryModel = async (model) => {
        const resp = await axios.post(OPENAI_URL, {
            model,
            messages: [{ role: 'user', content: userPrompt }],
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_tokens:  4000,
        }, {
            headers: {
                Authorization:    `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type':   'application/json',
            },
            timeout: 90000,
        });
        const raw   = resp.data?.choices?.[0]?.message?.content || '{}';
        const usage = resp.data?.usage || {};
        const inputTokens  = usage.prompt_tokens     || 0;
        const outputTokens = usage.completion_tokens || 0;
        const costUsd      = computeCostUSD(model, inputTokens, outputTokens);

        costTracker.logOpenAI({
            jobId, operation, model, inputTokens, outputTokens,
            metadata: { variant: operation },
        }).catch(() => {});

        let json;
        try { json = JSON.parse(raw); } catch (e) {
            throw new Error(`OpenAI returned non-JSON for ${operation}: ${e.message}`);
        }
        return { json, model, inputTokens, outputTokens, costUsd };
    };

    try { return await tryModel(PREFERRED_MODEL); }
    catch (err) {
        const status = err.response?.status;
        if (status === 404 || status === 400) {
            logger.warn(`${PREFERRED_MODEL} unavailable — falling back to ${FALLBACK_MODEL}`, { error: err.message });
            return tryModel(FALLBACK_MODEL);
        }
        throw err;
    }
}

function _stamp(json, model, inputTokens, outputTokens, costUsd) {
    const out = {};
    for (const k of CV_KEYS) out[k] = json[k] != null ? String(json[k]) : '';
    if (!out.linkedin) out.linkedin = 'Available on request';
    out.tokensUsed   = inputTokens + outputTokens;
    out.inputTokens  = inputTokens;
    out.outputTokens = outputTokens;
    out.totalCostToAIProvider = `$${costUsd.toFixed(5)}`;
    out.modelUsed    = model;
    return out;
}

/**
 * Generate the English structured CV JSON for a job.
 * Returns: { ...CV_KEYS, tokensUsed, inputTokens, outputTokens, totalCostToAIProvider, modelUsed }
 */
async function generateEnglish(job) {
    if (!job?.job_title) throw new Error('job_title required for CV generation');

    const candidateLocation = job.imagined_city || job.city || job.country || '';
    const jobLocation       = [job.city, job.country].filter(Boolean).join(', ');

    const userPrompt = `INPUT

- Job Title: ${job.job_title}
- Job Advert Description: ${(job.job_description || '').slice(0, 6000)}
- Candidate's Location: ${candidateLocation}
- Job location: ${jobLocation}

${ENGLISH_PROMPT_BODY}`;

    const r = await _callOpenAI({ userPrompt, jobId: job.id, operation: 'cv_english_structured' });
    return _stamp(r.json, r.model, r.inputTokens, r.outputTokens, r.costUsd);
}

/**
 * Strict-translate an English structured CV JSON into German.
 */
async function generateGerman(englishStructured, jobId) {
    const inputClean = {};
    for (const k of CV_KEYS) inputClean[k] = englishStructured?.[k] || '';

    const userPrompt = `${GERMAN_PROMPT_BODY}

INPUT (JSON to translate):
${JSON.stringify(inputClean, null, 2)}`;

    const r = await _callOpenAI({ userPrompt, jobId, operation: 'cv_german_translation' });
    return _stamp(r.json, r.model, r.inputTokens, r.outputTokens, r.costUsd);
}

// ─── Step 4: Apps Script PDF renderer ───────────────────────────────────────

/**
 * Post the CV body (docName + every CV_KEY field) to the Google Apps Script
 * endpoint. Returns { docId, pdfId, docUrl, pdfUrl } as documented.
 */
async function renderPdf({ docName, structured }) {
    const body = { docName: String(docName || 'CV') };
    for (const k of CV_KEYS) body[k] = structured?.[k] || '';

    const r = await axios.post(PDF_RENDER_URL, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
        maxRedirects: 5,
    });
    const d = r.data || {};
    if (!d.pdfUrl && !d.pdfId) {
        throw new Error('Apps Script returned no pdfUrl: ' + JSON.stringify(d).slice(0, 200));
    }
    return {
        docId:  d.docId || null,
        pdfId:  d.pdfId || null,
        docUrl: d.docUrl || null,
        pdfUrl: d.pdfUrl || (d.pdfId ? `https://drive.google.com/file/d/${d.pdfId}/view` : null),
    };
}

// ─── Step 5: Orchestrator (does the full flow end-to-end) ───────────────────

/**
 * Full pipeline for one job:
 *   eligibility → generate English JSON → translate to German → render both PDFs
 *
 * Returns a single object containing every piece of data the dashboard needs
 * (eligibility raw response, both structured JSONs, both Drive PDF URLs, and
 *  the cost breakdown for the two OpenAI calls).
 */
async function generateAll(job) {
    const domain = job.company_domain || _extractDomain(job.company_url) || _extractDomain(job.company_linkedin_url) || '';
    const eligibility = await checkEligibility({
        domain,
        linkedinUrl: job.company_linkedin_url || '',
    });

    if (eligibility?.canGenerateCV !== true) {
        logger.info(`Job ${job.id} not eligible for CV`, { domain, reason: eligibility?.error || eligibility?.reason });
        return { eligible: false, eligibility, english: null, german: null, englishPdf: null, germanPdf: null, costs: null };
    }

    // Apps Script doc name (matches the example "Proposal for Amer Sports")
    const companyName = (eligibility?.company?.name && !eligibility.company.name.includes('.'))
        ? eligibility.company.name
        : (job.company_name || eligibility?.company?.name || 'Company');
    const docNameEN = `Proposal for ${companyName}`;
    const docNameDE = `Proposal for ${companyName} (DE)`;

    const english = await generateEnglish(job);
    const german  = await generateGerman(english, job.id);

    let englishPdf = null;
    let germanPdf  = null;
    let pdfErrors  = [];
    try { englishPdf = await renderPdf({ docName: docNameEN, structured: english }); }
    catch (err) { pdfErrors.push(`english_pdf: ${err.message}`); logger.warn('English PDF render failed', { error: err.message }); }
    try { germanPdf  = await renderPdf({ docName: docNameDE, structured: german  }); }
    catch (err) { pdfErrors.push(`german_pdf: ${err.message}`); logger.warn('German PDF render failed', { error: err.message }); }

    const enCost = parseFloat((english.totalCostToAIProvider || '$0').replace('$', '')) || 0;
    const deCost = parseFloat((german.totalCostToAIProvider  || '$0').replace('$', '')) || 0;
    const costs = {
        english: {
            model: english.modelUsed, inputTokens: english.inputTokens, outputTokens: english.outputTokens, costUsd: enCost,
        },
        german: {
            model: german.modelUsed,  inputTokens: german.inputTokens,  outputTokens: german.outputTokens,  costUsd: deCost,
        },
        total: {
            usd:    enCost + deCost,
            input:  english.inputTokens  + german.inputTokens,
            output: english.outputTokens + german.outputTokens,
        },
    };

    return {
        eligible:    true,
        eligibility,
        english,
        german,
        englishPdf,
        germanPdf,
        costs,
        errors:      pdfErrors.length ? pdfErrors.join(' | ') : null,
        docNames:    { english: docNameEN, german: docNameDE },
    };
}

function _extractDomain(url) {
    if (!url) return null;
    try {
        const u = url.includes('://') ? url : 'https://' + url;
        return new URL(u).hostname.replace(/^www\./, '').toLowerCase() || null;
    } catch { return null; }
}

module.exports = {
    checkEligibility,
    generateEnglish,
    generateGerman,
    renderPdf,
    generateAll,
    CV_KEYS,
    URLS: { ELIGIBILITY_URL, PDF_RENDER_URL },
};
