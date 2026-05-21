# LPF Clay Workbook — Exact Clone Specification

> **Goal.** Build a 1:1 visual + functional clone of the Clay LPF-DACH workbook. Same tables, same columns, same row interactions, same right-side cell details, same column-configuration view (read-only), same enrichment outputs, same run conditions, same prompts. The only thing operators can't do is add or edit columns — every column is pre-defined in code, displayed as if it were Clay's "Edit column" panel but in read-only mode.
> **Theme.** Light, minimal, information-dense. Get the data right first; the UI is plain.
> **No redundant-deletion judgement.** A Clay column that exists but always shows "Run condition not met" is still required — copy it as-is. We are not pruning.

---

## 1. The flow (mental model for the developer)

```
JPE  ──POST──▶  intermediate DB                       ┐
                       │                              │  Two ingest paths
                       │  (local server polls)        │
                       ▼                              │
            ┌────────────────────────────────────┐    │
            │ 1. Company Splitter table          │ ◀──┘
            │   (entry — every job arrives here)  │
            └─────────────────┬──────────────────┘
                              │  filters: is SAP? is DACH? is direct (not agency)?
                              │  lookups: dedupe against G-Sheet + CRM
                              │  No company enrichment yet.
                              │
                              │  (if all pass)
                              ▼
            ┌────────────────────────────────────┐
            │ 2a. Companies (Local Perfect Fit)  │
            │   enrich firmographics, geocode,    │
            │   build personalization variables   │
            └────────┬──────────────────┬────────┘
                     │                  │
                     │                  └──▶ Phone (Job Poster) table
                     │                       (hiring-manager phone waterfall — 10 providers)
                     ▼
            ┌────────────────────────────────────┐
            │ 3a. People (Local Perfect Fit)     │
            │   find contacts (Apollo, LinkedIn,  │
            │   AI search), validate emails,      │
            │   classify roles                    │
            └────────┬──────────────────┬────────┘
                     │                  │
                     │                  └──▶ LPF — HeyReach Implementation
                     │                       (LinkedIn outbound: ConReq, InMail, campaign routing)
                     ▼
            ┌────────────────────────────────────┐
            │ CRM Send Tables (RecruiterFlow)    │
            │   • Send Company data into CRM     │
            │   • Send Contact data into CRM     │
            │   • Send Jobs data into CRM        │
            └────────────────────────────────────┘
```

Every arrow is a Clay "action column" that writes a row into the next table when its run condition passes.

---

## 2. The eight tables to build

Mirror the Clay workbook exactly. Each table is its own page in the UI; each is backed by its own DB table. **Do not merge tables.** Do not omit columns even if some always evaluate to `Run condition not met` — the operator needs to see the whole picture.

| # | Table (clone name)                              | Source Clay table                          | Rows in source | Cols | Cost/row |
|---|--------------------------------------------------|--------------------------------------------|----------------|------|----------|
| 1 | **Company Splitter**                             | `1. Company splitter` (`t_5IxlKc9vv2JZ`)    | 15,130         | 61   | 1 cr     |
| 2 | **Companies (LPF)**                              | `LPF-DACH: 2a. Companies` (`t_yyZOKlMfcYp7`) | 15,095         | 90   | 9 cr     |
| 3 | **People (LPF)**                                 | `3a. People (Local perfect fit)` (`t_iyen4PVo4SI5`) | 16,005    | 98   | 0.8 cr   |
| 4 | **HeyReach**                                     | `LPF - HeyReach Implementation` (`t_5hFBJS6c4haa`)  | 15,015    | 61   | —        |
| 5 | **Job Poster (Phone)**                           | `Phone (Job Poster)` (`t_yz33ovqbNW6K`)             | 3,623     | 62   | 10.9 cr  |
| 6 | **CRM · Send Company**                           | `Send Company data into CRM` (`t_0t7coupxxXKtuHJDvr2`) | 5,687  | 27   | —        |
| 7 | **CRM · Send Contact**                           | `Send Contact data into CRM` (`t_0t6qcewD5db75EcXmiB`) | 39,761 | 62   | —        |
| 8 | **CRM · Send Jobs**                              | `Send Jobs data into CRM` (`t_0t6zrj2KwcYRn8SmSYt`)   | 12,464 | 100  | —        |

Plus one workspace-level lookup:

- **DACH Countries** — backs the Clay `Lookup DACH countries` (`t_9M2nIP1lhWD6`). A small static table of allowed DACH country codes/names. Used by Company Splitter and People filters.

To gather the exact column list, prompts, run conditions, and accounts for each table, re-open the Clay workbook (`https://app.clay.com/workspaces/39601/workbooks/wb_6HyESRMSPnDU/all-tables`), open each table, and click each column header → "Edit column" panel. Capture the configuration verbatim. `LPF_DACH_DataFlow_Map.md` in the parent doc folder already contains most of this; treat it as the source of truth and only re-confirm anything ambiguous.

---

## 3. The Clay table view — exact UI to reproduce

This is what every one of the eight tables looks like and how the operator interacts with it. Same layout. Same widgets. Just light themed.

### 3.1 The top toolbar (table-level)

A single horizontal strip across the top of the table area, light gray border below.

Left side, in order:
1. **Auto-run toggle.** A pill with a circular arrow icon and the text "Auto-run". When on: green dot indicator, green border. When off: gray. Clicking toggles. Beside it, a small green badge with a number — the count of columns currently running automatically (e.g. "6").
2. **View name.** Default text: "Default View". (We have one view; no view switcher.)
3. **Column visibility counter.** "N/N columns" (e.g. "61/61"). Click → opens a column visibility checklist panel where the operator can hide/unhide columns. Cannot rename, edit, reorder, or delete — only show/hide.
4. **Row count.** "N/M rows" (e.g. "15,130/15,130"). The denominator is the total in the table; the numerator is the count after filters.
5. **Filter icon (funnel).** Click → opens a "Filters" panel where the operator builds row filters (AND/OR clauses against any column). Filters persist per browser. Predefined filter chips are NOT in scope — only the free-form filter builder.
6. **Sort icon.** With a count badge (e.g. "1" if one sort is applied). Click → sort builder.
7. **Search icon (magnifier).** Click → search box drops down; searches every visible column for the text.

Right side:
8. **"Sculptor" button.** Hidden (out of scope for clone; do not build).
9. **User avatar.** Hidden (single-user app).

### 3.2 The progress row (row 0)

Below the column headers, before any data row, there's a strip showing each column's completion percentage as a thin horizontal progress bar. Looks like a header continuation:

- Color: green portion = % of rows in success / success_empty / condition_not_met (terminal states); remainder is light gray.
- A small percentage label sits inside the bar at the right end ("22%", ">99%", "0%").
- A small "play next" icon at the bar's right end — clicking runs all not-yet-run cells in that column.

### 3.3 The column header

Two stacked elements per column:

**Line 1.** Provider icon + column-type icon + column name + optional badges.

- **Provider icon (left, 14px).** Color-coded by the operation provider:
  - OpenAI / Claygent AI: small green sprout icon
  - Apollo: purple diamond
  - Proxycurl: yellow gear
  - Findymail: blue droplet
  - Apify (web scraper): pink spider
  - HeyReach: orange chain
  - RecruiterFlow: red briefcase
  - Google Sheets: green sheet icon
  - HTTP API generic: dark gray globe
  - Formula: blue fx
  - Lookup: gray link icon
  - Webhook source: cyan arrow-in
  - Internal/Text: T

- **Column-type icon (right of provider).** Standard glyphs:
  - `T` for text
  - `fx` for formula
  - 🔗 / link icon for URL
  - ☎ for phone
  - ✉ for email
  - ▶ for action (Click to run)
  - 🔎 for lookup
  - 🤖 robot for AI/Claygent

- **Column name.** Mono-ish, 12px, dark gray on white.

- **Badges (right side).**
  - Webhook source columns show a small count badge of how many webhook endpoints feed in (e.g. "6").
  - Action columns show a small ▶ play icon allowing immediate "Run all empty cells in this column".
  - When errors exist in this column for visible rows, a small red ↻ icon appears.

**Line 2.** The same progress bar described in §3.2 directly under each column header — segmented green (success), light gray (empty), red (error). At the right end, the percentage in mono.

**Right-click on column header — context menu (clone view-only mode):**
- View column details (read-only — opens the Edit Column panel described in §5)
- Run column ▸ (submenu: All empty cells / All cells / Errored cells / Cancel running)
- Filter on this column
- Hide column
- (No rename, no edit prompt, no edit condition, no duplicate, no save as function, no delete.)

### 3.4 The rows

- 36px row height, light gray bottom border (`#e5e7eb`).
- Alternating row color: even rows pure white, odd rows `#fafafa` for readability.
- First column is the **row number** (mono, gray) — clickable to select the row. Doubles as a "this row's controls" gutter.
- Second column (when present) is the **row checkbox** — for bulk selection.
- Then the data columns flow left-to-right exactly in the order the Clay table shows them.

Hover a row: very subtle highlight `#f3f4f6`.
Selected row (clicked anywhere except a link): `#eff6ff` background, 1px blue left border.

A small ▶ icon appears in the row's gutter when the row hasn't been processed yet (status "received" or similar). Click → run that single row through the pipeline.

### 3.5 The cells

Cells render their value in plain text by default. State-specific overrides:

| State | What the cell shows |
|---|---|
| Empty / not started | gray "—" |
| "Click to run" | gray italic with a small ▶ — for action cells that have a run condition met but haven't fired yet (rare; usually auto-run handles this) |
| Running | small spinner + "Running…" in blue |
| Success | the actual value (text, number, URL, etc.) — see §4 for type-specific rendering |
| Success but no value | gray italic "—" with a "ran successfully" tooltip |
| **"Run condition not met"** | gray italic text. The condition failed for this row. Clicking the cell opens the explainer (§6.4). |
| **"Miss"** | gray italic — used by some Clay action cells to indicate the row didn't match the action's filter. Same UX as condition not met. |
| **"Missing input"** | gray italic — input column referenced is empty for this row. |
| Error | red text "Error · click to see why" with a tiny ↻ icon. Drawer shows the error and a Retry button. |
| Action sent | "Sent · 200" green pill (HTTP OK); tooltip shows when. |
| Action de-duplicated | "Already exists" gray pill — the row matched a dedupe lookup and the action skipped the call. |

**Truncation.** Long values are clipped to the cell width with `…` ellipsis. Hovering for 350ms shows a popup with the full value.

**Double-clicking a cell** opens an in-place expand popup with the full value and a corner "expand to drawer" icon. Pressing Esc closes it.

---

## 4. Column types and how they render in cells

Take these straight from Clay. Every cell renders based on its column's `kind`:

- **Webhook Source.** Cell shows "Received <date> at <time> GMT…". No edit.
- **Text.** Plain text value (mono for codes, sans-serif for descriptions).
- **Number.** Right-aligned mono. Thousands separator. Negative numbers in red.
- **Boolean.** Centered "✓" (green) or empty. Some columns use "Yes"/"No" text — match Clay's per-column choice.
- **URL.** Small link icon + the truncated URL. Click opens in new tab. Hover popup shows full URL.
- **Email.** Email-icon + address. Click copies to clipboard with a toast "Copied".
- **Phone.** Phone-icon + international-format phone number.
- **Date / Timestamp.** "Apr 28, 2026 at 4:00 PM GMT+05:30" — match Clay's format exactly.
- **Formula.** Renders the computed value. The formula source is visible in the Edit Column panel (§5) but not in the cell.
- **Lookup.** Shows the looked-up value or "—". The lookup target table + key column are shown in §5.
- **Action (Google Sheets / HTTP / Document / Write-to-table / Add-row).** Shows the state pill (Click to run / Running / Sent · 200 / Run condition not met / etc.). Click → drawer with request body + response.
- **Claygent AI Web Research.** Shows the AI's output (often a JSON snippet — render the most useful field; full payload in drawer).
- **AI Model (direct LLM).** Shows the AI's primary returned field (often a classifier label or a JSON value).
- **Geocoder.** Shows "lat, lng" pair. Hover popup shows the geocoder confidence / source.

---

## 5. The "Edit Column" panel — VIEW-ONLY

Click any column header (left-click) → a right-side panel slides in titled "Column · `<column name>`". This is the **most important panel in the app** because it's how the operator understands what a column actually does. Read-only — no save button, no edit affordances. Match Clay's Edit Column layout but with input fields rendered as labeled read-only blocks.

Panel content (in this order):

### 5.1 Header
- Column name (large).
- Provider icon + provider name (e.g. "Claygent · OpenAI GPT-4o-mini").
- Column type chip (e.g. "AI Model", "HTTP API Action", "Formula", "Webhook Source").
- Status: green "Enabled" or gray "Disabled" pill.
- Quick stats: average cost per run, average duration (last 30 days from `lpf_api_costs`).

### 5.2 Description
The column's purpose, in 1–2 sentences. Sourced from Clay's "Edit description" field for that column.

### 5.3 Account / API connection
- Provider account name (e.g. "CTR-BM-Clay-Tables-1 OpenAI API Key"). Don't reveal the key itself.
- Endpoint (for HTTP actions; e.g. `POST https://recruiterflow.com/api/external/client/add`). Headers shown with sensitive values masked.

### 5.4 Inputs
A table of "Input variable → Source column" rows. For Claygent / AI columns, the inputs are the variables the prompt references (e.g. `{{company_name}} → Company Name`).

### 5.5 Run condition
- The condition as a single readable line (e.g. `is_dach == true AND ctr_fit IN {high, medium}`).
- A "Why" subsection that — when the panel is opened in the context of a specific row — shows the row's evaluated inputs and pass/fail per clause (see §6.4).

### 5.6 Configuration body — varies by column type

For **AI / Claygent columns**:
- **Model** (e.g. GPT-4o-mini).
- **Temperature**, **max tokens**, **JSON mode** (if applicable).
- **System prompt.** Rendered in a fenced code block, full text, copy button. Verbatim from Clay (do not paraphrase, do not summarize, do not "clean up").
- **User prompt template.** Rendered in a fenced code block with `{{placeholder}}` slots highlighted. A toggle "Show with row N filled in" replaces placeholders with actual values from the currently-selected row.

For **HTTP API columns**:
- Method, URL, headers (sensitive masked).
- Body template (JSON code block, placeholders highlighted).
- Retry policy (e.g. "max 5 retries on 429, 502, 503, 501").
- Dedupe key (e.g. "lookup against `lpf_jobs.company_url`").

For **Formula columns**:
- The formula source in a code block.
- A "Show evaluated for row N" toggle that substitutes the row's values inline.

For **Lookup columns**:
- Target table + key column + return columns.
- A "Preview lookup result for row N" block.

For **Geocoder / Scraper / Doc-generator columns**:
- Whatever configuration Clay shows — pixel-for-pixel.

### 5.7 Output
- The fields this column writes back into the row (e.g. `is_sap`, `quality_score`, `ctr_fit`).
- For columns that route to another table, the target table + which columns are mapped.

### 5.8 Run history
- A small table of the last 10 cell runs for this column (across all rows or for the selected row). Same content as the cell drawer's run history.

### 5.9 Cost & usage
- Total spent on this column today / this week / this month.
- Number of cells in each state, with bar chart.

There is **no "Save"** button anywhere on this panel. Closing the panel discards nothing because there's nothing to save.

---

## 6. The cell drawer (per-row, per-column)

Single-click on a data cell (not a header) → right-side drawer specific to that one cell. This is different from §5: that's the column's configuration; this is one cell's runtime result.

### 6.1 Header
- The column label and the row identifier (e.g. "DACH · Job #1234").
- A "View column config" link → opens §5.
- An "✕ Close" button.

### 6.2 Status
- Current state (Pending / Running / Success / Success-empty / Condition-not-met / Error / Action-sent / Action-skipped).
- Run count (how many times this cell has been executed).
- Last run timestamp.
- Duration of last run.
- For running cells: live elapsed counter.

### 6.3 Run condition trace
A small evaluated-inputs table:
```
is_dach          true            required: true              ✓
ctr_fit          "low"           required: high | medium     ✗
quality_score    4               required: ≥ 6               ✗
```
And a one-line reason sentence when the condition fails. When the condition passes, show all green ✓s.

### 6.4 The "Why this didn't run" explainer
When state is `condition_not_met`, the drawer puts §6.3 at the top with a red banner "Run condition not met" and a single human sentence:

> Condition failed because `ctr_fit` was `"low"` (required `high` or `medium`).

For multiple failures, join with semicolons. This matches Clay's "Explain" output but is always visible, no extra click.

### 6.5 Inputs used (for this run)
A key/value list of the actual input values used. Same as §5.4 but with the row's values filled in.

### 6.6 AI prompt + output (for AI columns)
- System prompt — collapsible code block.
- User prompt — code block with placeholders already substituted.
- **Raw output** — the full JSON or text the LLM returned, in a code block. Long outputs scroll inside a fixed-height pre.
- **Parsed/stored fields** — the structured fields the pipeline wrote back into the row.
- **Cost** — `$0.0008 · 1,234 in / 567 out tokens · 1.4s · gpt-4o-mini`.

### 6.7 HTTP request + response (for action columns)
- Method + URL.
- Request headers (sensitive masked).
- Request body — code block.
- Response status + headers (relevant ones).
- Response body — code block.
- "Copy as cURL" button (un-masks on confirm).

### 6.8 Run history
Last 10 runs for `(this row, this column)` — date, duration, state, error class, cost. Click any row to view that historical run's data above.

### 6.9 Footer
- ▶ Run again (primary).
- ↻ Re-run from this stage onwards.
- ✓ Mark reviewed.

---

## 7. The row drawer (per-row, all columns)

Click the row-number gutter (not any specific cell) → a row-level drawer.

- **Job / contact header card** — title, key fields, source pill, received timestamp.
- **Stage timeline** — vertical list of every stage this row passes through, with status icon (pending circle / running pulse / success check / skipped strikethrough / error cross), duration, summary message, and a per-stage retry button.
- **All columns at a glance** — every column for this row in a long compact list, showing only state pill + value preview. Click any entry → opens that cell's drawer (§6).
- **Routing summary** — did this row write to People? HeyReach? Job Poster? CRM? Each with a destination link.
- **Footer** — Re-run pipeline / Reject row / Force send to review.

---

## 8. Webhook + DB-poll ingestion

JPE cannot reach `localhost`. The ingest model is:

1. **JPE → Intermediate DB.** JPE POSTs payloads to a shared/remote PostgreSQL table (the "ingest bus"). Connection details in `.env`: `INGEST_DB_URL`, `INGEST_DB_TABLE` (e.g. `lpf_ingest`).
2. **Local server polls every N seconds.** A scheduled poller (default every 10s, configurable via `INGEST_POLL_INTERVAL_MS`) selects rows from the ingest table where `id > last_seen_id`, inserts them into the local Company Splitter table (`lpf_jobs` with `source = 'jpe_webhook'`), and marks the watermark.
3. **Direct webhook still works.** Keep `POST /webhook/lpf` functioning so JPE (or any other source) can hit it directly when reachable.
4. **CSV import path** continues to exist. When a row arrives via CSV, the Company Splitter table also runs an HTTP POST eligibility check (one-shot column — leave the endpoint blank in `.env` for now, fall back to "pass-through" until the operator configures it).

The Company Splitter table shows the source for each row: `jpe_webhook · ingest_db` / `jpe_webhook · direct` / `csv_import` / `manual_test`. Rendered as a small chip in the Source column.

A small "Ingest" widget on the Company Splitter page header shows: last poll time, next poll in N seconds, rows ingested in last 24h. A manual "Poll now" button forces a poll.

---

## 9. Apollo People Finder — exact integration

The People (LPF) table uses Apollo's People Search to find contacts at each qualified company. Match Clay's column behavior exactly.

### 9.1 The column
Column name: `Find People (Apollo)` (matches Clay's column id pattern from `3a. People`).

Column type: HTTP API Action.

### 9.2 Inputs (Clay column inputs)
- `company_domain` (from the upstream Companies row)
- `seniority_filter` — array of seniority levels (e.g. `["founder","owner","c_suite","vp","director"]`)
- `role_filter` — array of role categories (e.g. `["it","engineering","operations","human_resources","sales"]` — match exactly what's in Clay)
- `country_filter` — `["Germany","Austria","Switzerland"]` from the DACH lookup
- `page_size` — typically 25 or 50

### 9.3 Endpoint
`POST https://api.apollo.io/v1/mixed_people/search`

Headers:
- `Content-Type: application/json`
- `Cache-Control: no-cache`
- `X-Api-Key: <APOLLO_API_KEY>` (from `.env`)

### 9.4 Body template
```json
{
  "q_organization_domains": "{{company_domain}}",
  "person_seniorities": ["c_suite","vp","director","owner","founder","head","manager"],
  "person_titles": ["CEO","CTO","CIO","CISO","VP Engineering","Director of IT","Head of IT","SAP","Hiring Manager","HR","Human Resources"],
  "person_locations": ["Germany","Austria","Switzerland"],
  "page": 1,
  "per_page": 25
}
```

(Reconfirm exact body from Clay's Edit Column panel for `Find People` and any sub-variants — Clay has multiple Apollo columns for different role buckets: CEO/Owners, IT & Tech, HR. Each is its own column with its own body template.)

### 9.5 Output mapping
For each person returned:
- `apollo_id`, `first_name`, `last_name`, `full_name`, `title`, `seniority`, `email_status`, `linkedin_url`, `organization_id`, `organization_name`, `city`, `state`, `country`.

Stored as rows in `lpf_contacts` linked to the originating `job_id` / `company_url`.

### 9.6 Cost
Apollo credits per call: typically 1 credit per result returned. The CostTrackerService should record `credits_used` and not `cost_usd` (Apollo charges by plan, not per-call dollars). Surface in the cost bar's Apollo chip.

### 9.7 Dedupe
Before writing a contact to `lpf_contacts`, check by `apollo_id` (or `linkedin_url` if Apollo id absent). If exists, skip with `action_dedup_skipped`.

### 9.8 Rate limits & retry
Apollo's rate limit: typically 60 calls/min on standard plan. Retry on 429 with exponential backoff (1s, 2s, 4s, max 30s). Max 5 retries. Other 5xx — same. 4xx other than 429 — surface as error, do not retry.

---

## 10. The eight tables — per-table column briefs

For each table below: the gist of what every group of columns does, sourced from the LPF DataFlow Map. **Don't omit a single column when implementing**; the brief here is just the structure. When in doubt, open the Clay workbook and copy the full configuration verbatim.

### 10.1 Company Splitter (61 columns)

**Source.** Webhook (6 distinct endpoints feed in: "Pull in data from a Webhook", "Pull in data from a Webhook (1)", "(2)", "(3)", "From Nathan codebase", "From Nathan's Codebase (round 2, test)").

**Job basics.** `[Top job] Title`, `Top job post URL`, `[Top job] Description`, `[Top job] City`, `[Top job] Country`.

**Validation gates (formulas).** `HasKeywordsInText`, `Sandboxed?`, `Job title okay`, `Bypass Sandbox2`, `IsSAPandKeywords`, `10Mar-DoNotRunThese`, `Is recruitment?`.

**SAP classifiers (AI).** `isSAP Job version B.2`, `is_SAP_focused_Job_AI`, `isSAP Job version B.2 (2)`.

**Geographic.** `Company Long / Lat` (Claygent geocode), `Candidate Long / Lat` (Claygent geocode), `Distance (km)` (formula), `Lookup DACH countries` (lookup).

**Variations & metadata.** `Random number`, `Variation number`, `Job Post Number`, `Date Time Inserted`, `Created At`, `Updated At`.

**Legacy / disabled.** `SAP Jobs Sheet` (Google Sheets add-row, deprecated), `HTTP API` (eligibility POST — leave URL blank), `DACH Employees Number [disabled]`, `[Disabled] World Employee Estimate`.

**CV generators (disabled but visible).** `English CV`, `English CV v2`, `CV German`, with three `Create document` action columns. Show as disabled status pills.

**Document scraping.** `Scrape Website` (Apify), `Indeed Body Text`.

**Routing actions.** `Write to 2a [enabled]` (writes to Companies table when `Successful=true`), `Write to 2b1 Table` (writes to external workbook — keep as-is), `Add row`, `sendToJobCollection`.

**Success flag.** `Write To Successful`, `Successful` — formulas that gate the Write-to-2a action.

**Lookups.** `Lookup Single Row in Other Table` (cross-references Companies table for dedup).

### 10.2 Companies (LPF) — 2a. (90 columns)

Receives rows from Company Splitter's `Write to 2a` action. Enriches the company.

**Inherited from Splitter.** Company name, URL, LinkedIn, domain, top-job title, description, city, country, etc.

**Domain cleaning.** `Domain Extraction` (formula: strip linkedin URL → pure domain).

**Firmographic enrichment (Proxycurl).** `Company industry`, `Company description`, `Employee count (world)`, `DACH employee count`, `HQ city`, `HQ country`. Each is a Claygent or Proxycurl HTTP call.

**Tech extraction (AI).** `SAP modules`, `City · Industry`, `Tech comma`, `SAP skills comma`, `tech_combined`, `tech_short`, `tech_short2`, `tech_compressed`, `tech_longer`, `top_job_tech_comma`, `primary_tech`, `dev_or_engineer`, `a_dev_or_engineer`, `dev_or_eng`, `shorter_tech_description`, `shorter_tech_description_scrambled`, `shorter_tech_comma`, `comma_tech_description`.

**Personalization variables (AI).** `imagined_city`, `imagined_nearby_city`, `imagined_industry`. These get used by HeyReach for outbound copy.

**Quality scoring.** `quality_score`, `seniority`, `ctr_fit`, `is_sap`, `is_direct_employer`, `is_dach`.

**Routing actions.**
- `[OUTPUT] Add Apollo people to table` — writes to People table.
- `[OUTPUT] Add LinkedIn people to table` — writes to People table.
- `Write to Job Poster Table` — writes to Job Poster (Phone) table for the hiring manager.
- `Write to 2b3 Job Poster Extraction` — cross-workbook (keep as-is).

**Lookups.** `Lookup Company in 2a` (dedup), `Lookup Job Poster URL`.

### 10.3 People (LPF) — 3a. (98 columns)

Receives rows from Companies via the two "Add people" actions. One row per person.

**Identity.** `First name`, `Last name`, `Full name`, `LinkedIn URL`, `LinkedIn Username`, `Person LinkedIn URL`, `Final Person LinkedIn URL`, `Merged Person LinkedIn URL`.

**Location filtering.** `Recipient location (raw)`, `RecipientCountry`, `Country (LinkedIn)`, `RecipientCountryMerged`, `Lookup Record in DACH Countries Table`, `PresentInDACHOrNoLocation`, `Recipient or Candidate location (filtered)`.

**Role classification (AI).** `Developer or Engineer` (Claygent classifier), `dev or eng` (short), `dev or engineer` (expanded), `a dev or an engineer` (grammatical variant).

**Salutation (AI).** `German Gender Identification`, `Frau / Herr + Last Name`, `Frau / Herr + Last Name Cleaned`, `Last Name Cleaned`.

**Email finding (waterfall).** `[waterfall] Validated Work Email` (the primary waterfall column). Component columns: `Validate Email [Apollo]`, `[waterfall] Findymail`, `Validate Icypeas (2)`, `Validate Enrow (2)`, `Validate LeadMagic (2)`, `Find Work Email`, `Find Work Email (2)`, `Find work email`, `Email_From_QC`, `Job Poster Email [Apollo]`.

**Email derivation.** `Email Domain`, `Work Email`.

**LinkedIn enrichment.** `LinkedIn Profile` (cached), `Open Profile (2)`, `Bulk Data Scraper` (RapidAPI), `Rapid API Fresh`.

**SAP/IT gating.** `SAP Existence Check` (Apollo HTTP), `Sap exist?` (formula), `IT Role Verification` (Apollo HTTP), `HOT IT job title?`, `Non-Product-Project Role`, `sap_skill_comma`, `[Top Job] Tech-comma`.

**Apollo enrichment.** `Apollo Enrich Person HTTP API` — full person enrichment from Apollo when LinkedIn URL alone isn't enough.

**Employment verification.** `Employment Verification`, `Employment Verification (2)`, `Employment Verification Status`.

**Find leads APIs (Apollo / LinkedIn / Find People).** `Find leads` (appears multiple times — one per role bucket).

**Dedupe & QC.** `Not in LPF or is new?`, `Temp_key`, `Lookup Single Row in Other Table`, `Lookup Row in QueryCache`, `Add Row to QC`.

**Routing actions.**
- `Add Lead to Campaign` (Instantly)
- `DISABLED-[OUTPUT] Add to Instantly` (kept visible, disabled state)
- `[HTTP API] Fetch Campaign Name - Instantly` + `Instantly - Campaign Name`
- `Add Row to Google Sheet`
- `Write to HeyReach Table` — fires when `Validated email present AND profile complete AND DACH`.
- `Send table data` (final webhook).

**Source tagging.** `Job source`, `Added By`, `Skipped Count`, `Group`, `Formula`, `Formula (2)`.

### 10.4 HeyReach (LPF - HeyReach Implementation) — 61 columns

Receives rows from People when conditions match. LinkedIn outbound.

**Inherited.** LinkedIn Profile, Job URL, Title - Experience, longer_tech_description, First Name, Last Name, Frau / Herr + Last Name, Full Name, Company - Experience, Company LinkedIn URL, Company Domain, RecipientCountry.

**Region check.** `DACH Region Check`.

**AI personalization vars.** `tech_names_person_type`, `tech_names_person_type [for missed entries]`, `tech_names_person_type_merged + Subject`, `shorter_tech_description_scrambled`, `imagined_nearby_city`, `imagined_city`, `imagined_industry`, `Job_posting_intro`, `imagined_city_sentence`, `imagined_industry_sentence`.

**Message generation (AI).** `Subject Test`, `English Inmail`, `Message Translation`, `InMail Body in DE`, `Connection Req`.

> The `Connection Req` column uses the verbatim German prompt from the Clay column (Col 37). It produces a German LinkedIn connection request capped at 299 characters. Copy the prompt exactly — operators rely on its specific wording.

**Routing formulas.**
- `Hot Job title (ConReq → Inmail)`
- `Connect Only`
- `Open Profile`
- `ConReq + Inmail`
- `ConReq → Inmail`
- `Free Inmail Heyreach (2)`
- `Free Inmail Heyreach`
- `ConReq Only (2)`
- `ConReq Only Criteria`
- `Free to inmail`

**HeyReach actions (HTTP).**
- `Free Inmail Heyreach` → campaign **"LPF JD 2 (free to inmail)"**
- `ConReq + Inmail` → campaign TBD (extract from Clay)
- `ConReq → Inmail` → campaign TBD
- `Connect Only` → campaign TBD
- `ConReq Only (2)` → campaign TBD

**Job Poster handoff.** `Job Poster`, `Poster Source`, `Job Poster? Write 2 table` — writes to the Phone (Job Poster) table.

**Email waterfall reference (inherited).** `[waterfall] Validated Work Email`, `Job Poster Email [Apollo]`, `Validated email from 3a`.

**Lookups.** `Lookup Single Row in Other Table` (×3 — for various cross-references), `LI Username + Job URL Key`, `Top Job Title`.

**Conversation tracking.** `conreq response`, plus several "Unknown column" placeholders that exist in Clay — keep them as visible empty columns until reconfirmed.

### 10.5 Job Poster (Phone) — 62 columns

Receives rows from Companies/People when the hiring-manager phone is needed.

**Reference (cols 1–15).** Job URL, LinkedIn Profile, Job Title, Company info inherited from upstream.

**Domain & contact (cols 16–30).** Domain extraction, geo, email validation, contact JSON.

**Phone waterfall (cols 31–47).** 10 providers in strict order — each runs only if the previous returned empty:
1. Datagma
2. Hunter
3. RocketReach
4. ContactOut
5. Prospeo
6. Wiza
7. Forager
8. LeadMagic
9. People Data Labs
10. LinkedIn API (direct)

**Validation gates (cols 48–54).** Each provider has a paired Clay-AI validation column that scores plausibility (correct country code, format, not a generic switchboard).

**Master arbitration (col 55).** `Waterfall` — selects the highest-scored validated phone.

**Routing (cols 58–60).** `Send to RecruiterFlow Company`, `Send to RecruiterFlow Contact`, `Send to RecruiterFlow Jobs` — same endpoints as the CRM Send tables (§10.6–10.8).

### 10.6 CRM · Send Company (27 columns)

Receives qualified companies. Writes to RecruiterFlow's company endpoint.

**Endpoint.** `POST https://recruiterflow.com/api/external/client/add`

**Auth.** Header `RF-Api-Key: <RF_API_KEY>` (from `.env`), `Content-Type: application/json`.

**Retry.** Max 5 retries on 429, 502, 503, 501.

**Inherited fields.** Company name, domain, LinkedIn URL, industry, employee count, HQ location, country.

**Dedup formulas.** `CRM Name lookup status`, `CRM Name lookup status (2)` — two-pass dedup. Send-action only fires if **both** indicate the company doesn't exist in RecruiterFlow.

**Payload builder.** `Company Info JSON` — assembles the POST body.

**Action.** `HTTP API → Send Company data to RecruiterFlow`.

Expected pattern: ~95% of rows show `Run condition not met` (already exists); ~5% show `Sent · 200` (newly added).

### 10.7 CRM · Send Contact (62 columns)

Receives all contacts. Writes to RecruiterFlow's contact endpoint.

**Endpoint.** `POST https://recruiterflow.com/api/external/contact/add` (same auth/retry as §10.6).

**Inherited.** Contact identity (name, email, phone, LinkedIn URL, title), company linkage (name + domain — used to associate with the parent company in RF; the company must already exist via §10.6).

**Dedup.** `CRM Contact lookup status` formula.

**Payload builder.** `Contact Info JSON`.

**Action.** `HTTP API → Send Contact data to RecruiterFlow`.

**Tags / source / pipeline metadata** — sent in the payload for RF segmentation.

### 10.8 CRM · Send Jobs (100 columns — largest)

Receives qualified jobs. Writes to RecruiterFlow's job endpoint.

**Endpoint.** `POST https://recruiterflow.com/api/external/job/add` (same auth/retry).

**Inherited.** Job title, description, URL, location, country, posted date, salary range.

**Company linkage.** Parent company must already be in RF (Send Company must run first).

**Tagging.** SAP-module tags, role-family tags.

**Payload builder.** `Job Info JSON`.

**Action.** `HTTP API → Send Job data to RecruiterFlow`.

**Audit.** Multiple tracking/audit columns: was this row sent? Error response? Retry counter?

---

## 11. Auto-run vs manual run

Match Clay's behavior exactly:

- **Auto-run toggle (per table).** Default ON for tables 1–5; default OFF for the three CRM tables (operator decides when to push to CRM). When on, the table's columns evaluate run conditions automatically as new rows arrive and as upstream values change.
- **Per-column run.** Right-click column header → `Run column ▸ All empty cells / All cells / Errored cells / Cancel running`.
- **Per-cell run.** Cell drawer footer → `▶ Run again`.
- **Per-row run.** Row gutter → `▶` icon → runs all not-yet-run cells in that row's stage chain.
- **Master run.** A top-of-app `▶ Run pipeline` button runs everything pending across all tables in dependency order (Splitter → Companies → People → HeyReach/Phone → CRM).
- **Stop.** While running, the master button becomes `⏸ Pause`. Pause finishes in-flight cells and stops dispatching new ones.

---

## 12. Status indicators, end-to-end visibility

Operator needs to see the state of everything without leaving the current view. Always show:

- **App-level top counters.** `jobs N · pending N · running N · ready N · done N · rejected N`. Updates live via SSE.
- **Per-table top progress strip.** Same as Clay — a thin bar above the table showing how much of the table is "done" overall.
- **Per-column progress.** Per §3.3.
- **Per-row state stripe.** A 4px left edge stripe on each row colored by overall state.
- **Live event panel.** A collapsible "Activity" panel that scrolls real-time events: "Job 1459 stage3_tech done (7,219ms)", "Connection failed: HeyReach", etc.
- **Toast for every action.** Click ▶ on a row → toast "1 job sent · View →". Bulk send → same. Errors → red toast with the message.
- **Reconnect banner.** When SSE drops, a banner appears at the top of the active table.

---

## 13. Light theme — minimal palette

Match Clay's light-mode look. Plain. Functional.

```css
--bg:                 #ffffff;
--bg-elev:            #fafafa;
--bg-elev-2:          #f5f5f5;
--bg-input:           #ffffff;
--border:             #e5e7eb;
--border-strong:      #d1d5db;
--border-focus:       #9ca3af;

--text:               #111827;
--text-muted:         #6b7280;
--text-faint:         #9ca3af;
--text-link:          #2563eb;

--success:            #16a34a;
--running:            #2563eb;
--error:              #dc2626;
--warn:               #d97706;
--skip:               #6b7280;

--accent:             #111827;  /* primary button bg */
--accent-fg:          #ffffff;
```

Typography:
- Sans-serif system stack for UI text.
- Monospace (JetBrains Mono / Menlo / Consolas) for numbers, IDs, code blocks, status labels.
- Tabular numerals on every counter, timestamp, percentage.

Spacing: 4 / 8 / 12 / 16 / 24. Borders: 1px. Radii: 4px on inputs, 6px on cards / drawers, 0px on table cells.

No shadows except focus ring `0 0 0 1px var(--border-focus)`.

---

## 14. Analytics tab

Top-level nav entry: `Analytics`. Single page with these widgets, light theme matching the rest.

### 14.1 Top stat cards (single row)

Six cards: `Jobs received (today / 7d / 30d)`, `SAP qualified %`, `DACH qualified %`, `People found`, `Emails validated %`, `Sent to outbound`. Each card: big number, small delta vs. previous period, sparkline.

### 14.2 Pipeline funnel

A horizontal funnel showing each stage's pass-through rate:
```
Received → SAP gate → DACH gate → Direct (not agency) → Company enriched → People found → Email validated → Sent
```
Each segment labeled with absolute count + % retained. Click any segment → drills down into the rows that dropped at that stage.

### 14.3 Country trends

A small choropleth or bar chart for DE / AT / CH split. Below: top cities by job count.

### 14.4 Industry distribution

Pie chart of `company_industry` from `lpf_jobs` / `lpf_companies`. Filterable by date range.

### 14.5 Company size buckets

Bar chart of `employees_world` and `employees_dach` bucketed (1–10 / 11–50 / 51–200 / 201–1000 / 1000+).

### 14.6 SAP modules trends

Top 20 most-common SAP modules across qualified jobs, with a small time-series for each showing weekly frequency.

### 14.7 Job-title clusters

Group qualified jobs by inferred role family (CEO / CTO / IT Director / SAP Consultant / HR / etc.). Bar chart of counts.

### 14.8 People found — title & location

Stacked bar of contacts by role-bucket (CEO/Owner · IT/Tech · HR). Map of contact countries.

### 14.9 Skill trends

Top SAP skills + tech tags across all contacts and jobs, time-series chart for selected skills.

### 14.10 Cost & throughput

- Cost per stage (today / 7d / 30d) — stacked bar by provider.
- Cost per qualified contact — running ratio.
- Throughput chart — jobs/hour over time.

### 14.11 AI Insights box

A floating panel: "Ask anything about your data". Free-text input → sends the question along with a curated schema overview to an LLM, returns a chart/table/answer.

Quick-suggestion chips:
- "Top 10 companies we've found people at this week"
- "Which SAP module is trending up the most?"
- "What % of contacts have validated emails this month?"
- "Cost per qualified contact this week vs last week"
- "Show me the most expensive enrichment column this month"

The AI Insights box should call a server endpoint (`POST /api/analytics/ask`) that:
1. Takes the question.
2. Has a system prompt describing the schema (jobs, companies, contacts, cell_state, cell_runs, api_costs).
3. Uses GPT-4o-mini (or Claude) to generate a safe SELECT query.
4. Runs the query (read-only DB role; never DML).
5. Pipes the result into a chart-spec or table and renders it.

### 14.12 Filters & drill-down

Global date range selector at the top. Every widget respects it. Click any data point → opens the underlying rows in a side panel (and from there, individual cell drawers).

---

## 15. Schema additions (additive only)

Every new piece of state should be additive — never drop existing columns. Sketch:

```sql
-- Source ingest bus
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS ingest_source TEXT;        -- jpe_webhook_direct | jpe_webhook_db | csv_import | manual_test
ALTER TABLE lpf_jobs ADD COLUMN IF NOT EXISTS ingest_payload_id TEXT;    -- the source row id in the intermediate DB

-- Watermark for the JPE→DB→poll pattern
CREATE TABLE IF NOT EXISTS ingest_watermarks (
  source        TEXT PRIMARY KEY,
  last_seen_id  TEXT NOT NULL,
  last_polled   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-table rows for the four downstream LPF tables (additive — extend if any
-- already exist; do not delete existing tables)
-- lpf_companies          ← Companies (LPF) — 90 cols
-- lpf_contacts           ← People (LPF) — 98 cols (already exists; extend)
-- lpf_heyreach_rows      ← HeyReach — 61 cols
-- lpf_job_poster_rows    ← Job Poster (Phone) — 62 cols

-- CRM send tracking — one row per send attempt per destination
CREATE TABLE IF NOT EXISTS lpf_crm_sends (
  id            BIGSERIAL PRIMARY KEY,
  destination   TEXT NOT NULL,   -- recruiterflow_company | recruiterflow_contact | recruiterflow_job
  job_id        INTEGER,
  contact_id    INTEGER,
  payload       JSONB,
  response      JSONB,
  http_status   INTEGER,
  rf_record_id  TEXT,
  state         TEXT NOT NULL,   -- sent | dedup_skipped | error
  error_msg     TEXT,
  attempts      INTEGER DEFAULT 1,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Column registry table (the read-only column metadata; populated by code, never UI)
CREATE TABLE IF NOT EXISTS lpf_columns_registry (
  col_id          TEXT PRIMARY KEY,
  workbook_table  TEXT NOT NULL,
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  provider        TEXT,
  config          JSONB NOT NULL,    -- prompt, endpoint, formula, inputs, etc.
  enabled         BOOLEAN DEFAULT TRUE,
  display_order   INTEGER NOT NULL
);

-- Condition trace (already specced; reconfirm)
-- Cell state, cell runs, api_costs already exist — keep as-is.
```

---

## 16. AI prompts, output method, cost tracking

This is the "data accuracy" backbone. Get it right.

### 16.1 Prompts live in code, served read-only

Every Claygent / AI Model column has its system prompt and user prompt template stored verbatim in a TS / JS module:

```
src/prompts/
  company_splitter/
    is_sap_v_b2.js
    is_sap_focused_ai.js
    company_geocode.js
  companies_lpf/
    tech_extract_v1.js
    imagined_city_v1.js
    imagined_industry_v1.js
  people_lpf/
    developer_or_engineer.js
    german_gender.js
    salutation_frau_herr.js
  heyreach/
    english_inmail.js
    message_translation.js
    inmail_body_de.js
    connection_req_de.js   ← German ≤299 char connection request, verbatim Clay prompt
    imagined_*.js
  job_poster_phone/
    validate_*_phone.js    ← one per provider, plausibility scorer
```

Each module exports `{ SYSTEM_PROMPT, USER_PROMPT_TEMPLATE(vars), MODEL, TEMPERATURE, MAX_TOKENS, RESPONSE_FORMAT }`. The Edit Column panel (§5) renders these directly. No edit affordance in the UI — engineers edit the file and ship.

### 16.2 Output method

Every AI run records:
- Raw output (full JSON or text from the LLM) → `lpf_cell_runs.raw_output`.
- Parsed/structured fields → written back into the row (e.g. `lpf_jobs.sap_modules`).
- Cost USD → `lpf_api_costs.cost_usd` (computed from token counts × model pricing).
- Tokens in / out → `lpf_api_costs.input_tokens` / `output_tokens`.
- Duration → `lpf_cell_runs.duration_ms`.
- Cache key (for idempotent re-runs) → `lpf_cell_runs.cache_key` (optional).

The cell drawer's "AI prompt + output" section reads `lpf_cell_runs` for the most recent run.

### 16.3 Cost rendering

The top-bar Cost chip aggregates `lpf_api_costs` by provider for today (00:00 local → now). Click a chip → modal with three views:
- Today / 7d / 30d totals.
- Per-stage breakdown.
- Most expensive columns (top 10 by total cost).

Per-cell cost is shown in the cell drawer (§6.6). Per-row cost is in the row drawer.

---

## 17. Build order

Don't try to build it all at once. Order:

1. **Light theme tokens** + base table component shell. Plain HTML; light palette; the table grid with column headers, rows, cell renderer, hover popups.
2. **Read-only Edit Column panel** — opens on column-header click; shows description, inputs, run condition, prompt/endpoint/formula. Drives everything else.
3. **Cell drawer** with status, run condition trace, prompt+output, run history, retry button.
4. **Row drawer** with stage timeline and per-column at-a-glance list.
5. **Webhook ingestion path + DB-poll path**. Get rows flowing into the Company Splitter table.
6. **Company Splitter** — 61 columns end-to-end. Get the AI SAP classifier and the DACH lookup working. Auto-run on.
7. **Companies (LPF)** — 90 columns. Routing from Splitter via `Write to 2a [enabled]` action.
8. **People (LPF)** — 98 columns. Two Apollo people-find paths (CEO/Owners + IT/Tech + HR). Email waterfall. Routing into HeyReach.
9. **HeyReach** — 61 columns. AI personalization vars. German connection-request prompt (verbatim). Five campaign-routing HTTP actions.
10. **Job Poster (Phone)** — 62 columns. 10-provider waterfall (start with 2 providers — Datagma + Hunter — then layer the rest).
11. **CRM · Send Company / Contact / Jobs** — three tables, three endpoints. Dedup formulas first, action columns last.
12. **Master Run / Pause / Auto-run toggle**.
13. **Activity panel + SSE live updates**.
14. **Analytics tab** — start with the funnel and the top stat cards; add the AI Insights box last.

Ship each stage end-to-end before moving on. A column-half-built across multiple tables is worse than two tables fully done.

---

## 18. Hard rules (do not deviate)

- ❌ No add column / edit column / edit prompt / edit condition / rename / reorder / delete column from the UI. Everything is code-only.
- ❌ Do not omit columns that "look redundant" — if Clay has them, we have them. Operators rely on every Run-condition-not-met as a deliberate signal.
- ❌ Do not paraphrase prompts. Copy verbatim from the Clay Edit Column panel.
- ❌ Do not call providers from the browser. All provider calls server-side, logged to `lpf_api_costs`.
- ❌ Do not silently swallow errors. Classify, persist, surface on the affected cell.
- ❌ Do not mix tables in the UI. Eight tables, eight pages. No merged views.
- ✅ Every column is registered in `lpf_columns_registry` and rendered consistently across all eight tables.
- ✅ Every state transition writes to `lpf_cell_runs` and updates `lpf_cell_state`.
- ✅ Every action column distinguishes `sent` from `dedup_skipped` from `error`.
- ✅ Every prompt + endpoint + formula is viewable in the read-only Edit Column panel.
- ✅ Operators can retry any cell, stage, or column without restarting the server.
- ✅ Analytics tab serves both ad-hoc AI queries and pre-built charts; both respect the global date filter.

Get the data right. The look stays plain. If a screenshot would be valuable, take it from Clay and match it pixel-by-pixel — that's the bar.
