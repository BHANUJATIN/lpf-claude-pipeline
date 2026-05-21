/**
 * SapSheetWriterService — appends a fully-processed job row to the "SAP Jobs v2"
 * Google Sheet via a public Google Apps Script web app, no OAuth required on
 * the LPF side.
 *
 * Why this exists:
 *   The native path (Pipeline._writeSapJobToSheet → GoogleSheetsServiceV2) needs
 *   a google_sheet connection with OAuth tokens stored on lpf_connections.
 *   When the operator hasn't connected Google yet (the common case for fresh
 *   installs), the native write silently exits. This service is the fallback —
 *   it mirrors how CVGenerationService.renderPdf already POSTs to a public
 *   Apps Script URL for PDF rendering, so the operator only ever needs to do
 *   the Apps Script deploy ONCE.
 *
 * Setup (one-time, ~5 minutes — see docs/sap-sheet-apps-script.md):
 *   1. Create a Google Sheet titled "SAP Jobs v2"
 *   2. Tools → Apps Script — paste the script from sap-sheet-apps-script.md
 *   3. Deploy → New deployment → type "Web app" — Execute as "Me",
 *      Who has access "Anyone"
 *   4. Copy the exec URL
 *   5. Set env var SAP_SHEET_APPS_SCRIPT_URL=<url>  (in .env or via the Connections UI)
 *
 * Request shape:
 *   POST <url>
 *   { "row": { col1: val, col2: val, ... } }
 *
 * Response shape:
 *   { "ok": true, "row": 42, "spreadsheet_id": "...", "sheet_name": "SAP Jobs v2" }
 *   { "ok": false, "error": "..." }
 */
const axios  = require('axios');
const Logger = require('../Logger');

const logger = new Logger('SapSheetWriterService');

function getUrl() {
    return process.env.SAP_SHEET_APPS_SCRIPT_URL || process.env.SAP_SHEET_WEBHOOK_URL || null;
}

function isConfigured() { return !!getUrl(); }

/**
 * Append one job row to the SAP Jobs v2 sheet via Apps Script.
 *
 * @param {object} record  Logical-field → value map (job_id, job_title, …).
 *                         Apps Script handles column ordering on the sheet side
 *                         — it auto-creates missing header columns and appends
 *                         a new row with the keys aligned.
 * @returns {Promise<{ok: boolean, row?: number, spreadsheet_id?: string, error?: string}>}
 */
async function appendJobRow(record) {
    const url = getUrl();
    if (!url) {
        return { ok: false, error: 'SAP_SHEET_APPS_SCRIPT_URL not configured' };
    }

    try {
        const res = await axios.post(url, { row: record }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            maxRedirects: 5,
        });
        const data = res.data || {};
        if (data.ok === false) {
            return { ok: false, error: data.error || 'Apps Script returned ok=false' };
        }
        return {
            ok:             true,
            row:            data.row || null,
            spreadsheet_id: data.spreadsheet_id || null,
            sheet_name:     data.sheet_name || null,
            sheet_url:      data.sheet_url || null,
        };
    } catch (err) {
        const status = err.response?.status;
        const body   = err.response?.data;
        const detail = (body?.error || body?.message || err.message || '').toString().slice(0, 300);
        logger.warn('SAP-sheet Apps Script POST failed', { status, detail });
        return { ok: false, error: `Apps Script HTTP ${status || 'n/a'}: ${detail}` };
    }
}

module.exports = { isConfigured, appendJobRow };
