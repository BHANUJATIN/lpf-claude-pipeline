/**
 * CVPdfService — renders a generated CV (plain/markdown-flavoured text) into a styled PDF.
 *
 * Uses pdfkit (pure-Node, no Chromium). The renderer recognises a small markdown subset
 * actually produced by the CV prompts in CVGenerationService:
 *
 *   **bold inline**           → bold run inside a normal paragraph
 *   ### Section / ## Section  → section heading (bigger, bold)
 *   - bullet text             → indented bullet
 *   • bullet text             → same
 *   numbered: "1. " / "1) "   → numbered list item
 *   blank line                → paragraph break
 *
 * All other lines render as a paragraph. The output is intentionally simple so the
 * recruiter can attach it directly to outbound emails or upload to Google Docs.
 */
const PDFDocument = require('pdfkit');

const FONT_REG   = 'Helvetica';
const FONT_BOLD  = 'Helvetica-Bold';
const FONT_ITAL  = 'Helvetica-Oblique';

const VARIANT_LABEL = {
    english:     'English CV (Master)',
    english_v2:  'English CV (Variant 2)',
    german:      'Deutsch CV',
};

/**
 * Returns a pdfkit document ready to be piped to a response.
 *   const doc = renderCvToPdf({ text, variant, jobTitle, companyName });
 *   doc.pipe(res);
 *
 * Caller MUST pipe the returned document — it has not been .end()'d yet.
 * (Actually we DO call .end() inside; we return after end so pdfkit flushes.)
 */
function renderCvToPdf({ text, variant = 'english', jobTitle = '', companyName = '' }) {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 56, bottom: 56, left: 56, right: 56 },
        info: {
            Title:    `CV — ${jobTitle || 'SAP Consultant'}`,
            Author:   'CTR Recruitment',
            Subject:  VARIANT_LABEL[variant] || 'CV',
            Keywords: 'SAP, consultant, candidate, redacted',
        },
    });

    _renderHeader(doc, { variant, jobTitle, companyName });
    _renderBody(doc, text || '');
    _renderFooter(doc);

    doc.end();
    return doc;
}

function _renderHeader(doc, { variant, jobTitle, companyName }) {
    const label = VARIANT_LABEL[variant] || 'CV';
    // Brand strip
    doc.save();
    doc.rect(0, 0, doc.page.width, 28).fill('#0f1f3a');
    doc.fillColor('#ffffff').font(FONT_BOLD).fontSize(10)
       .text('CTR — Candidate Profile', 56, 9, { lineBreak: false });
    doc.fillColor('#9bb2d4').font(FONT_REG).fontSize(9)
       .text(label, 0, 9, { width: doc.page.width - 56, align: 'right', lineBreak: false });
    doc.restore();

    // Title line under brand strip
    doc.moveDown(2.2);
    if (jobTitle) {
        doc.fillColor('#0f1f3a').font(FONT_BOLD).fontSize(13)
           .text(jobTitle, { continued: !!companyName });
        if (companyName) {
            doc.font(FONT_REG).fontSize(11).fillColor('#444')
               .text(`  ·  ${companyName}`);
        }
    }
    doc.moveDown(0.6);
    doc.strokeColor('#d0d6df').lineWidth(0.5)
       .moveTo(doc.x, doc.y).lineTo(doc.page.width - 56, doc.y).stroke();
    doc.moveDown(0.7);
}

function _renderFooter(doc) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const y = doc.page.height - 32;
        doc.fillColor('#888').font(FONT_ITAL).fontSize(8)
           .text('Generated from CTR LPF pipeline — redacted candidate profile · ' +
                 `Page ${i - range.start + 1} of ${range.count}`,
                 56, y, { width: doc.page.width - 112, align: 'center', lineBreak: false });
    }
}

function _renderBody(doc, text) {
    const lines = text.split(/\r?\n/);

    doc.fillColor('#1a1a1a').font(FONT_REG).fontSize(10.5);

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');

        // Blank line → paragraph break
        if (!line.trim()) { doc.moveDown(0.45); continue; }

        // ── Heading: "### Section"
        const heading = line.match(/^(#{2,4})\s+(.+)$/);
        if (heading) {
            const level = heading[1].length;
            const size  = level === 2 ? 14 : level === 3 ? 12 : 11;
            doc.moveDown(0.5);
            doc.fillColor('#0f1f3a').font(FONT_BOLD).fontSize(size).text(heading[2].trim());
            doc.fillColor('#1a1a1a').font(FONT_REG).fontSize(10.5);
            doc.moveDown(0.15);
            continue;
        }

        // ── Bullet: "- text" / "• text" / "* text"
        const bullet = line.match(/^\s*[\-•\*]\s+(.+)$/);
        if (bullet) {
            doc.font(FONT_REG).fontSize(10.5).fillColor('#1a1a1a');
            const indent = 14;
            const x = doc.x;
            doc.text('• ', x, doc.y, { continued: true, indent: 0 });
            _renderInline(doc, bullet[1].trim(), { indent });
            continue;
        }

        // ── Numbered: "1. text" / "1) text"
        const numbered = line.match(/^\s*(\d+)[\.\)]\s+(.+)$/);
        if (numbered) {
            doc.font(FONT_REG).fontSize(10.5).fillColor('#1a1a1a');
            doc.text(`${numbered[1]}. `, { continued: true });
            _renderInline(doc, numbered[2].trim());
            continue;
        }

        // ── Plain paragraph (with inline bold support)
        _renderInline(doc, line);
    }
}

/**
 * Renders a string with **bold** runs into the current paragraph and finishes it
 * with a newline. Doesn't try to be a full markdown parser — only bold + italic.
 */
function _renderInline(doc, text, opts = {}) {
    const segments = _splitInlineFormatting(text);
    segments.forEach((seg, i) => {
        const isLast = i === segments.length - 1;
        if (seg.kind === 'bold')      doc.font(FONT_BOLD);
        else if (seg.kind === 'ital') doc.font(FONT_ITAL);
        else                          doc.font(FONT_REG);
        doc.text(seg.text, { continued: !isLast, indent: opts.indent || 0 });
    });
    // Restore regular font for subsequent paragraphs
    doc.font(FONT_REG);
}

function _splitInlineFormatting(text) {
    // Recognise **bold**, __bold__, *italic*, _italic_
    const out = [];
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        const m = rest.match(/^(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/);
        if (m) {
            const bold = m[2] || m[3];
            const ital = m[4] || m[5];
            out.push({ kind: bold ? 'bold' : 'ital', text: bold || ital });
            i += m[0].length;
        } else {
            // Take everything up to the next formatter or end of string
            const next = rest.slice(1).search(/(\*\*|__|\*|_)/);
            const chunkLen = next === -1 ? rest.length : next + 1;
            out.push({ kind: 'plain', text: rest.slice(0, chunkLen) });
            i += chunkLen;
        }
    }
    return out.length ? out : [{ kind: 'plain', text }];
}

module.exports = { renderCvToPdf };
