/**
 * Stage 3 — Tech & SAP Extraction + Role Variables
 *
 * Incorporates 4 tested Clay LPF outbound prompts verbatim:
 *   Prompt 1 — imagined_industry         (believable industry)
 *   Prompt 2 — core_tech_list            (→ shorter_tech_comma via join(' / '))
 *   Prompt 3 — tech_names_person_type    (→ tech_short2)
 *   Prompt 4 — dev_or_engineer binary    (→ dev_or_engineer, dev_or_eng, a_dev_or_engineer)
 *
 * All other variables (sap_modules, sap_skills_comma, tech_longer,
 * comma_tech_description, shorter_tech_description*, imagined_city,
 * imagined_nearby_city, primary_tech) use the ORIGINAL tested rules — do not change.
 */
const { askJSON } = require('../../services/OpenAIService');
const Logger      = require('../../Logger');
const emitter     = require('../PipelineEmitter');
const { runCell, setCellState, emitCellState } = require('../runCell');

const logger = new Logger('Stage03_TechExtract');

function emit(type, data) {
    try { emitter.emit('event', { type, ts: Date.now(), ...data }); } catch (_) {}
}

const PRIMARY_TECH_LIST = [
    'Python', 'Java', 'Node', 'C++', 'Embedded', 'Ruby', '.NET', 'C#', 'PHP',
    'iOS', 'Golang', 'Android', 'Rust', 'AWS', 'Amazon Web Services',
    'GCP', 'Google Cloud Platform', 'Azure', 'SAP',
];

class Stage03_TechExtract {
    constructor(db) { this.db = db; }

    async run(job) {
        let result;

        await runCell({
            jobId: job.id,
            colId: 'stage3_tech_extract',
            fn: async () => {
                result = await askJSON(
                    // ── SYSTEM ──────────────────────────────────────────────────────────
                    `Ignore all previous instructions. Your job is to output ONLY the data asked for. Keep your answers short and precise, without any other social niceties that you have been programmed with. You are a researcher whose only job is to help create believable fields to be inserted into cold emails. Your tone should be succinct and efficient as if you're a person quickly typing information that's impactful. In order to save 'keystrokes' ~30% of time summarize long words to short ones e.g. Javascript to js or Ruby on Rails to Rails. With about 20% of words turn a capitalized word to an uncapitalized one (to simulate someone typing quickly).
Output ONLY valid JSON — no markdown, no extra text.`,

                    // ── USER ────────────────────────────────────────────────────────────
                    `Analyse this job posting and extract all required fields.

JOB TITLE:            ${job.job_title || '—'}
JOB LOCATION:         ${[job.city, job.country].filter(Boolean).join(', ') || '—'}
COMPANY NAME:         ${job.company_name || '—'}
COMPANY INDUSTRY:     ${job.company_industry || '—'}
COMPANY DESCRIPTION:  ${(job.company_description || '').slice(0, 1500)}
JOB DESCRIPTION:
${(job.job_description || '').slice(0, 3500)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIELD-LEVEL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

── imagined_industry  [PROMPT 1 — verbatim] ────────────
We are emailing a company about their job post, saying that we have an ideal candidate that matches their industry. The match should be believable--it shouldn't be _too_ focused in on their exact industry or niche, but it should be specific enough that the overlap will be useful and unique to them as an employer. Please return only ONE industry, not a compound industry like "civic and social organizations". The industry should never be specific enough to use an "and".

E.g. instead of "Digital Media and Entertainment" return "entertainment" (entertainment is more specific, but not too specific)
E.g. instead of "Legal tech software development" say "legal" since it's still quite specific, but believably specific.

SAP is not an industry, if the result you come to is just SAP, replace it with SAP consultancy.

When figuring out what their industry is, use the following 2 inputs, in descending order of importance:
1. Company description (COMPANY DESCRIPTION above)
2. Company industry (COMPANY INDUSTRY above)

The returned industry should fit perfectly in the following statement:
"Has previously worked on a project in <believable industry> industry"
Don't return the entire sentence, return only the <believable industry>. Ensure that the value of <believable industry> makes the above mentioned sentence sound proper as per English language rules.
Don't make the industry too generic like technology, software, or internet.
if the name of the industry is an abbreviation of the full industry name (such as IT, SAP, CRM, AI, etc.), then please make the industry name all uppercase else please make the industry name all lowercase.

── core_tech_list + related_tech_list  [PROMPT 2 — verbatim] ────────────
We are emailing a company about their job post, saying that we have an ideal developer or SAP consultant who has experience in important technologies or SAP modules needed to do this job. Please choose 1-3 technologies or SAP Modules that represent the core tech needed for this job post. Don't include the words "engineer" or anything else, only the technology. Let's call these 1-3 technologies CORE_LIST. Only include up to 3 technologies on this list if they are truly core. Only 3 or 2 are truly core, only include those in CORE_LIST.

For CORE_LIST:
1. The tech combo should be specific enough to spark interest in the candidate, thinking that they could be a great fit, without the recipient believing it is so specific as to be made up.
2. Use acronyms to shorten any tech, as this signals we're not just mail merging. E.g.: NodeJS -> Node, Kubernetes -> K8, Ruby on Rails -> Rails, JavaScript -> js, Ember.js -> Ember
3. If the framework (like Django) implies the underlying language (Python), don't list the underlying language (Python) in the output.
4. If the framework has a *.js at the end of it, don't include the ".js".
6. Focus on trying to find the SAP modules these are usually two or three letter acronyms but also might be tech such as Basis, Successfactors S/4hana
5. Finally, if any of the following technologies are in the CORE_LIST, please put them first: (none specified)

Once you have the CORE_LIST of 1-3 technologies, please create a RELATED_TECH_LIST using tech from the job description to show that the candidate has relevant experience. The tech combo should be specific enough to spark interest in the candidate, thinking that they could be a great fit, without the recipient believing it is so specific as to be made up. If there are no specific technologies mentioned in the job post, please don't add anything additional to the RELATED_TECH_LIST.

Please never leave the core_tech_list empty; if the job post doesn't have relevant technologies, please include relevant skills as a last resort. If job skills are mentioned in a language other than English, please translate them to English unless you're uncertain--then leave them in original language.

── tech_short2  [PROMPT 3 — verbatim] ────────────
I will give you a list of technologies as INPUT1 (= core_tech_list from above) and a job title as INPUT2 (= JOB TITLE above). You need to combine them in order to output text in the form of "[technologies] [type of person]".

For INPUT1:
1. Use a maximum of 2 technologies / SAP modules in the output and DO NOT exceed that.
2. Make sure that the capitalization of the technologies in the output is the standard and most common way it is written.

For INPUT2:
1. If the original text says consultant (or the equivalent word in the non-English language), use consultant in the output. If it says engineer (or the equivalent word in the non-English language), use engineer in the output. If it says developer (or the equivalent word in the non-English language), use developer in the output. For example, convert Berater and Beraterin to consultant.
2. Abbreviate developer as "dev.", engineer as "eng.", etc.
3. ALWAYS use lowercase for this portion of the output, i.e., "dev.", "eng.", etc.

Overall:
1. Often times people add unnecessary information to INPUT2 that should be deleted.
2. Incorporate the word Senior, Principal, or Lead in the output if present in INPUT2. It should always preceed the word "consultant", "developer" or "engineer", etc.
3. DO NOT include quotation marks ("") in the output.
4. In case of any issues with processing INPUT1, return the entire input text itself.
5. If it is a SAP position try and include one the primary one or two SAP modules you think they are looking for, for example SAP FI/CO consultant.
6. Do not place the technology ERP in your output.
7. Do not repeat any of the technologies more than once.

── dev_or_engineer  [PROMPT 4 — verbatim] ────────────
Based on the following input (JOB TITLE above), is the person more an engineer or more a developer? The only acceptable output is one fully-lowercase word: either engineer or developer.
Note: inputs with 'SAP' should be 'engineer'.
Output can only be 'developer' or 'engineer'.
Then set a_dev_or_engineer to "a developer" or "an engineer" accordingly.

── SAP + tech fields  [ORIGINAL TESTED RULES — do not change] ────────────
- sap_modules: comma-separated SAP modules/areas (e.g. SD, FI, CO, MM, HANA, S/4HANA, ABAP, BW, SuccessFactors)
- sap_skills_comma: broader SAP skill list including process areas (O2C, OTC, GTS, EDI etc.)
- tech_short: single most important abbreviation (e.g. "SD" for SAP SD, "ABAP" for ABAP developer)
- tech_compressed: no-spaces version (e.g. "SAPSD")
- tech_longer: full descriptive name (e.g. "SAP Sales and Distribution")
- shorter_tech_description: slightly fuller abbreviation (e.g. "SAP SD")
- shorter_tech_description_scrambled: slight variation — different ordering or phrasing to avoid identical-looking emails (e.g. "S/4HANA SD" when shorter_tech_description is "SAP SD")
- comma_tech_description: comma list of 3–4 FULL tech descriptions without abbreviations
- imagined_city: a believable DACH city where a candidate for this role might be based; use the job city if given, otherwise pick a plausible German/Austrian/Swiss city for this role type
- imagined_nearby_city: a DIFFERENT DACH city within ~100 km of imagined_city
- primary_tech: highest-level tech from this list: ${PRIMARY_TECH_LIST.join(', ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return this exact JSON structure:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "imagined_industry": "automotive",
  "core_tech_list": ["FI", "CO", "S/4HANA"],
  "related_tech_list": ["ABAP", "Fiori"],
  "tech_short2": "FI/CO consultant",
  "dev_or_engineer": "engineer",
  "a_dev_or_engineer": "an engineer",
  "sap_modules": "FI, CO, S/4HANA",
  "sap_skills_comma": "FI, CO, S/4HANA, ABAP, O2C",
  "tech_short": "FI",
  "tech_compressed": "FICO",
  "tech_longer": "SAP Finance and Controlling",
  "shorter_tech_description": "SAP FI/CO",
  "shorter_tech_description_scrambled": "S/4HANA FI/CO",
  "comma_tech_description": "SAP Finance, Controlling, S/4HANA",
  "primary_tech": "SAP",
  "imagined_city": "Munich",
  "imagined_nearby_city": "Stuttgart",
  "reasoning": "brief explanation of choices"
}`,
                    'gpt-4o-mini',
                    { jobId: job.id, operation: 'stage3_tech_extract' }
                );
                return result.tech_short2 || result.sap_modules || 'ok';
            }
        });

        if (!result) return { rejected: false, message: 'Tech extraction failed — no AI result', fields: {} };

        // ── Compute derived fields from Prompt 2 output ─────────────────────────
        const coreList    = Array.isArray(result.core_tech_list)    ? result.core_tech_list    : [];
        const relatedList = Array.isArray(result.related_tech_list) ? result.related_tech_list : [];

        const toSlash = str => str ? str.split(/\s*,\s*/).filter(Boolean).join(' / ') : '';

        // "Top job Tech - short+spaced" = core only, joined with " / "
        const techShortSpaced = coreList.length >= 1 ? coreList.join(' / ') : '';

        // "Tech - short+compressed" = core only, no spaces between slashes
        const techCompressedFromList = coreList.length >= 1 ? coreList.join('/') : (result.tech_compressed || '');

        // "Top job Tech - Longer" = core/related (first 2) formula
        const techLongerFromList = coreList.length >= 1
            ? coreList.join('/') + (relatedList.length > 0 ? '/' + relatedList.slice(0, 2).join(' /') : '')
            : '';

        // top_job_tech_comma = core only (spaced) — was incorrectly core+related before
        const topJobTechComma = techShortSpaced || toSlash(result.top_job_tech_comma) || '';

        const sapModules     = toSlash(result.sap_modules);
        const sapSkillsComma = result.sap_skills_comma || '';

        const shortTechDesc      = toSlash(result.shorter_tech_description)          || result.shorter_tech_description          || null;
        const shortTechScrambled = toSlash(result.shorter_tech_description_scrambled) || result.shorter_tech_description_scrambled || null;
        // Keep AI-generated tech_longer for email descriptions (full name like "SAP Finance and Controlling")
        const techLonger         = toSlash(result.tech_longer)                        || result.tech_longer                        || techLongerFromList || null;

        const devOrEngineer  = this._binaryRole(result.dev_or_engineer);
        const aDevOrEngineer = devOrEngineer === 'engineer' ? 'an engineer' : 'a developer';

        logger.debug('Tech extracted', {
            job_id:   job.id,
            modules:  sapModules,
            core:     topJobTechComma,
            short2:   result.tech_short2,
            role:     devOrEngineer,
            industry: result.imagined_industry,
        });

        // ── Set per-cell states for the remaining stage3 columns ─────────────
        try {
            await setCellState(job.id, 'stage3_sap_modules', sapModules ? 'success' : 'success_empty', { value: sapModules || null });
            emitCellState(job.id, 'stage3_sap_modules', sapModules ? 'success' : 'success_empty', { value: sapModules || null });

            const cityIndustry = [result.imagined_city, result.imagined_industry].filter(Boolean).join(' / ') || null;
            await setCellState(job.id, 'stage3_city_industry', cityIndustry ? 'success' : 'success_empty', { value: cityIndustry });
            emitCellState(job.id, 'stage3_city_industry', cityIndustry ? 'success' : 'success_empty', { value: cityIndustry });

            await setCellState(job.id, 'stage3_tech_comma', topJobTechComma ? 'success' : 'success_empty', { value: topJobTechComma || null });
            emitCellState(job.id, 'stage3_tech_comma', topJobTechComma ? 'success' : 'success_empty', { value: topJobTechComma || null });
        } catch (_) {}

        emit('field_done', { job_id: job.id, field: 'sap_modules',          value: sapModules || '—' });
        emit('field_done', { job_id: job.id, field: 'tech_short',            value: result.tech_short || '—' });
        emit('field_done', { job_id: job.id, field: 'dev_or_eng',            value: devOrEngineer });
        emit('field_done', { job_id: job.id, field: 'imagined_city',         value: result.imagined_city || '—' });
        emit('field_done', { job_id: job.id, field: 'imagined_nearby_city',  value: result.imagined_nearby_city || '—' });
        emit('field_done', { job_id: job.id, field: 'imagined_industry',     value: result.imagined_industry || '—' });
        emit('field_done', { job_id: job.id, field: 'shorter_tech_comma',    value: topJobTechComma });

        return {
            rejected: false,
            message:  `Tech: ${topJobTechComma} | ${devOrEngineer} | ${result.imagined_industry}`,
            summary:  {
                modules:  sapModules,
                core:     topJobTechComma,
                short2:   result.tech_short2,
                role:     devOrEngineer,
                industry: result.imagined_industry,
            },
            fields: {
                // Core-only spaced — "FI / CO / S/4HANA"
                shorter_tech_comma:                 topJobTechComma               || null,
                top_job_tech_comma:                 topJobTechComma               || null,
                // Core-only no-spaces — "FI/CO/S/4HANA"
                tech_compressed:                    techCompressedFromList        || result.tech_compressed || null,
                // Core + first 2 related — "FI/CO/ ABAP/ Fiori"
                tech_longer_abbrev:                 techLongerFromList            || null,
                // AI-generated full description — "SAP Finance and Controlling"
                tech_longer:                        techLonger,
                // Used in longer_tech_description email variable
                comma_tech_description:             topJobTechComma               || null,
                tech_short2:                        result.tech_short2            || null,
                dev_or_engineer:                    devOrEngineer,
                dev_or_eng:                         devOrEngineer,
                a_dev_or_engineer:                  aDevOrEngineer,
                imagined_industry:                  result.imagined_industry      || null,
                sap_modules:                        sapModules                    || null,
                sap_skills_comma:                   sapSkillsComma                || null,
                tech_combined:                      result.tech_combined          || null,
                tech_short:                         result.tech_short             || null,
                primary_tech:                       result.primary_tech           || 'SAP',
                shorter_tech_description:           shortTechDesc                 || result.tech_short2 || null,
                shorter_tech_description_scrambled: shortTechScrambled            || null,
                imagined_city:                      result.imagined_city          || null,
                imagined_nearby_city:               result.imagined_nearby_city   || null,
            },
            logData: { ...result, core_tech_list: coreList, related_tech_list: relatedList },
        };
    }

    _binaryRole(raw) {
        if (!raw) return 'engineer';
        const r = raw.toLowerCase().trim();
        if (r === 'developer' || r === 'dev' || r.startsWith('dev')) return 'developer';
        return 'engineer';
    }
}

module.exports = Stage03_TechExtract;
