# What to build — every detail

> Read this alongside `CLAUDE_CODE_HANDOFF.md`. That file says **what's broken**. This file says **what's missing**. Every paragraph below is a behavior the operator must see when this is done. Build to the level of detail described — don't paraphrase, don't summarize, don't "approximately like" anything.

---

## A. The top frame (always on screen)

A 71px sticky header. Three stacked bars, each `1px solid var(--border-subtle)` underneath.

**Bar 1 — Identity + master controls.** Left: `LPF pipeline` wordmark, blue dot when SSE connected (pulsing 1s), gray dot when reconnecting. Then five live counters in mono tabular numerals: `jobs N · pending N · running N · ready N · done N`. Each counter is clickable and filters the active table. Counter numbers update with `flushSync` the moment a `cell_state` or `job_done` SSE event arrives — never via polling. Right side: a 🔔 Activity bell (badge = unread errors+warnings since last open), a `Dev` button (only when `process.env.DEV_PANEL=1`), and the master `▶ Run pipeline` button. Master button morphs to `⏸ Pause pipeline` (faint blue glow `box-shadow: 0 0 0 1px var(--status-running)`) while any job is running. Pause requires a confirm; Run does not.

**Bar 2 — Cost bar.** A horizontal strip of provider chips: `GPT $X.XXXX (Yk tok in / Zk tok out) · Apollo N cr · Proxycurl N cr · Apify N runs · Findymail N · HeyReach N`. The chip itself is a single-line element with a small dot-icon left of the value (color-coded by provider). Click any chip → opens a modal titled `Today's cost — <provider>`: a small bar chart of cost-per-stage, plus a table grouped by `lpf_api_costs.operation` with columns `Operation · Calls · Cost USD · Cost % of provider total`. Right-most element of Bar 2: a `Live ⏵` toggle. Default ON, green dot when SSE is connected. When OFF, falls back to 30s polling and shows `Live ⏸ 30s`. When stream is broken and retrying: `Live ⚠ reconn`.

**Bar 3 — Workbook pills.** Two pills: `Unprocessed` and `Pipeline`. Each pill is 11px text in a 28px tall container; the active pill has `background: var(--accent)` (white in dark theme), `color: var(--bg-base)` (black); inactive pill is transparent with `color: var(--fg-muted)`. Hover: `color: var(--fg-default)`. Right side of Bar 3: when on Pipeline, an inline sub-tab strip appears below this bar (see §C).

---

## B. WB1 — Unprocessed page

**Sub-toolbar.** Left: title `Unprocessed jobs (N)`. Then three filter chips: `Pending (N)`, `Rejected (N)`, `All (N)`. Default active: Pending. Chip click toggles the table contents instantly. Then two `<select>`s: `Show 50/100/200/500/All` and `Age Any/1d/7d/30d`. Then `↻ Refresh`. Right side: `+ Import CSV` (opens existing CSV modal) and `Inject test JSON` (opens existing test-JSON modal).

**Bulk action bar.** Sticky-positioned 8px below the sub-toolbar (z-index 150), `background: var(--bg-elev-2)`. Hidden until ≥1 row selected. Layout: checkbox (select-all), `N of M selected` count in `--fg-default`, flex spacer, then buttons in this order: `▶ Send to Pipeline` (primary, white background, black text), `▶ Run All Pending` (neutral), `✗ Reject selected` (red text), `✕ Clear`. Selecting all jobs from inside this bar's checkbox checks every row in the table. Disabled state when 0 selected: bar hides entirely (`display:none`).

**Table.** Sticky header. First column: 34px wide checkbox column. Then sticky `Job Title` (220px min). Then `Company` (160px min, ellipsized). Then `Country`, `City`, `Source` (10px font), `Applicants` (right-aligned, mono), `Received` (10px mono, no-wrap). Then a 60px action column with a single `▶` icon-only button that runs the row's job alone.

**Per-row send behavior.** The instant the user clicks `▶` on a row, OR clicks `▶ Send to Pipeline` from the bulk bar:

1. **Within the same frame** (zero network latency), the row's left edge gets a 4px `inset 4px 0 0 0 var(--accent)` box-shadow stripe. Row background fades to `rgba(59,130,246,.06)` over 200ms. The action cell's `▶` button is replaced by a pill: blue background `rgba(59,130,246,.15)`, blue text `#3b82f6`, blue border `rgba(59,130,246,.35)`, 11px font, pill-shaped (`border-radius:999px`), with a 10×10px spinning ring spinner (`.spinner-xs`, `var(--status-running)`, 1s rotation) followed by the word `Queued`. Any checkbox on the row is unchecked.
2. **`fetch('/pipeline/run-batch')` or `/pipeline/run/:id`** fires.
3. **On 200**: a toast appears bottom-right. Toast format: `<message> · <a>View in pipeline →</a>`. The link calls `showPage('jobs')`. Toast type `ok` (green left border, dark bg). Duration: 4500ms for single send, 5000ms for bulk. The toast supports HTML, so the link is clickable.
4. **At T+1200ms**: row CSS `opacity: 0` transition over 600ms; at T+1800ms the `<tr>` is removed from the DOM. The Unprocessed badge in the nav decrements by N. The `unp-count` element decrements.
5. **At T+2500ms**: `loadUnprocessed()` re-fetches the list — by now the queued jobs have moved out of the `received` stage.
6. **On error**: every queued row's pill reverts to a `▶` button, the row's stripe and background revert. A red toast shows the server's error message.

**Empty/loading/error states.**
- Loading: 10 skeleton `<tr>`s with shimmer animation (`opacity .4 → 1`).
- Empty: a 240px tall centered card `No unprocessed jobs — import a CSV or check the filter settings`.
- Error: red text row spanning all columns with the message.

**Start Fresh.** Already exists with `confirm()`. Don't touch.

---

## C. WB2 — Pipeline page

When the active workbook is Pipeline, Bar 3 grows a second row immediately below it (`background: var(--bg-elev-2)`, `border-bottom: 1px solid var(--border-subtle)`, padding 0 8px). This is the **sub-tab strip**. Four tabs in order: `Company & Job`, `People`, `HeyReach`, `Job Poster`. Each is a 12px medium-weight button with no background, a 2px transparent bottom border, and `color: var(--fg-muted)`. Hover: `color: var(--fg-default)`. Active: `color: var(--fg-default)`, `border-bottom-color: var(--accent)`. The right side of the strip holds a `View options ⚙` menu with three toggles: `Show condition-not-met rows` (default ON), `Show errors only` (default OFF), `Density: comfortable | compact` (default comfortable). No other knobs.

The active sub-tab is remembered in `localStorage.lpf_pipeline_subtab`.

---

## D. The Clay-style table (shared engine for all four Pipeline sub-tabs)

The same component renders all four sub-tabs; columns come from the registry's `tab` filter.

**Header.** Two stacked rows per column:

- Top row: provider icon (16px, color-coded — OpenAI mint green, Apollo purple, Proxycurl yellow, Findymail blue, Apify magenta, HeyReach orange, Datagma teal, generic gear ⚙ for formula), then column label in 12px medium, then if there's a `runConditionLabel` a tiny info `ⓘ` icon (hover → tooltip with the condition text). Click anywhere on the header → opens a column-info popover showing description, provider, average cost, average duration, condition.
- Bottom row: a 2px tall segmented `<ProgressBar>` showing fraction of visible rows by terminal state. Green portion = success%, gray = success_empty%, red = error%, remainder transparent (= queued/running/condition_not_met/idle). To the right of the bar: percentage in 10px mono (`62%`). Furthest right: a small `↻` icon that **only appears** when ≥1 visible row in this column is in `error`. Click it → confirm popover (`Retry N failed cells?`) → POST `/api/pipeline/retry-column` with `{ colId, scope: 'errors' }`.

Group headers (`STAGE 3 — TECH EXTRACT (GPT)`) sit above the column headers — `<th colspan>` rendering, uppercase, 11px, `letter-spacing: 0.06em`, `color: var(--fg-muted)`. Group headers DO NOT have progress bars.

**Row layout.** 36px tall. First two columns (`Job Title`, `Company`) are sticky-left with a 1px right border. The leftmost edge of each row has a 4px vertical stripe colored by the job's overall state:
- Blue (`var(--status-running)`) if any cell is `running`/`queued`
- Green (`var(--status-success)`) if every stage has a terminal non-error state
- Red (`var(--status-error)`) if any cell is `error` and hasn't been retried
- Amber (`var(--status-warn)`) if any cell is `error` but a newer cell in the same column has succeeded
- Gray (`var(--fg-faint)`) if all cells are `idle`

Beneath the Job Title (10px height, max), a **stage strip** renders 7 dots — one per stage — with state colors. The strip is interactive: hover shows a tooltip listing each stage + state + duration; clicking any dot opens the **row drawer** scrolled to that stage in the timeline.

Row hover: `background: var(--bg-elev-3)`. Active row (drawer open from this row): same hover background plus a 1px inset focus outline using `var(--border-focus)`.

**Cell renderer.** A `<CellRenderer>` function takes the cell's state and value and produces the visual:

| state | render |
|---|---|
| `idle` | `—` em-dash in `var(--fg-faint)` |
| `condition_not_met` | `Run condition not met` italic 11px in `var(--fg-faint)`, no background |
| `queued` | small pulsing `<Dot kind=running/>` + `Queued` in `var(--fg-muted)` |
| `running` | 12px ring `<Spinner/>` + `Running…` in `var(--status-running)` |
| `success` | when there's a value: render the value (truncate to fit, ellipsis); when value is a boolean/flag: render `<Pill kind=success>{label}</Pill>` with the column's success-label (e.g. `DACH ✓`, `Direct ✓`, `Enriched`, `Found 5`); always include a tiny `📝` note icon at the right if the cell has structured output |
| `success_empty` | `<Dot kind=skip/> —` muted; tooltip: `Ran successfully, no value returned` |
| `error` | `<Pill kind=error>Error</Pill>` followed by a `↻` icon-button (12px) that triggers retry without opening the drawer |
| `action_sent` | `<Pill kind=success>Sent · 200</Pill>` plus `T+8s` timestamp; tooltip shows the HTTP response excerpt |
| `action_dedup_skipped` | `<Pill kind=neutral>Already exists</Pill>`; tooltip: `Skipped because record exists in <destination>` |

For multi-value cells, the visible portion is the first ~28 chars. Hover the cell for ≥350ms → a small floating preview popup appears anchored to the cell's bottom-right with the full text (no border, `background: var(--bg-elev-3)`, max 360px wide, max 200px tall, scrollable). Popup auto-closes on mouse-out with 100ms grace.

**Cell click behavior.** Single click on any enrichment cell opens the **cell drawer** (§E). Single click on text/number/URL cells with no enrichment selects the row without opening a drawer (Job Title cell still navigates to source URL when the user clicks the actual `<a>` text — not the surrounding cell).

**Double-click on cell.** Opens an in-place cell expansion (the value popup but pinned). Anywhere outside the popup closes it. The popup has a `Copy` button top-right.

**Right-click on cell.** Context menu with: `Open drawer`, `Copy value`, `Retry cell`, `Re-run from this stage`, `View column info`. Each item triggers the corresponding action without opening any other UI.

---

## E. Cell drawer (the heart of the rebuild)

Right-side slide-in, 480px wide on `<lg`, 560px on `>=lg`, max 80vw on mobile. Header has the column label, group, provider chip, and an `✕`. Below the header, a thin button row: `⟳ Retry` (primary), `↳ Re-run from this stage`, `Copy as cURL` (only on HTTP-action columns), `⤴ Open job`. Below that, six collapsible sections (all open by default; user-collapsed state persisted to `localStorage` per column).

### E.1 Status

Vertical list of key-value rows:
- `State` — large `<Pill>` matching the cell state.
- `Run count` — integer from `lpf_cell_state.run_count`.
- `Queued at` — relative + absolute (`8s ago · 19:48:43`).
- `Started at` — relative + absolute.
- `Finished at` — relative + absolute (or blank for non-terminal states).
- `Duration` — `123ms` mono format; for >1s renders as `1.4s`; for >60s renders as `1m 23s`.

If state is `running`, show a live elapsed-ms counter that ticks every 250ms via SSE.

### E.2 Run condition (always shown for enrichment cells; condition cells get §E.2 highlighted)

Top line: `RUN CONDITION` then a colored chip — green `✓ PASSES` or red `❌ DID NOT PASS`. Below, a 2-column micro-table of evaluated inputs:

```
  is_dach            value: true      required: true          ✓
  ctr_fit            value: "low"     required: high|medium   ✗
  quality_score      value: 4         required: ≥ 6           ✗
```

Each evaluated input is one row with: `name` (mono, `--fg-muted`), `value` (mono, value-typed-color: string in light yellow, boolean in lavender, number in cyan), `expected` (in `--fg-subtle`), tick icon. The rows come from `lpf_condition_traces.evaluated`.

Below the table, a single one-sentence reason in `--fg-default`:

> Reason: SAP relevance was `low` (required `high`/`medium`) and quality score was 4 (required ≥ 6).

For passing conditions, the reason is omitted; only the evaluation table is shown.

### E.3 About / provider

Two-line block:
- Description sentence from `column.description`.
- Provider line: `Provider: <name> · Model: <model> · Avg cost: ~$0.0008/run · Median duration: 1.4s`. Average cost and median duration come from `lpf_api_costs` (joined to the operation matching this colId) aggregated over the last 30 days, computed at drawer-open time.

If the column is disabled in code (`enabled: false` in the registry), render a yellow banner above the description: `This column is disabled — runs are skipped. Re-enable in lib/pipeline/columns.js if needed.`

### E.4 Inputs / prompts

For AI cells (`provider === 'openai' || 'claude'`):
- **Inputs panel.** A monospace table of field name → value. Long strings (>200 chars) are clamped to 3 lines with a `Show more` toggle that expands inline. Strings are quoted; numbers and booleans render bare; nulls render as muted `null`.
- **Model panel.** `Model: gpt-4o-mini · Temperature: 0 · Max tokens: 2000`.
- **System prompt.** Inside a `<CodeBlock language=text>` — fixed-height 240px, scrollable, with a sticky `Copy` button in the top-right. Background `var(--bg-input)`, monospace 12px, line-numbers off.
- **User prompt (with actual values filled in).** Same `<CodeBlock>` styling. The placeholder substitutions are highlighted in light yellow background (e.g. `{{job_title}}` → `<mark>SAP-Bearbeiter (gn)</mark>`).

For HTTP action cells (e.g. `add_lead_to_heyreach`):
- **Request panel.** Shows the URL (with masked auth headers — `Authorization: Bearer •••3a4f`), method, and JSON body in a `<CodeBlock>`.
- A `Copy as cURL` button in the section header reproduces the entire call with masking removed when clicked (warns first via confirm).

For formula cells, render the formula source code from `column.formulaSource` (a string stored in the registry).

### E.5 Output

For success/`success_empty`: a table of `outputField → value` rows. Each field name links to the DB column it corresponds to (tooltip on hover: `Stored at: lpf_jobs.sap_modules`). Values longer than 200 chars use the same clamp/expand pattern as inputs. For structured JSON output, render a `<CodeBlock language=json>` with the full structure plus a small `Tree view` toggle that shows a collapsible JSON tree.

For action cells, the output panel shows: `HTTP <status> · response.preview` (first 500 chars of response body) plus the full `Response` JSON in a CodeBlock. If the response contains an `id` or `lead_id`, surface it as the headline: `Lead ID: <id>` linkable to the destination (HeyReach campaign, RecruiterFlow record).

For errors: render `Error class`, `Error message` (full, wrapped, `pre-wrap`, no truncation), `HTTP status` if applicable, then a `<details>` with the last 20 lines of stack trace. A `Reclassify` admin link sits at the bottom (for engineering).

### E.6 Run history

A small table: last 10 runs for `(job_id, col_id)` from `lpf_cell_runs`. Columns: `Started at` (relative), `Duration`, `State` (colored chip), `Error kind`, `Cost`. The most recent run is highlighted with a yellow left border. Clicking any row swaps sections §E.1–§E.5 to that historical run's data — header line shows `Viewing run from 15.05.26 19:48:51 · Return to latest`.

Below the table, a `Load older →` button paginates 10 at a time.

### E.7 Footer (always visible)

Three buttons fixed at the bottom of the drawer:
- `▶ Run again` — primary white button. Disabled when state ∈ `queued|running`. On click: POST `/api/pipeline/retry-cell` with optimistic state set to `queued` immediately. A subtle progress bar (2px tall, `var(--status-running)`) appears at the very top of the drawer during the request.
- `↳ Re-run from this stage` — secondary. POSTs `/api/pipeline/retry-stage`. All downstream cell states for this job reset to `idle`, all cells from this stage forward go to `queued`.
- `✓ Mark reviewed` — toggles `lpf_jobs.reviewed_at`. When set, the cell in the table gets a tiny `✓` watermark in the top-right corner. Owner uses this to mark "I've manually validated this cell".

For HTTP-action cells, add a fourth: `Copy as cURL`.

---

## F. Row drawer

Triggered by clicking the row's stage strip (the 7 dots beneath Job Title), or by right-clicking the row and choosing `Open row drawer`. Same width as cell drawer.

**Header.** Big job title (16px medium), then a meta row: `<Company> · <Country> · <City>`, then a `Received <ago>` timestamp, then a `Source: <source>` pill, then `<applicants> applicants` if present.

**Section 1 — Stage timeline.** Seven vertical entries, in pipeline order. Each entry is a row:

```
●  Stage 1 — SAP Check                ✓ done · 47ms
   AI: SAP confirmed, score=6, fit=medium                                  [Retry]
●  Stage 2 — Company Enrich           ✓ done · 311ms
   Proxycurl enriched: 1,200 employees, pharmaceuticals                    [Retry]
●  Stage 3 — Tech Extract             ✓ done · 7,219ms
   Extracted: S/4HANA, ABAP, Frankfurt, pharmaceuticals                    [Retry]
◐  Stage 4 — Find People              ⏱ running · started 7s ago           [Cancel]
○  Stage 5 — Enrich Contacts          waiting
○  Stage 6 — Job Poster               waiting
○  Stage 7 — AI Contact Search        waiting
─────────────────────────────────────────────────────────────────────────
   Routing
○  HeyReach                           waiting
○  Job Poster (phone)                 waiting
○  Send to Instantly                  waiting
```

Each stage row has: state icon (●green / ◐blue-pulse / ⊘gray-cross / ✗red-cross / ○gray-outline), stage label, status text, duration, summary message, and a per-stage `Retry` button. Click any stage row → opens that stage's first cell drawer (§E) automatically.

**Section 2 — Variables summary.** Mini table of the Stage 1-3 extracted variables (Score, Fit, Dev/Eng, A Dev/Eng, Tech+Role, SAP Modules, Tech Comma, SAP Skills, City, Nearby City, Industry). These are job-level fields, not cells. Empty values render as muted `—`.

**Section 3 — Contacts found.** A compact list of all `lpf_contacts` for this job, grouped by source (AI Search · Apollo CEO · Apollo HR · Apollo Tech · LinkedIn Search · Job Poster). Each contact: avatar (initials in a 24px circle), full name, role, found-via badge, email (or "no email" muted), and a tiny action button bar: `Send to Instantly`, `Send to HeyReach`, `Reject`. Clicking the name opens the People-tab cell drawer for that contact's row.

**Section 4 — Costs.** A single-line summary `$0.0042 total · 5 API calls`. Click to expand into a per-call table from `lpf_api_costs`.

**Section 5 — Footer.** Buttons: `▶ Re-run pipeline` (start from `received` again), `✗ Reject job` (opens a textarea-modal asking for a reason; saves to `lpf_jobs.rejection_comment`), `→ Send to review`.

---

## G. Activity drawer (replaces the Logs tab)

Triggered by the 🔔 bell in Bar 1. Right-side slide-in, 480px wide.

**Header.** `Activity · N events · Filters: All | Errors | Warnings | Info | Stage events | Actions`. Each filter is a chip; multiple-selection allowed via shift-click. A `Mark all as read` ghost link at the right.

**Body.** Reverse-chronological list of events streamed from `/pipeline/events`. Each event:
- 10px mono timestamp (left).
- 16px square `scope` badge (`Server` neutral, `Pipeline` blue, `Worker` purple, `Stage` cyan, `Action` magenta, `Error` red).
- An optional jobId pill: `[1459]` — clicking it navigates to Pipeline > Company & Job and scrolls/selects that row.
- The message text. URLs become links. JobIds in the text become pills.
- A severity dot at the right (green/yellow/red).

Unread events have a 4px blue left stripe and a small `new` chip; opening the drawer marks them read after 1s.

Virtual scroll: 100-entry chunks; sentinel at bottom triggers load-more.

Buffer cap: 1000 entries in memory. Beyond that, the oldest fall out (only the on-screen render — the DB still has them).

When SSE is reconnecting, a banner at the top of the drawer: `Reconnecting to event stream (last update 4s ago)…`. After 60s of failure: `Disconnected. Refresh to retry.`

---

## H. HeyReach sub-tab — what gets built

When this tab is selected, the table renders one row per `lpf_heyreach_rows` entry. Columns grouped:

**Group A — Identity.** `first_name`, `last_name`, `frau_herr_last_name`, `full_name`, `linkedin_profile`, `linkedin_username`, `recipient_country`, `company_name`, `job_url`.

**Group B — Personalization variables (AI-generated).** `tech_names_person_type`, `tech_names_person_type_merged_subject`, `imagined_city`, `imagined_nearby_city`, `imagined_industry`, `job_posting_intro`, `imagined_city_sentence`, `imagined_industry_sentence`. Each rendered as a value chip; click cell → drawer with the AI prompt + output.

**Group C — Message bodies.** `subject_test`, `english_inmail` (full English InMail body — long text), `message_translation` (DE translation step), `inmail_body_de` (final DE InMail), `connection_req` (≤299-char German). Values are truncated to ~28 chars in-cell with hover-popup for full text. Drawer opens the AI prompt (verbatim German prompt from LPF map) and a character counter overlay showing `298/299` for `connection_req`.

**Group D — Routing decisions (formulas).** `is_hot_job_title`, `connect_only`, `open_profile`, `conreq_plus_inmail`, `conreq_to_inmail`, `free_to_inmail`. Each renders as `<Pill kind=success>true</Pill>` or `<Pill kind=skip>false</Pill>`.

**Group E — Action columns.** Five HTTP actions to HeyReach, one per campaign type: `free_inmail_send`, `conreq_plus_inmail_send`, `conreq_to_inmail_send`, `connect_only_send`, `conreq_only_send`. Each cell shows: `action_sent` (with HeyReach lead_id linked), `action_dedup_skipped` (already in campaign), `error`, or `condition_not_met`. Drawer's HTTP-action section renders the full POST body + response.

**Group F — Engagement (post-send tracking).** `conreq_response`, `conreq_response_at`, `inmail_sent_at`, `inmail_response`, `inmail_response_at`. Updated by a future polling job; today these are empty.

Sub-tab toolbar specific: `View: Ready to send` filter chip filters to rows where `lpf_heyreach_rows.status = 'ready'` AND no action_sent state in any send column.

---

## I. Job Poster sub-tab — what gets built

Table renders one row per `lpf_job_poster_rows` entry. Columns grouped:

**Group A — Inherited reference.** `job_url`, `linkedin_profile`, `top_job_title`, `company_name`, `first_name`, `last_name`, `frau_herr_last_name`, `recipient_country`, `validated_work_email`.

**Group B — Phone waterfall.** Ten columns in strict order: `phone_datagma`, `phone_hunter`, `phone_rocketreach`, `phone_contactout`, `phone_prospeo`, `phone_wiza`, `phone_forager`, `phone_leadmagic`, `phone_pdl`, `phone_linkedin_api`. Each is an enrichment cell. Run condition for each: previous provider's cell is `success_empty` or `error`. The cell value is the raw phone number in international format (`+49 30 12345678`).

**Group C — Per-provider validation.** Ten cells: `valid_datagma`, `valid_hunter`, … each a Clay-AI-style scoring run that returns `{score: 0-1, plausible: bool}`. The cell renders `<Pill kind=success>0.92</Pill>` (high score) or `<Pill kind=warn>0.41</Pill>` (low). Drawer's Output panel shows the AI's reasoning ("Number matches DE country code; format consistent with German mobile prefix").

**Group D — Master arbitration.** A single `phone_waterfall_winner` cell. Renders the chosen phone with a small chip indicating which provider won (`📞 +49 ··· · via Hunter`). Drawer's About panel: "Selected highest-scored validated number across 10 providers."

**Group E — Routing.** Three HTTP action cells: `send_to_rf_company`, `send_to_rf_contact`, `send_to_rf_job`. Each posts to RecruiterFlow's endpoint with the assembled JSON. Cell renders `action_sent · 200` with the RF record link, or `action_dedup_skipped` if RF says the record already exists.

Sub-tab toolbar specific: a small live "waterfall heatmap" chip in the top-right showing recovery rate (`38% of contacts have a validated phone`).

---

## J. Run-condition explainer (`Explain` flow)

When the user clicks any `Run condition not met` cell, the drawer opens directly to §E.2 with the condition trace pre-rendered. There is no separate `Explain` modal — the trace IS the explainer. The cell renderer for `condition_not_met` includes a small invisible tap target on the cell so a click anywhere in the cell opens this view (don't require clicking the small italic text exactly).

The reason sentence template:

> Condition failed because `<varName>` was `<actualValue>`; required `<expected>`.

For multiple failures, join with `; `:

> Condition failed because `is_dach` was `false`; required `true`; AND `ctr_fit` was `low`; required `high|medium`.

If the function returned `false` but every evaluated input passed (i.e. there's a non-input business rule), the reason is:

> Condition evaluator returned false; see Evaluated inputs above for the full context.

The evaluator function lives in `lib/pipeline/columns.js` per column. Every evaluator MUST also write a row to `lpf_condition_traces` so the drawer can fetch it directly via `/api/pipeline/explain?jobId=&colId=`.

---

## K. Retry mechanics

**Per-cell retry.** Inserts a new row in `lpf_cell_runs` with `started_at = NOW()`, `status = 'running'`. The old row(s) are preserved. The orchestrator re-executes the column's function only — not the entire stage. UI sets the cell to `queued` optimistically, then `running` on SSE confirmation, then the new terminal state.

**Per-stage retry.** Sets `lpf_jobs.stage` back to the chosen stage. Marks all downstream cells (`stage >= chosen`) as `idle` (via `setPendingCellsState` so we don't clobber successes from earlier stages). The orchestrator re-runs forward from there. UI: the stage strip's affected dots all flip to `queued`, then `running` in order.

**Per-column retry.** Finds all jobs with this column in `error` state, kicks off a retry for each at the column's owning stage. UI: shows a toast `Retrying N jobs from <stage>`; progress bar at the top of the column header fills as cells transition.

For all three, the optimistic state must revert if the server returns non-2xx within 5s.

---

## L. Loading / empty / error states (every table)

**Loading.** 10 skeleton rows with shimmer at `opacity 0.4 → 1` 1.2s ease infinite. Skeleton bars match column widths.

**Empty filter.** A centered card 240px tall: `<icon> · No jobs match your filter · <button> Clear filter`. Icon is a magnifying glass with a question mark.

**Empty workbook.** A welcome card: `Welcome to Pipeline. Send jobs from Unprocessed to start.` with a button `→ Go to Unprocessed`.

**SSE disconnected.** 28px sticky banner across the table top, `background: rgba(245,158,11,.08)`, text `Live updates disconnected — retrying in 4s · Reconnect now`. Auto-counts down.

**SSE permanent failure (after 60s).** Banner turns red: `Disconnected. Refresh to retry.`

---

## M. Toast system

Bottom-right stack. Toasts slide in from the right (300ms ease-out), slide out the same way after their duration. Each toast: 12px medium text, 8/12 padding, 1px border in the type color, left border 3px solid in the type color.

Types: `ok` (green), `info` (blue), `warn` (amber), `error` (red).

Calls accept HTML (any string with `<` followed by a letter is treated as innerHTML), enabling clickable links inside toasts. Default duration 3200ms; explicit duration overrides allowed.

Max stack: 4 visible at once. Older toasts shift up. If a 5th arrives, the oldest evaporates immediately.

Hover any toast → pauses the dismiss timer. Mouseout resumes.

---

## N. Keyboard shortcuts (global)

| Key | Action |
|---|---|
| `j` / `k` | Next / previous row |
| `→` / `←` | Next / previous cell in the same row |
| `Enter` | Open cell drawer for selected cell |
| `Esc` | Close drawer / popup |
| `r` | Retry selected cell |
| `R` (shift+r) | Re-run from selected cell's stage |
| `g u` | Go to Unprocessed |
| `g p` | Go to Pipeline (last sub-tab) |
| `g 1` / `g 2` / `g 3` / `g 4` | Go to Company & Job / People / HeyReach / Job Poster |
| `?` | Open shortcuts cheatsheet modal |
| `/` | Focus search input on current tab |
| `Cmd/Ctrl+k` | Open command palette (later phase) |

When any input/textarea has focus, shortcuts are disabled (except Esc).

---

## O. Live updates (SSE)

The existing `/pipeline/events` SSE endpoint emits events. Frontend handles each event by mutating the in-memory store and calling a single DOM patch — no full table re-render. Events handled:

- `cell_state` — find the `<td data-job="X" data-col="Y">`, replace its inner HTML using `<CellRenderer>` with the new state. The change uses `view-transitions` API when supported (so the badge crossfades), falling back to a 120ms opacity tween otherwise.
- `stage_start` / `stage_done` / `stage_fail` — update the stage strip dot for that job. Update top-bar counters.
- `job_start` / `job_done` / `job_rejected` — update the row's left stripe and overall state. If the job is on a different sub-tab now, fade it out of the current tab.
- `field_running` / `field_done` — used by preflight steps (e.g. scraping description); render an inline note in the row's `Received` cell.
- `pipeline_start` / `pipeline_done` — update master Run/Pause button.

Reconnect: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s cap. The connection-state pill in Bar 1 reflects this live.

Column widths are reserved in CSS at table init so cell transitions never cause CLS (cumulative layout shift). Verify with `lhci` after major changes.

---

## P. Per-tab column registry rules (no UI affordance)

The registry is a code file. Every column is defined there with: id, tab, group, label, kind, provider, costHint, description, runConditionLabel, runConditionFn, outputFields, systemPromptKey (for AI), formulaSource (for formulas), endpoint (for HTTP actions), dedupKey (for action columns to detect already-exists).

The UI reads the registry at boot via `/api/columns`. It never writes back. No `+ Add column` button, no rename, no reorder, no edit-prompt, no edit-condition. If an engineer needs to change a column, they edit the file and re-deploy.

---

## Q. Bookkeeping that every action must do

Every state transition in a worker:

1. INSERT a row in `lpf_cell_runs` at start with `status='running'`.
2. UPSERT a row in `lpf_cell_state` with the new state.
3. WRITE a row in `lpf_condition_traces` with the evaluated inputs (even when the condition passes — owner needs the trace history).
4. EMIT a `cell_state` SSE event.
5. On completion, UPDATE the `cell_runs` row with `status`, `value` or `error_msg`, `duration_ms`, `ended_at`, `cost_usd`, `tokens_in`, `tokens_out`.
6. UPDATE the `cell_state` row with the terminal state.
7. EMIT another `cell_state` SSE event.

Bulk transitions (`setPendingCellsState`) write `cell_state` only, NOT `cell_runs` (no actual run happened). They do increment a separate counter, NOT `run_count` — add a new column `lpf_cell_state.transitions_count` if needed. The drawer's `Run count` shows `lpf_cell_runs` count, not transitions.

API key, token, secret, bearer values must be scrubbed from any `inputs_json`, `raw_output`, or log line before persistence. Use a single sanitizer in `runCell.js`.

---

## R. The smoke test (proves it's done)

Recap from the handoff. Run end-to-end:

1. Open `/`. Two pills, Unprocessed active.
2. Import a CSV with one row → row appears in Unprocessed with all columns populated (Country, City filled — no em-dashes).
3. Tick the row. Bulk toolbar appears with **visible** buttons on dark theme.
4. Click `▶ Send to Pipeline`. Toast appears with `View in pipeline →` link. Row gets blue stripe, blue "Queued" pill replaces ▶, row fades out after 1.2s.
5. Counters: pending −1, running +1. SSE-driven.
6. Click `View in pipeline →`. Lands on Pipeline → Company & Job, sub-tab strip visible. New row at top with stage strip showing `◐○○○○○○`.
7. Within 2s, `dach` cell flips to `● DACH ✓` (success, instant). **Does NOT show `OPENAI_API_KEY` even if the SAP-check AI call fails.**
8. Stage 1 SAP check runs (spinner + `Running…`). If it errors (e.g. unset key), only that cell shows `Error`. DACH/Direct/Score/Fit keep their states.
9. Click the errored cell. Drawer opens with: Status (error class, full message), Run condition (passes), About (provider OpenAI, model gpt-4o-mini), Inputs (job_title, description, etc.), System prompt (full), User prompt (filled), Output (empty — error block instead), Run history (1 entry), Footer with Retry button.
10. Click `▶ Run again`. Cell instantly flips to `queued`, then `running`, then `success` or new error. New `lpf_cell_runs` row created. Run count in drawer increments to 2.
11. Continue through stages. Stage strip fills `●●●●●●●`.
12. After Stage 7, `write_to_people` action fires → cell state `action_sent · 200`. People sub-tab now has rows for this job.
13. Click Pipeline → People. New rows visible, going through email waterfall.
14. When a person hits `validated_work_email`, `write_to_heyreach_table` action fires → HeyReach sub-tab gets a row. The `connection_req` cell shows German text ≤299 chars after the claygent runs.
15. When a person flagged as job poster (and has no phone), `write_to_job_poster_table` fires → Job Poster sub-tab gets a row. Phone waterfall begins.
16. From any cell drawer, retry. From any stage in the row drawer, retry-from-stage. Both create proper `cell_runs` rows. Old rows preserved.
17. Pause pipeline via top button. Banner. Within 30s the `running` counter goes to 0.
18. Resume. Cells flow again.
19. Open Activity drawer. Filter to Errors. Click any jobId pill → navigates to that job's row, drawer-selected.
20. Open cost bar drill-down. Today's total matches `SELECT sum(cost_usd) FROM lpf_api_costs WHERE started_at::date = today`.
21. Visit Unprocessed → filter to `Rejected`. The previously-rejected jobs are listed with reasons on hover.

If any of those 21 steps misbehave, the rebuild isn't done.

---

## S. Out of scope, on purpose

- Column edit / add / delete UI.
- Prompt editor UI.
- Condition editor UI.
- Drag-to-reorder columns or rows.
- User accounts, permissions, sharing.
- Sculptor / Signals / Use AI sidebars.
- Multi-tenancy / multi-workbook (we have two workbooks total, hard-coded).
- Cross-row aggregations / formulas / pivots.
- Excel/CSV export beyond the existing CSV import (that's existing — keep it).
- Anything that lets an operator change behavior without a code change.

If a feature isn't listed in A–R, don't build it.
