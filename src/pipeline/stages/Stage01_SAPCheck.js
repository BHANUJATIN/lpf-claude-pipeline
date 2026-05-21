const { askJSON } = require('../../services/OpenAIService');
const Logger      = require('../../Logger');
const emitter     = require('../PipelineEmitter');
const { runCell, setCellState, emitCellState } = require('../runCell');

const logger = new Logger('Stage01_SAPCheck');

const DACH_COUNTRIES = [
    'germany', 'deutschland', 'austria', 'österreich', 'schweiz', 'switzerland',
    'de', 'at', 'ch',
];

const RECRUITER_SIGNALS = ['my client', 'our client', 'staffing', 'recruiting agency', 'recruitment agency', 'personalvermittlung'];

// Titles that indicate non-SAP / non-target roles — reject without AI call
const TITLE_EXCLUSIONS = [
    'business dev', 'product manager', 'analyst', 'product owner',
    'network security', 'test engineer', 'helpdesk', 'support', 'qa',
    'junior', 'student', 'werkstudent', 'electrical', 'intern',
    'praktikum', 'internship',
];

// Keywords that confirm SAP relevance directly in title — skip AI SAP check if matched
const SAP_KEYWORDS = [
    'sap', 'berater', 'beraterin', 's4hana', 's4/hana', 'hana',
    's4', 's/4', 's/4hana', 'abap', 'entwickler', 'erp',
    'entwicklerin', 'ewm', 'hcm', 'successfactor',
];

function emit(type, data) {
    try { emitter.emit('event', { type, ts: Date.now(), ...data }); } catch (_) {}
}

class Stage01_SAPCheck {
    constructor(db) { this.db = db; }

    async run(job) {
        // ── DACH check ───────────────────────────────────────────────────────
        const isDach = this._checkDACH(job.country);
        try {
            const dachState = isDach ? 'success' : 'condition_not_met';
            await setCellState(job.id, 'stage1_dach', dachState, { value: job.country || null });
            emitCellState(job.id, 'stage1_dach', dachState, { value: job.country || null });
        } catch (_) {}

        if (!isDach) {
            return { rejected: true, reason: `Not DACH: country="${job.country}"` };
        }

        // ── Title exclusion check (fast reject — no AI needed) ───────────────
        const exclusionHit = this._checkTitleExclusions(job.job_title);
        if (exclusionHit) {
            return { rejected: true, reason: `Title excluded: "${exclusionHit}" in "${job.job_title}"` };
        }

        // ── SAP keyword check in title ────────────────────────────────────────
        // If SAP keyword found → skip AI SAP check, run quality AI only.
        // If not found → run full AI check (B2.0) to determine if SAP.
        const sapKeywordMatch = this._checkSAPKeyword(job.job_title);
        logger.debug('SAP keyword check', { job_id: job.id, title: job.job_title, match: sapKeywordMatch || 'none' });

        // ── Recruiter check ──────────────────────────────────────────────────
        const isRecruiter = this._checkRecruiter(job.job_description);
        try {
            const directState = isRecruiter ? 'condition_not_met' : 'success';
            await setCellState(job.id, 'stage1_direct', directState, { value: isRecruiter ? 'agency signal' : 'direct' });
            emitCellState(job.id, 'stage1_direct', directState, { value: isRecruiter ? 'agency signal' : 'direct' });
        } catch (_) {}

        if (isRecruiter) {
            return { rejected: true, reason: 'Recruitment agency signal in description' };
        }

        // ── Company dedup check — 30-day cooldown window ─────────────────────
        // Operator rule: same company can be processed again after the cooldown
        // window expires (default 30 days). DatabaseService.getProcessedJobForCompany
        // already filters by `received_at > NOW() - 30 days`. Pass `job.id` so
        // re-running the same job doesn't match against itself.
        const existing = await this.db.getProcessedJobForCompany(
            job.company_url, job.company_name, job.country, job.id
        );
        if (existing) {
            const cooldownDays = parseInt(process.env.COMPANY_COOLDOWN_DAYS || '30', 10);
            try {
                await setCellState(job.id, 'stage1_direct', 'condition_not_met', { value: `dup job #${existing.id}` });
                emitCellState(job.id, 'stage1_direct', 'condition_not_met', { value: `dup job #${existing.id}` });
            } catch (_) {}
            const recvAt = existing.received_at ? new Date(existing.received_at) : null;
            const ageDays = recvAt ? Math.floor((Date.now() - recvAt.getTime()) / 86_400_000) : '?';
            return {
                rejected: true,
                reason: `Company in cooldown — already processed job #${existing.id} ${ageDays}d ago (cooldown=${cooldownDays}d). Will be eligible again after ${cooldownDays - ageDays}d.`,
            };
        }

        // ── AI classification ─────────────────────────────────────────────────
        // If SAP keyword found in title → AI only rates quality (is_sap assumed true).
        // If no keyword → full AI check including SAP determination (B2.0 mode).
        let ai;
        await runCell({
            jobId: job.id,
            colId: 'stage1_sap_check',
            fn: async () => {
                if (sapKeywordMatch) {
                    // Lightweight quality + seniority prompt — SAP already confirmed by keyword
                    ai = await askJSON(
                        `You are a recruitment analyst for Core Tech Recruitment (CTR), specialising in SAP and technology roles in DACH.
Output ONLY valid JSON — no markdown.`,
                        `This is a confirmed SAP job (keyword "${sapKeywordMatch}" in title). Rate its quality and fit.
Output:
{
  "is_sap": true,
  "is_direct_employer": true/false,
  "quality_score": 1-10,
  "seniority": "junior"|"mid"|"senior"|"unknown",
  "ctr_fit": "high"|"medium"|"low"|"none",
  "reasoning": "1-2 sentences"
}

Scoring guide:
- 8-10: Senior SAP role, direct employer, clear module in title
- 5-7: Mid SAP or indirect signal
- 3-4: Weak match
- 1-2: Irrelevant

JOB TITLE: ${job.job_title || '—'}
COMPANY: ${job.company_name || job.company_url || '—'}
COUNTRY: ${job.country || '—'}
DESCRIPTION (first 2000 chars):
${(job.job_description || '').slice(0, 2000)}`,
                        'gpt-4o-mini',
                        { jobId: job.id, operation: 'stage1_sap_check_confirmed' }
                    );
                    return ai.quality_score != null ? String(ai.quality_score) : 'ok';
                } else {
                    // Full SAP determination (isSAP B2.0) — keyword not found in title
                    ai = await askJSON(
                        `You are a recruitment analyst for Core Tech Recruitment (CTR), specialising in SAP and technology roles in DACH.
Output ONLY valid JSON — no markdown.`,
                        `Analyse this job posting and output a JSON object with the following fields:
{
  "is_sap": true/false,
  "is_direct_employer": true/false,
  "is_dach_confirmed": true/false,
  "quality_score": 1-10,
  "seniority": "junior"|"mid"|"senior"|"unknown",
  "ctr_fit": "high"|"medium"|"low"|"none",
  "rejection_reason": null or short reason string if not fit,
  "reasoning": "1-2 sentences"
}

Scoring guide:
- 8-10: Senior SAP role, direct employer, clear module in title, DACH confirmed
- 5-7: Mid SAP or indirect signal
- 3-4: Weak SAP match
- 1-2: Not SAP

JOB TITLE: ${job.job_title || '—'}
COMPANY: ${job.company_name || job.company_url || '—'}
COUNTRY: ${job.country || '—'}
SOURCE: ${job.source || '—'}
DESCRIPTION (first 3000 chars):
${(job.job_description || '').slice(0, 3000)}`,
                        'gpt-4o-mini',
                        { jobId: job.id, operation: 'stage1_sap_check_full' }
                    );
                    return ai.is_sap ? 'true' : 'false';
                }
            }
        });

        if (!ai) return { rejected: true, reason: 'AI SAP check failed — no result' };

        logger.debug('SAP check result', { job_id: job.id, is_sap: ai.is_sap, score: ai.quality_score, keyword: sapKeywordMatch || null });

        // ── Set score + fit cells from AI result ─────────────────────────────
        try {
            const scoreStr = ai.quality_score != null ? String(ai.quality_score) : null;
            await setCellState(job.id, 'stage1_score', scoreStr ? 'success' : 'success_empty', { value: scoreStr });
            emitCellState(job.id, 'stage1_score', scoreStr ? 'success' : 'success_empty', { value: scoreStr });

            const fitStr = ai.ctr_fit || null;
            await setCellState(job.id, 'stage1_fit', fitStr ? 'success' : 'success_empty', { value: fitStr });
            emitCellState(job.id, 'stage1_fit', fitStr ? 'success' : 'success_empty', { value: fitStr });
        } catch (_) {}

        if (!ai.is_sap) {
            return { rejected: true, reason: ai.rejection_reason || 'AI: not a SAP job' };
        }

        if (!ai.is_direct_employer) {
            return { rejected: true, reason: 'AI: company is a recruitment agency' };
        }

        const minScore = parseInt(process.env.MIN_QUALITY_SCORE || '5');
        if (ai.quality_score < minScore) {
            return { rejected: true, reason: `Quality score ${ai.quality_score} below threshold ${minScore}` };
        }

        return {
            rejected: false,
            message:  `SAP confirmed (${sapKeywordMatch ? `keyword: ${sapKeywordMatch}` : 'AI'}), score=${ai.quality_score}, fit=${ai.ctr_fit}`,
            summary:  { score: ai.quality_score, fit: ai.ctr_fit, seniority: ai.seniority, sap_by_keyword: !!sapKeywordMatch },
            fields: {
                is_sap:             true,
                is_dach:            true,
                is_direct_employer: ai.is_direct_employer,
                quality_score:      ai.quality_score,
                seniority:          ai.seniority,
                ctr_fit:            ai.ctr_fit,
            },
            logData: { ...ai, sap_keyword_match: sapKeywordMatch || null },
        };
    }

    _checkDACH(country) {
        if (!country) return false;
        const c = country.toLowerCase().trim();
        return DACH_COUNTRIES.some(d => c.includes(d));
    }

    _checkRecruiter(description) {
        if (!description) return false;
        const d = description.toLowerCase();
        return RECRUITER_SIGNALS.some(s => d.includes(s));
    }

    // Returns the matched exclusion word if title should be rejected, null otherwise
    _checkTitleExclusions(title) {
        if (!title) return null;
        const t = title.toLowerCase();
        return TITLE_EXCLUSIONS.find(word => t.includes(word)) || null;
    }

    // Returns the matched SAP keyword if found in title, null otherwise
    _checkSAPKeyword(title) {
        if (!title) return null;
        const t = title.toLowerCase();
        return SAP_KEYWORDS.find(kw => t.includes(kw)) || null;
    }
}

module.exports = Stage01_SAPCheck;
