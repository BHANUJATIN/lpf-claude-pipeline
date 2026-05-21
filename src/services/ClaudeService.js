const Anthropic = require('@anthropic-ai/sdk');
const Logger = require('../Logger');

const logger = new Logger('ClaudeService');

// CTR primary tech list (from JPE knowledge)
const PRIMARY_TECH = [
    'Python', 'Java', 'Node', 'C++', 'Embedded', 'Ruby', '.NET', 'C#', 'PHP',
    'iOS', 'Golang', 'Android', 'Rust', 'AWS', 'Amazon Web Services',
    'GCP', 'Google Cloud Platform', 'Azure', 'SAP',
];

// SAP modules that CTR recruits for
const SAP_MODULES = [
    'SAP SD', 'SAP FI', 'SAP CO', 'SAP MM', 'SAP PP', 'SAP HR', 'SAP HCM',
    'SAP BW', 'SAP BI', 'SAP HANA', 'SAP S/4HANA', 'SAP ECC', 'SAP ERP',
    'SAP BASIS', 'ABAP', 'SAP PM', 'SAP QM', 'SAP PS', 'SAP WM', 'SAP EWM',
    'SAP TM', 'SAP GTS', 'SAP SuccessFactors', 'SAP Ariba', 'SAP IBP',
    'SAP BTP', 'Fiori', 'SAP CRM', 'SAP SRM', 'SAP MDG',
    'GTS', 'EDI', 'O2C', 'OTC', 'Order to Cash', 'Order-to-Cash', 'Global Trade',
];

class ClaudeService {
    constructor() {
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY is not set in .env');
        }
        this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        this.model = 'claude-sonnet-4-6';
    }

    /**
     * Analyse a single job posting.
     * Returns a structured result object.
     */
    async analyseJob(job) {
        const prompt = this._buildAnalysisPrompt(job);

        logger.debug('Sending job to Claude', { job_id: job.id, title: job.job_title });

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: 1024,
            system: `You are a recruitment analyst for Core Tech Recruitment (CTR), a firm specialising in SAP and technology roles in the DACH region (Germany, Austria, Switzerland).
Your task is to evaluate job postings and determine their suitability for CTR's talent pipeline.
Always respond with valid JSON only — no markdown, no explanation outside the JSON block.`,
            messages: [{ role: 'user', content: prompt }],
        });

        const raw = response.content[0].text.trim();
        const result = this._parseResponse(raw, job);

        logger.info('Claude analysis complete', {
            job_id:        job.id,
            is_sap:        result.is_sap,
            quality_score: result.quality_score,
            modules:       result.sap_modules?.join(', ') || 'none',
        });

        return result;
    }

    /**
     * Batch analyse all provided jobs.
     * Returns array of { job, result } pairs.
     */
    async analyseJobs(jobs) {
        const results = [];
        for (const job of jobs) {
            try {
                const result = await this.analyseJob(job);
                results.push({ job, result, error: null });
            } catch (err) {
                logger.error('Claude analysis failed for job', { job_id: job.id, error: err.message });
                results.push({ job, result: null, error: err.message });
            }
        }
        return results;
    }

    _buildAnalysisPrompt(job) {
        return `Evaluate this job posting for CTR's SAP recruitment pipeline.

JOB TITLE: ${job.job_title || 'Unknown'}
COMPANY: ${job.company_name || job.company_url || 'Unknown'}
LOCATION: ${[job.city, job.country].filter(Boolean).join(', ') || 'Unknown'}
SOURCE: ${job.source || 'Unknown'}
SAP TECH (pre-classified): ${job.sap_tech || 'none'}
SEARCH TERM: ${job.search_term || 'none'}

JOB DESCRIPTION:
${(job.job_description || '').slice(0, 4000)}

---
SAP MODULES WE RECRUIT FOR:
${SAP_MODULES.join(', ')}

PRIMARY TECH WE COVER:
${PRIMARY_TECH.join(', ')}

Respond with this exact JSON structure:
{
  "is_sap": true/false,
  "quality_score": 1-10,
  "seniority": "junior" | "mid" | "senior" | "unknown",
  "sap_modules": ["SAP SD", "SAP FI", ...],
  "primary_tech": ["SAP", "Python", ...],
  "is_direct_employer": true/false,
  "dach_confirmed": true/false,
  "summary": "One sentence: role + key SAP module + seniority + company type",
  "ctr_fit": "high" | "medium" | "low" | "none",
  "reasoning": "2-3 sentences on why this fits or doesn't fit CTR's pipeline"
}

Scoring guide for quality_score:
- 8-10: Senior SAP role, direct employer, DACH, clear module (e.g. SAP SD Consultant)
- 5-7: Mid SAP role or indirect signal, or recruiter job
- 3-4: Weak SAP match or outside DACH
- 1-2: Not SAP, or outside CTR scope`;
    }

    _parseResponse(raw, job) {
        try {
            // Strip markdown code fences if model added them
            const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
            const parsed = JSON.parse(cleaned);

            return {
                is_sap:        Boolean(parsed.is_sap),
                quality_score: Math.min(10, Math.max(1, parseInt(parsed.quality_score) || 5)),
                seniority:     parsed.seniority || 'unknown',
                sap_modules:   Array.isArray(parsed.sap_modules) ? parsed.sap_modules : [],
                primary_tech:  Array.isArray(parsed.primary_tech) ? parsed.primary_tech : [],
                is_direct_employer: Boolean(parsed.is_direct_employer),
                dach_confirmed:     Boolean(parsed.dach_confirmed),
                summary:       parsed.summary || '',
                ctr_fit:       parsed.ctr_fit || 'none',
                reasoning:     parsed.reasoning || '',
                raw_response:  raw,
            };
        } catch (err) {
            logger.warn('Failed to parse Claude JSON response — using fallback', {
                job_id: job.id,
                raw: raw.slice(0, 200),
            });
            return {
                is_sap:        false,
                quality_score: 1,
                seniority:     'unknown',
                sap_modules:   [],
                primary_tech:  [],
                is_direct_employer: false,
                dach_confirmed:     false,
                summary:       'Parse error — manual review needed',
                ctr_fit:       'none',
                reasoning:     'Claude response could not be parsed',
                raw_response:  raw,
            };
        }
    }
}

module.exports = ClaudeService;
