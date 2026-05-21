# SAP Jobs v2 Sheet — Apps Script setup (one-time, ~5 min)

This is the **public** Apps Script web app that LPF-Claude POSTs to when it
finishes processing a job. The script appends one row per job to your "SAP
Jobs v2" Google Sheet — no OAuth setup needed on the LPF side.

This is the same pattern already used for CV PDF rendering (see
`CVGenerationService.renderPdf` and its `PDF_RENDER_URL`).

---

## 1 — Create the sheet

1. Open <https://sheets.google.com> and create a new Spreadsheet.
2. Rename it to **`SAP Jobs v2`**.
3. Rename the first tab to **`Jobs`** (the script defaults to this — change
   `TAB_NAME` below if you pick a different one).

(Optional) Pre-add headers in row 1 — the script will auto-create them anyway
on first row, but having them upfront keeps column order tidy:

```
job_id  job_url  job_title  company_name  country  source  received_at  written_at  seniority  quality_score  ctr_fit  sap_modules  top_job_tech_comma  tech_longer  dev_or_eng  imagined_city  imagined_industry  company_url  company_linkedin_url  company_domain  city  company_hq_city  company_employee_count  imagined_nearby_city  job_poster_name  job_poster_email  job_poster_linkedin  cv_pdf_url_english  cv_pdf_url_german  cv_eligible
```

## 2 — Add the Apps Script

From inside the sheet:

1. **Extensions → Apps Script**.
2. Delete the placeholder `function myFunction() {}`.
3. Paste the entire script below.
4. Press the **save** icon (Ctrl/Cmd-S).

```js
// ──────────────────────────────────────────────────────────────────────────────
// SAP Jobs v2 — append-only writer for LPF-Claude.
//
// POST {url}/exec  with JSON body { "row": { key: value, ... } }
// → appends one row to the `TAB_NAME` sheet. Headers are auto-created for any
//   keys that don't already have a column.
// ──────────────────────────────────────────────────────────────────────────────

const TAB_NAME = 'Jobs';   // change if your tab is named differently

function doPost(e) {
  try {
    const body  = JSON.parse(e.postData?.contents || '{}');
    const row   = body.row || {};
    const keys  = Object.keys(row);
    if (!keys.length) {
      return _json({ ok: false, error: 'row body is empty' });
    }

    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(TAB_NAME) || ss.insertSheet(TAB_NAME);

    // Ensure all incoming keys have a header. New ones are appended on the right.
    let headers = [];
    if (sheet.getLastRow() === 0) {
      headers = keys.slice();
      sheet.appendRow(headers);
    } else {
      headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
        .map(String);
      const missing = keys.filter(k => !headers.includes(k));
      if (missing.length) {
        // Append missing headers starting at the next free column
        const start = headers.length + 1;
        sheet.getRange(1, start, 1, missing.length).setValues([missing]);
        headers = headers.concat(missing);
      }
    }

    // Build the row aligned to headers
    const rowOut = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      return String(v);
    });
    sheet.appendRow(rowOut);

    return _json({
      ok:             true,
      row:            sheet.getLastRow(),
      spreadsheet_id: ss.getId(),
      sheet_name:     TAB_NAME,
      sheet_url:      ss.getUrl() + '#gid=' + sheet.getSheetId(),
    });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

// Health-check GET so you can verify the URL in a browser
function doGet() {
  return _json({ ok: true, service: 'SAP Jobs v2 writer', ts: new Date().toISOString() });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## 3 — Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" → **Web app**.
3. Set:
   - **Description**: `SAP Jobs v2 writer`
   - **Execute as**: `Me (your-email@gmail.com)`
   - **Who has access**: `Anyone` *(this is what makes it public —
     the URL itself is the only credential)*
4. Click **Deploy**.
5. The first time, Google will ask you to authorise the script:
   - "Authorize access" → pick your Google account
   - "Google hasn't verified this app" → **Advanced** → **Go to (project name)** → **Allow**
6. Copy the **Web app URL** (it looks like
   `https://script.google.com/macros/s/AKfycb…/exec`).

## 4 — Wire it into LPF-Claude

Add the URL to your `.env`:

```
SAP_SHEET_APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycb…/exec
```

Or via the dashboard's Connections tab (faster — no restart needed):

```bash
curl -X POST http://localhost:3000/providers/sap-sheet/configure-apps-script \
  -H "Content-Type: application/json" \
  -d '{"url":"https://script.google.com/macros/s/AKfycb…/exec"}'
```

## 5 — Smoke-test

```bash
curl -X POST http://localhost:3000/providers/sap-sheet/test-write \
  -H "Content-Type: application/json"
```

You should see a row appear in the sheet immediately and the response:

```json
{ "ok": true, "row": 2, "sheet_name": "Jobs", "sheet_url": "https://docs.google.com/spreadsheets/d/.../edit#gid=0" }
```

From now on, every job that finishes the LPF pipeline automatically appends a
row to this sheet via the Apps Script. No further setup needed.

---

## Re-deploying after changes

Apps Script web-app URLs are **versioned**. If you edit the script:

1. **Deploy → Manage deployments** → click the pencil icon next to the active deployment.
2. Change **Version** to `New version`.
3. Click **Deploy**.

The URL stays the same, so no need to update LPF-Claude.
