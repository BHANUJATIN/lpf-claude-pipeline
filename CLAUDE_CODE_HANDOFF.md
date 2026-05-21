# LPF-Claude — Claude Code Handoff

> **Pick this up from where the previous Cowork session left off.**
> **First action:** read this file end-to-end before touching anything. Then read `RECOVERY_AND_PATCHES.md` and `../ClaudeworkspaceCTR/CTR/LPF_UI_CORRECTION_v2.md` for additional context. Do **not** start coding until you've answered the open questions in §10.

---

## 0. What this project is

`claude-jpe` (this repo) is a local Node.js + Express + PostgreSQL replica of the **Clay LPF-DACH workbook** for **Core Tech Recruitment** (an SAP-focused recruitment agency in DACH). The server at `http://localhost:3000` serves a single-page UI (`public/index.html`, ~3290 lines originally) that drives a 7-stage pipeline:

```
received → stage1_sap → stage2_company → stage3_tech → stage4_people →
stage5_enrich → stage6_poster → stage7_ai_search → review → stage8_send → completed
```

Each stage maps to one Clay column-group; cell-level state is tracked in `lpf_cell_state` and `lpf_cell_runs` for a Clay-style "every cell has a state, retry, and history" UX.

Owner mindset: this pipeline runs the agency's outbound. A miscategorized job, a silently-failed enrichment, or a "stuck running" indicator costs placements. Every defect below is treated as revenue lost.

The intent (from `LPF_UI_CORRECTION_v2.md`) is to restructure the UI to **exactly two workbooks**:

```
Top nav
├─ Unprocessed                      (incoming raw jobs)
└─ Pipeline
   ├─ Company & Job
   ├─ People
   ├─ HeyReach
   └─ Job Poster
```

Everything else (Variables, Companies, Review, Rejected, Logs, Import CSV, Test) folds into right-side utility buttons, filter chips, or drawers.

---

## 1. Current repo state (as of handoff)

### 1.1 Fixed and verified — leave alone

**`src/pipeline/Pipeline.js`** — the DACH/OpenAI mis-attribution bug is fixed.

The bug: when an AI call inside Stage 1 threw (e.g. `OPENAI_API_KEY not set`), the orchestrator's `catch` block was running `batchSetCellState(job.id, stageCols, 'error', …)` for all five stage-1 columns. That painted the **deterministic** DACH cell red with an OpenAI error it never depends on. Same for the success path: a bulk `'success'` setter was clobbering per-cell states (e.g. `condition_not_met` on Direct) that Stage 1 had already written individually.

The fix: a new helper `setPendingCellsState(jobId, colIds, newState, opts)` only flips cells currently in `queued`, `running`, `idle`, or absent. Already-finalized cells are left alone. The three call sites in `processJob()` (rejected / success / error) were swapped to use the new helper. Top-of-file imports include `setCellState`, `emitCellState`, and `DatabaseClass`.

Verification:

```bash
node --check src/pipeline/Pipeline.js                    # → OK
node -e "require('./src/pipeline/Pipeline.js')"          # → loads
```

Keep this. Do not refactor further until the rest of the system is back online.

### 1.2 BROKEN — must be repaired before anything else works

**`public/index.html`** is **truncated**.

- File ends at **line 3210** (was ~3290 originally).
- Last present line is the comment `// ── Section 3: About / provider ───────────────────────────` inside the `renderAiPanel(jobId, colId)` function.
- Everything after that line is gone: the rest of `renderAiPanel`, any tail functions, the closing `</script>`, `</body>`, `</html>`.
- The script fails to parse, so the entire UI is broken when served.

Confirmation commands:

```bash
wc -l public/index.html                                   # 3210 (was ~3290)
tail -5 public/index.html                                 # ends mid-function
grep -c '</script>' public/index.html                     # → 0  (should be 1)
node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf-8');const s=h.indexOf('<script>')+8;const e=h.lastIndexOf('</script>');try{new Function(h.slice(s,e));console.log('OK')}catch(e){console.log('ERR:',e.message)}"
# → "ERR: Unexpected end of input"
```

**No git, no backup** in this repo. There may be backups in OneDrive version history, VS Code's "Local History" extension cache (`~/.config/Code/User/History/`), or Windows File History. **Always check those first.**

---

## 2. Phase 0 — Restore the HTML (do this BEFORE anything else)

### Option A — restore from a backup (preferred)

In Windows (run from PowerShell or in a terminal on the host, NOT inside this sandbox):

```powershell
# Check OneDrive version history for D:\Freelance\CTR\claude-based-lpf\LPF-Claude\public\index.html
#   Right-click the file → Version History → restore the most recent version with file size ~196KB+
# Or check VS Code Local History (if vscode-local-history extension is installed):
ls "$env:APPDATA\Code\User\History" | findstr index   # find timestamped backups
# Or Windows File History (if enabled):
fhmanagew.exe -restoreversion
```

After restoring, verify:

```bash
wc -l public/index.html                                  # should be ~3290
grep -c '</script>' public/index.html                    # should be 1
grep -c '</html>' public/index.html                      # should be 1
node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf-8');const s=h.indexOf('<script>')+8;const e=h.lastIndexOf('</script>');new Function(h.slice(s,e));console.log('JS OK')"
# → "JS OK"
```

Once restored, **do not edit the file yet** — proceed to Phase 1 to layer the surgical patches on top.

### Option B — reconstruct the tail (only if no backup exists)

If you cannot find a backup, the tail of `renderAiPanel` needs to be reconstructed. The function follows a 5-section drawer pattern that's already used elsewhere in the file. Read the existing earlier sections of `renderAiPanel` (sections 1, 2 are above the truncation cut) to learn the pattern, then write the rest.

What the function must produce (the AI cell detail panel content):

```
Section 1 — Status (already in file)
  State pill, Run count, Last updated, Error message (if any)

Section 2 — Run condition (already in file)
  Renders ConditionTrace via renderConditionSection(condition, col)

Section 3 — About / provider          ← truncation cut here
  Two-line block: col.description (one sentence), provider badge

Section 4 — Inputs / Prompts (for AI cols only)
  System prompt CodeBlock, User prompt (filled) CodeBlock, Model, Temperature

Section 5 — Output (stored fields)
  Table of key → value rows; pull from cs.value or from job fields tied to col.outputFields

Section 6 — Run history
  Last 10 rows from /api/cell-runs?jobId=&colId= — columns: started_at, duration_ms, state, error_class

Footer — Actions
  ▶ Run again        (calls /api/pipeline/retry-cell)
  ↳ Re-run from stage (calls /api/pipeline/retry-stage)
  Copy as cURL       (only for http_action columns)
```

Then close out the file:

```html
</script>
</body>
</html>
```

After reconstruction, verify with the same commands as Option A. Do not move on until JS parses.

---

## 3. Phase 1 — Re-apply the surgical patches (in order)

These were applied by the previous session and partly survived. After the HTML is restored, apply each block. After every patch, run the JS-parse check before moving on.

### 3.1 Remove "Processing" filter option (B-02)

In the `<select id="jobs-filter">` block (~line 506) drop `<option value="processing">Processing</option>` and rename "All stages" to "All".

In `renderJobs()` (~line 1841) drop the dead `PROC` constant and the `if (filter === 'processing')` branch. The filter becomes simply `if (filter) jobs = jobs.filter(j => j.stage === filter);`.

### 3.2 Two-workbook nav

Replace the existing `<nav>` block (~line 419) with the two-workbook nav from `RECOVERY_AND_PATCHES.md §3.2` (primary pills: Unprocessed | Pipeline; right-aligned utilities: Review, Rejected, Logs, Import, Dev; the old Variables/Companies/People kept as hidden routable buttons).

Add the `<nav id="pipeline-subnav">` strip with four sub-tabs: Company & Job, People, HeyReach, Job Poster.

Extend `showPage()` to drive subnav visibility and add `showSubTab(sub)`. Add `PIPELINE_SUBTABS` and `SUBTAB_TO_PAGE` constants.

### 3.3 HeyReach + Job Poster placeholder pages

Add `<div id="page-heyreach" class="page">` and `<div id="page-job-poster" class="page">` placeholder cards inside `<main>` (just before `</main>`). Each describes the source Clay table, the planned columns / waterfall, and the integration status. Verbatim markup in `RECOVERY_AND_PATCHES.md §3.3`.

### 3.4 Send-feedback toast + queued pill (B-01)

Patch `toast()` (~line 949) to accept HTML and a custom duration. Replace `runJob()` (~line 2573) to call the new feedback helpers (`markUnpRowsAsQueued`, `fadeOutAndRemoveUnpRow`, `toastWithViewLink`, `unmarkUnpRowAsQueued`). Add those helpers below `runJob`. Patch `processSelected()` (~line 1787) to use the same helpers and rename the primary button to `▶ Send to Pipeline`.

After this patch, clicking ▶ on a row instantly: paints the row's left edge blue, replaces the play button with a blue "Queued" pill + spinner, shows a toast with a "View in pipeline →" link, fades the row out after 1.2s, then reloads the table.

### 3.5 Visible bulk toolbar (B-09)

Replace the inline-styled `<div id="unp-bulk">` (~line 466) with the design-token version (background `var(--bg-elev-2)`, border `var(--border-default)`, button text using `var(--fg-default)`). Rename the primary button to `▶ Send to Pipeline`.

---

## 4. Phase 2 — Bug fixes on top of the restored UI

These remain from the original `LPF_UI_CORRECTION_v2.md §0.2` brutal review. Apply after Phase 1 is green.

### B-03 — Cell drawer "State: — idle" shown while cell displays `● DACH ✓`

In `renderAiPanel`, the Status section reads `cs?.state || 'idle'`. If `cs` (cell_state row) is missing for a cell that the job's columns nevertheless show as populated, the drawer wrongly displays idle.

Fix: when `cs` is missing but a value can be derived from the job's stored fields (e.g. `is_dach`, `country`), surface state as `success` with that derived value. Implementation: extend the column registry's `outputFields` array; in the drawer, fall back to those job fields when no cell_state row exists.

### B-05 — `Run count = 7` but Run History shows "No runs recorded"

The drawer reads from `/api/cell-runs?jobId=&colId=`. That endpoint is implemented in `src/routes/system.js` and queries `lpf_cell_runs`. If `Run count = 7` is shown via the `run_count` column on `lpf_cell_state` but no rows exist in `lpf_cell_runs`, then `runCell.js`'s `insertCellRun` is silently failing OR is not being called on the code path that increments `run_count`.

Audit:

- Trace every call to `setCellState` that isn't preceded by an `insertCellRun`.
- The `setPendingCellsState` helper (added in Phase 0 to Pipeline.js) calls `setCellState` directly without inserting a `lpf_cell_runs` row — that's correct for bulk transitions but it still increments `run_count`. Decide: either stop incrementing `run_count` for bulk transitions, or insert a "synthetic" `cell_runs` row each time. Recommended: stop the increment in bulk transitions and reserve `run_count` for actual `runCell` executions.

### B-06 — No Retry button in cell drawer

The endpoints `/api/pipeline/retry-cell` and `/api/pipeline/retry-stage` already exist (`src/routes/system.js`). The drawer simply has no button wired. Inside `renderAiPanel`, add a footer with:

```js
<div class="ap-footer">
  <button class="btn btn-primary btn-sm" onclick="retryCell(${jobId}, '${colId}')" ${state==='queued'||state==='running'?'disabled':''}>▶ Run again</button>
  <button class="btn btn-sm" onclick="retryStageForJob(${jobId}, '${col.group.stage}')">↳ Re-run from this stage</button>
</div>
```

And the helper:

```js
async function retryCell(jobId, colId) {
  try {
    const r = await fetch('/api/pipeline/retry-cell', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jobId, colId }) });
    const d = await r.json();
    toast(d.message || `Retrying ${colId}…`, 'ok');
    // optimistic: set cell to queued locally
    updateCellInUi(jobId, colId, { state: 'queued' });
  } catch (e) { toast('Retry failed: '+e.message, 'error'); }
}
```

### B-07 — No column-header "retry all errors" icon

When a column has any cell in `error` state for currently visible rows, render a small `↻` in the header. On click → confirm popover → POST `/api/pipeline/retry-column` with `{ colId }` (already implemented server-side).

### B-08 — No live update / SSE animation

SSE is already implemented (`/pipeline/events` in `src/routes/system.js`; `connectSSE()` in HTML). What's missing: when a `cell_state` event arrives, the table is not updating with `flushSync` semantics — it polls. Fix the SSE handler to:

```js
sse.addEventListener('message', (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'cell_state') {
    updateCellInUi(ev.job_id, ev.col_id, { state: ev.state, value: ev.value, error_msg: ev.error });
  }
  // ...
});
```

`updateCellInUi(jobId, colId, partial)` rewrites a single `<td>` in-place; do not re-render the whole table. Reserve column widths in CSS so transitions don't shift the layout.

### B-09 — Bulk toolbar (already patched in Phase 1)

### B-10 — No row drawer with stage timeline

Currently clicking the Job Title link navigates to the source URL. Add a row-level click (anywhere except the link/checkbox) that opens a drawer with:

- Job header card (title, company, country/city, source pill, applicants).
- Stage timeline (7 vertical entries: stage1_sap → stage7_ai_search), each with state icon (✓ done · ◐ running · ⊘ skipped · ✗ error · ○ pending), duration, message, and a per-stage retry button.
- Variables summary (existing Variables-tab columns for this row).
- Contacts found (links to People tab filtered by `job_id`).
- Footer: Re-run pipeline · Reject job · Send to review.

### B-11 — Error messages truncated

In the drawer's Status section, the error message renders with single-line CSS. Wrap with a collapsible `<details>` or word-break: break-word and pre-wrap inside a `<pre>`. Always render the full message.

### B-12 — Run-condition trace block missing

The condition_traces table exists. The `evalCondition(colId, job)` function in the HTML emits a partial trace but the drawer's Section 2 doesn't always render it for `condition_not_met` cells. Always render a `<ConditionTraceBlock>`:

- A title `RUN CONDITION ❌ DID NOT PASS` (or ✓ PASSES).
- A table of evaluated inputs: `name`, `value`, `expected`, `ok` (✓/✗).
- A one-sentence reason: "Condition failed because `<varName>` was `<actualValue>`; required `<expected>`."

Persist the trace by writing to `lpf_condition_traces` in every stage's condition evaluator. Already-scaffolded helpers in `src/pipeline/runCell.js` should be extended.

### B-13 — `OPENAI_API_KEY not set` rendered as raw text in cell

After the Pipeline.js fix, this error should now only appear on `stage1_sap_check` cells, not DACH/Direct/Score/Fit. In the cell renderer, wrap the error in `<Pill kind=error>Error</Pill>` with the message in a tooltip. Don't put the raw message into the cell.

### B-14 — Left-gutter row status bar

Add a 4px left stripe colored by the job's `overallState`:
- blue: any cell in `running`/`queued`
- green: every stage in success/success_empty/condition_not_met
- red: any `error`
- gray: idle

Computed per row at render time from the cells map.

### B-15 — Country/City/Applicants em-dashes

CSV import is not mapping these. Either fix the import (`/upload/csv` in `system.js`) to map them properly, or remove the columns from the Unprocessed table. Don't ship em-dashes.

### B-16 — "Start Fresh" confirm

Already protected by `confirm()` (line 2928). No change needed.

---

## 5. Phase 3 — Larger structural work (the actual LPF replica)

### 5.1 Column registry

Create `src/pipeline/columns.js` as the single source of truth for every column rendered in any of the four Pipeline sub-tabs. Each entry:

```js
{
  id: 'stage3_tech_extract',
  tab: 'company_job',                 // company_job | people | heyreach | job_poster
  group: { stage: 'stage3_tech', title: 'Stage 3 — Tech Extract (GPT)' },
  label: 'Tech Extract',
  kind: 'enrichment',
  provider: 'openai',
  costHint: '~$0.001',
  description: 'Extract SAP modules, tech stack, city/industry context from job posting via GPT-4o-mini.',
  runConditionLabel: 'DACH gate passed AND SAP relevance ≥ medium',
  runConditionFn: (row) => ({
    passes: row.is_dach && row.ctr_fit !== 'low',
    evaluated: [
      { name:'is_dach',  value: row.is_dach,  expected:'true',                 ok: !!row.is_dach },
      { name:'ctr_fit',  value: row.ctr_fit,  expected:'high|medium',          ok: row.ctr_fit !== 'low' },
    ],
    reason: row.is_dach && row.ctr_fit !== 'low' ? null : 'DACH not set or fit was low',
  }),
  outputFields: ['sap_modules','company_hq_city','company_industry','tech_combined'],
}
```

Build the registry tab-by-tab. Source-of-truth for column lists, prompts, providers, and run conditions:
- `D:\Freelance\CTR\ClaudeworkspaceCTR\CTR\LPF_DACH_DataFlow_Map.md`
- The existing stages in `src/pipeline/stages/Stage0*.js`

Frontend uses the same registry: ship as JSON (or transpile to a JS-served map at `/api/columns`). No drag-and-drop, no edit-from-UI.

### 5.2 People / HeyReach / Job Poster tab tables

After the registry exists:
- The existing People tab table reads from `lpf_contacts` and renders via the registry's `tab === 'people'` columns.
- HeyReach tab: new table backed by a new table `lpf_heyreach_rows` (1 row per contact eligible for HeyReach). 61 columns from Clay Table 4. Trigger condition: contact has `email_validated = true` and `is_dach = true`.
- Job Poster tab: new table backed by `lpf_job_poster_rows`. 62 columns from Clay Table 5. Trigger condition: contact is the job poster AND we don't yet have a validated phone.

DB migration: `migrations/202605xx_subtabs.sql`:

```sql
CREATE TABLE IF NOT EXISTS lpf_heyreach_rows (
  id            SERIAL PRIMARY KEY,
  contact_id    INTEGER REFERENCES lpf_contacts(id) ON DELETE CASCADE,
  job_id        INTEGER REFERENCES lpf_jobs(id),
  -- 61 cols from LPF_DACH_DataFlow_Map.md §7 (HeyReach Implementation)
  connection_req TEXT,
  english_inmail TEXT,
  inmail_body_de TEXT,
  message_translation TEXT,
  imagined_city TEXT, imagined_nearby_city TEXT, imagined_industry TEXT,
  job_posting_intro TEXT,
  -- routing flags
  is_hot_job_title BOOLEAN, is_connect_only BOOLEAN, is_open_profile BOOLEAN,
  -- actions
  free_inmail_campaign_id TEXT,
  conreq_plus_inmail_campaign_id TEXT,
  conreq_only_campaign_id TEXT,
  -- action results
  free_inmail_sent_at TIMESTAMPTZ, free_inmail_lead_id TEXT, free_inmail_error TEXT,
  -- ... fill in the rest from the map
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lpf_job_poster_rows (
  id          SERIAL PRIMARY KEY,
  contact_id  INTEGER REFERENCES lpf_contacts(id) ON DELETE CASCADE,
  job_id      INTEGER REFERENCES lpf_jobs(id),
  -- 10-provider phone waterfall results
  phone_datagma TEXT, phone_hunter TEXT, phone_rocketreach TEXT, phone_contactout TEXT,
  phone_prospeo TEXT, phone_wiza TEXT, phone_forager TEXT, phone_leadmagic TEXT,
  phone_pdl TEXT, phone_linkedin_api TEXT,
  -- validations
  valid_datagma BOOLEAN, valid_hunter BOOLEAN, /* ... */
  -- master arbitration
  phone_waterfall_winner TEXT, phone_winner_provider TEXT, phone_winner_score NUMERIC,
  -- routing
  send_to_rf_company_status INTEGER, send_to_rf_company_at TIMESTAMPTZ,
  send_to_rf_contact_status INTEGER, send_to_rf_contact_at TIMESTAMPTZ,
  send_to_rf_job_status     INTEGER, send_to_rf_job_at     TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add row_kind to cell_state and cell_runs so the same machinery can drive all four tabs
ALTER TABLE lpf_cell_state ADD COLUMN IF NOT EXISTS row_kind TEXT NOT NULL DEFAULT 'jobs'
  CHECK (row_kind IN ('jobs','contacts','heyreach','job_poster'));
ALTER TABLE lpf_cell_runs  ADD COLUMN IF NOT EXISTS row_kind TEXT NOT NULL DEFAULT 'jobs'
  CHECK (row_kind IN ('jobs','contacts','heyreach','job_poster'));
```

### 5.3 New pipeline stages

- **Stage 9 — HeyReach routing** (after Stage 7 / before Stage 8): for each new contact that's validated and DACH, write a `lpf_heyreach_rows` row, run the AI prompts (connection_req, english_inmail, inmail_body_de, imagined_*), and call HeyReach when conditions match (`free_inmail`, `conreq_plus_inmail`, `connect_only`). Use the verbatim German connection-request prompt from `LPF_DACH_DataFlow_Map.md §7 Col 37`.

- **Stage 10 — Phone (Job Poster)**: for each contact identified as the job poster, write a `lpf_job_poster_rows` row, run the 10-provider phone waterfall in order (Datagma → Hunter → … → LinkedIn API), each preceded by an "if previous is empty" gate. Validate per-provider with Clay-AI–style plausibility checks. Pick the master winner. Optionally fire CRM writes (Send to RecruiterFlow Company / Contact / Job).

Don't ship Stage 10 with all 10 providers wired; start with Datagma + Hunter (2 providers) to get the waterfall mechanic working, and add the rest in subsequent PRs.

### 5.4 Activity drawer + cost-bar drill-down

- Move Logs out of the top nav into a right-side `Activity` slide-in drawer triggered from a 🔔 in the header. Stream from existing `/pipeline/events`. Group by job. Filter chip: All | Errors | Warnings | Info. Click a `[1459]` jobId pill → navigate to Pipeline → Company & Job → select that row.
- Cost bar (`GPT $0.0020 · Apollo 10 cr · …`) becomes clickable → modal with today's per-stage cost breakdown sourced from `lpf_api_costs` grouped by `operation`.

---

## 6. Verification — every change must pass these

Run after every patch:

```bash
# Server boots
npm run dev &
sleep 3
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/    # → HTTP 200

# Server-side scripts load
node --check src/pipeline/Pipeline.js                                    # → OK
node -e "require('./src/pipeline/Pipeline.js'); console.log('OK')"      # → OK

# HTML script parses
node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf-8');const s=h.indexOf('<script>')+8;const e=h.lastIndexOf('</script>');new Function(h.slice(s,e));console.log('HTML JS OK')"

# Sanity: stage filter no longer offers Processing
grep -c '>Processing<' public/index.html                                # → 0

# Sanity: HeyReach + Job Poster pages present
grep -c 'id="page-heyreach"'   public/index.html                        # → 1
grep -c 'id="page-job-poster"' public/index.html                        # → 1
```

End-to-end owner smoke test (perform after Phase 1 + relevant Phase 2 patches):

1. Visit `/`. Two pills visible: Unprocessed (active) and Pipeline. Right-side: Review / Rejected / Logs / Import / Dev.
2. Tick a row. Bulk bar shows `1 of N selected · ▶ Send to Pipeline · ▶ Run All Pending · ✕ Clear`. Buttons are **legibly visible** on dark theme.
3. Click `▶ Send to Pipeline`. Within 300ms: row gets a blue stripe, the play button is replaced by a blue pulsing "Queued" pill, a toast shows `… sent to pipeline · View in pipeline →`, and the row fades out after 1.2s.
4. Top-bar counters update (`pending` −1, `running` +1).
5. Click `View in pipeline →`. Sub-tabs are visible. Default is Company & Job. The sent job is at top with `STAGE 1` cells transitioning idle → running → success.
6. The DACH cell renders `● DACH ✓` and does **not** show `OPENAI_API_KEY not set` regardless of whether the SAP-check OpenAI call fails.
7. If SAP check errors: only the `SAP Check` column shows `Error`. DACH, Direct, Score, Fit keep their respective states.
8. Click `Pipeline → People`. The page renders with current people contacts.
9. Click `Pipeline → HeyReach` and `Pipeline → Job Poster`. The placeholder pages explain what's coming.
10. Click the stage-filter dropdown. `Processing` is **not** an option.
11. Open a row drawer (Phase 2). Stage timeline renders. Stage retry buttons work.
12. Open a cell drawer (Phase 2). Retry button works; new `lpf_cell_runs` row created.
13. Visit Logs tab (or Activity drawer when 5.4 done). Events stream live without polling.

If any step fails, the patch chain is incomplete.

---

## 7. Rules for further modifications (read these EVERY time)

These come from a real incident in this codebase. Follow them.

### 7.1 Large files (>1000 lines) MUST NOT be edited via incremental `Edit` calls

`public/index.html` is ~3290 lines. When you need to edit it:

- Read the whole file with `Read` first.
- Compose the entire new content in memory.
- Write back via a single `Write` call.

Or, when the change is a clean text replacement:

- Use a shell heredoc + `sed -i` from `mcp__workspace__bash`.
- Take a checkpoint after every change: `cp public/index.html /tmp/index.html.$(date +%s).bak`.
- Verify size and parse-ability **before** the next edit:
  ```bash
  wc -l public/index.html
  grep -c '</script>' public/index.html      # must be 1
  grep -c '</html>'   public/index.html      # must be 1
  node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf-8');const s=h.indexOf('<script>')+8;const e=h.lastIndexOf('</script>');new Function(h.slice(s,e));console.log('OK')"
  ```

A previous session used `Edit` repeatedly on this file and the tool truncated it. Don't repeat that.

### 7.2 Pipeline.js editing is safer but still take checkpoints

- After every edit run both `node --check src/pipeline/Pipeline.js` and `node -e "require('./src/pipeline/Pipeline.js')"`. If either fails, restore from the last checkpoint:
  ```bash
  cp src/pipeline/Pipeline.js /tmp/Pipeline.js.$(date +%s).bak
  ```

### 7.3 Migrations are additive only

Never drop columns/tables. Never `TRUNCATE` outside the `/admin/reset` endpoint. Always wrap in `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.

### 7.4 Provider calls — only server-side, only via the existing services

Never call OpenAI/Apollo/Proxycurl/Apify/Findymail/HeyReach/etc. from the browser. Add to or extend `src/services/*Service.js`. Every call must record cost via `CostTrackerService.recordCost(...)`.

### 7.5 Sanitize secrets before logging

`runCell.js` writes `inputs_json` and `raw_output` to `lpf_cell_runs`. Before persisting, scrub headers like `Authorization`, `RF-Api-Key`, `X-API-Key`, and any field whose name matches `/api[-_]?key|token|secret|bearer/i`. Same for log calls.

### 7.6 SSE is the only acceptable transport for live updates

Don't poll the row table. The endpoint `/pipeline/events` already exists. Apply `cell_state` events with `requestAnimationFrame` (no full re-render). Reserve column widths so transitions don't cause CLS.

### 7.7 Owner-mindset checks before merging anything

For every change, answer:

- Does this surface (in a single click) what the operator needs to know about a failure?
- Does this preserve the audit trail (`lpf_cell_runs`, `lpf_condition_traces`)?
- Does this silently swallow any error? If yes, classify it via `classifyError` and surface it on the affected cell.
- Does this break the Pipeline.js fix that protects deterministic cells from AI failures?

---

## 8. Files of interest (cheat sheet)

```
public/index.html                  Single-page UI (TRUNCATED — repair before anything)
public/COLUMN_REFERENCE.md         Quick lookup of every Pipeline column id ↔ DB field
server.js                          Express boot + port fallback
src/Logger.js                      Winston wrapper writing to console + lpf_logs
src/database/Database.js           pg Pool singleton
src/database/DatabaseService.js    All SQL CRUD methods (countJobs, upsertJob, …)
src/database/schema.sql            Full DDL (includes cell_state, cell_runs, condition_traces)
src/pipeline/Pipeline.js           ⭐ Orchestrator (FIX APPLIED — leave as-is for now)
src/pipeline/PipelineController.js Start/stop/should-stop singleton
src/pipeline/PipelineEmitter.js    EventEmitter feeding /pipeline/events SSE
src/pipeline/runCell.js            7-state cell wrapper (setCellState, batchSetCellState, queueAllRemaining, emitCellState)
src/pipeline/errors.js             classifyError(err) → network|rate_limit|validation|auth|timeout|provider_error|unknown
src/pipeline/stages/Stage0*.js     Eight stages (1: SAP check, 2: Proxycurl enrich, 3: GPT tech, 4: Apollo+LinkedIn, 5: Findymail, 6: Job poster LinkedIn, 7: AI search, 8: Instantly send)
src/services/                      Provider clients (ApifyService, ApolloService, ClaudeService, CostTrackerService, FindymailService, HeyReachService, InstantlyService, LinkedInApifyService, LinkedInService, OpenAIService, JobProcessor)
src/routes/system.js               REST + SSE endpoints (jobs, contacts, pipeline run/stop/retry, costs)
src/routes/webhook.js              POST /webhook/lpf — entry point from JPE
scripts/                           CLI: migrate, pipeline, seed, status, logs, reset-db, cleanup-bad-imports
.env                               POSTGRES_*, OPENAI_API_KEY, APOLLO_API_KEY, PROXYCURL_API_KEY, APIFY_TOKEN, FINDYMAIL_*, INSTANTLY_*, HEYREACH_API_KEY, PIPELINE_CONCURRENCY, MIN_QUALITY_SCORE
```

External docs:
- `D:\Freelance\CTR\ClaudeworkspaceCTR\CTR\LPF_DACH_DataFlow_Map.md` — Clay LPF workbook canonical source (every table, column, prompt, condition).
- `D:\Freelance\CTR\ClaudeworkspaceCTR\CTR\WB2_Analysis.md` — companion analysis of the AI-prompts workbook.
- `D:\Freelance\CTR\ClaudeworkspaceCTR\CTR\LPF_UI_CORRECTION_v2.md` — brutal review + two-workbook IA (parent of this file).
- `D:\Freelance\CTR\ClaudeworkspaceCTR\CTR\LPF_UI_CLAY_PARITY_SPEC.md` — older spec; superseded by v2 except design tokens.
- `./RECOVERY_AND_PATCHES.md` — verbatim patches for Phase 1.

---

## 9. Execution order — do not skip

1. **Phase 0 — repair `public/index.html`**. Don't proceed until JS parses and the server returns HTTP 200.
2. **Phase 1 — re-apply the five surgical patches** (§3.1–3.5). Verify between each.
3. **Phase 2 — bug fixes** (§4). Tackle in order: B-06 retry button → B-12 condition trace → B-10 row drawer → B-08 live SSE → B-14 left stripe → B-07 column retry-all → B-13 error pill → B-11 expandable errors → B-05 run-history vs run-count → B-03 idle-state fallback → B-15 CSV mapping or column removal.
4. **Phase 3 — structural** (§5). Column registry first, then DB migration, then HeyReach stage (start with 2 routes: free_inmail + connect_only), then Job Poster phone waterfall (start with Datagma + Hunter only), then Activity drawer + cost drill-down.
5. **Smoke test** — perform the 13-step owner test in §6. Take screenshots; attach to your PR. Do not ship until all 13 pass.

---

## 10. Questions to answer before coding

Don't start coding until you can answer each. Put the answers in your PR description.

1. Did you find a backup of `public/index.html` from before this session? If yes, where; if no, you'll reconstruct via Phase 0 Option B.
2. Confirm `node --check src/pipeline/Pipeline.js` returns OK (the previous-session fix is intact).
3. Confirm `npm run dev` boots and `curl http://localhost:3000/` returns 200 **before** you start editing.
4. Did you take a checkpoint of `public/index.html` (size, line count, sha256) before your first edit?
5. Will every Cowork-style edit to `public/index.html` use `Read` → `Write` (full rewrite) or `bash`+`sed`, NOT incremental `Edit` calls?
6. Are you running `node -e "…new Function(h.slice(s,e))…"` after every HTML save?
7. Are you adding new pipeline stages additively (Stage 9, 10) rather than mutating Stage 1–8?

Answer all seven. Then execute Phases 0 → 5.

---

## 11. Hard non-negotiables

- ❌ Do not edit `public/index.html` with incremental `Edit` calls. Use `Write` after `Read`, or `bash`+`sed` with checkpoints.
- ❌ Do not call providers from the browser.
- ❌ Do not delete columns from `lpf_jobs`, `lpf_contacts`, `lpf_cell_state`, `lpf_cell_runs`, `lpf_condition_traces`, or any existing table.
- ❌ Do not put `Processing` back as a stage filter option or row state.
- ❌ Do not add a column editor / prompt editor / condition editor to the UI.
- ❌ Do not swallow provider errors silently. Classify, persist, surface.
- ❌ Do not paint deterministic cells (DACH, Direct, formula gates) with AI errors. The Pipeline.js `setPendingCellsState` fix exists to prevent that — don't undo it.
- ✅ Every state transition writes a row to `lpf_cell_runs` (real run) and a row to `lpf_condition_traces` (eval).
- ✅ Every action column surfaces `action_sent` distinct from `action_dedup_skipped` distinct from `error`.
- ✅ Every operator-facing view answers V-01 through V-10 from `LPF_UI_CORRECTION_v2.md §9` within ≤2 clicks.

Ship the smoke test green or don't ship.
