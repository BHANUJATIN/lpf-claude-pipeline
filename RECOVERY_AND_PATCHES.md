# LPF-Claude — Recovery & Patches (read this first)

> **Honest status**: while editing `public/index.html` from this Cowork session I caused the file to be truncated. It lost ~80 lines at the tail end — the closing `</script>`, `</body>`, `</html>` and the last few JS functions (including the rest of `renderAiPanel`) are missing. That is why `http://localhost:3000` now shows a blank/error page.
>
> `src/pipeline/Pipeline.js` was also briefly truncated by the same edit tool, but I rewrote the missing tail using bash heredoc and verified it with `node --check src/pipeline/Pipeline.js` — it is **clean** and loads. Pipeline.js is safe to keep.
>
> No git was initialised in this repo (`.git` absent), so I have no backup to roll back to.
>
> **Recommended path**: restore `public/index.html` from a backup you control (OneDrive version history / VS Code "Local History" extension / Time Machine), then re-apply only the surgical patches in §3 below. If no backup exists, §4 lists the exact JS that was at the tail and needs to be recreated; the Pipeline-tab cell drawer (`renderAiPanel`) is the affected feature.

---

## 1. What worked (keep these)

### 1.1 `src/pipeline/Pipeline.js` — DACH-mis-attribution fix (B-04)

The bug: when an AI call inside Stage 1 throws (e.g. `OPENAI_API_KEY not set`), the orchestrator's catch block called `batchSetCellState(job.id, stageCols, 'error', …)` for **all** five stage-1 columns. That overwrote the DACH cell — a deterministic country-list check that never touched OpenAI — with the OpenAI error. Same for the success path: a bulk `'success'` setter clobbered per-cell states (e.g. `condition_not_met` on Direct) that Stage 1 had already written individually.

The fix: a new helper `setPendingCellsState(jobId, colIds, newState, opts)` only flips cells that are currently in `queued`, `running`, or `idle` (or have no row yet). Already-finalized cells (`success`, `success_empty`, `condition_not_met`, `error`) are left alone. The three call sites in `processJob()` that used `batchSetCellState` for the rejected / success / error paths now use the new helper.

Diff summary:

```js
// top of file — additional requires
const { batchSetCellState, queueAllRemaining, setCellState, emitCellState } = require('./runCell');
const DatabaseClass = require('../database/Database');

// new helper added right after the imports
async function setPendingCellsState(jobId, colIds, newState, opts = {}) {
  const pool = DatabaseClass.getInstance().pool;
  try {
    const r = await pool.query(
      `SELECT col_id FROM lpf_cell_state
       WHERE job_id = $1 AND col_id = ANY($2::text[])
         AND state IN ('queued','running','idle')`,
      [jobId, colIds]
    );
    const pending = r.rows.map(row => row.col_id);
    const seen = new Set(pending);
    const missing = colIds.filter(c => !seen.has(c));
    for (const cid of missing) {
      const probe = await pool.query(
        `SELECT 1 FROM lpf_cell_state WHERE job_id=$1 AND col_id=$2 LIMIT 1`,
        [jobId, cid]
      );
      if (probe.rowCount === 0) pending.push(cid);
    }
    for (const cid of pending) {
      await setCellState(jobId, cid, newState, opts);
      emitCellState(jobId, cid, newState, opts);
    }
  } catch (_) {}
}

// inside processJob() — three call-site swaps:

// rejected path (was batchSetCellState(... 'condition_not_met'))
try { await setPendingCellsState(job.id, stageCols, 'condition_not_met', { errorMsg: result.reason }); } catch (_) {}

// success path (was batchSetCellState(... hasFields ? 'success' : 'success_empty'))
try { await setPendingCellsState(job.id, stageCols, hasFields ? 'success' : 'success_empty'); } catch (_) {}

// error path (was batchSetCellState(... 'error'))
try { await setPendingCellsState(job.id, stageCols, 'error', { errorMsg: err.message }); } catch (_) {}
```

This is **safe and verified**. Keep it. To validate locally:

```bash
node --check src/pipeline/Pipeline.js   # → OK
node -e "require('./src/pipeline/Pipeline.js'); console.log('loads')"   # → loads
```

After this fix, a stage-1 OpenAI failure no longer paints DACH / Direct / Score / Fit red. Only the AI cell (`stage1_sap_check`) ends in `error`.

---

## 2. What's broken in `public/index.html`

- File is truncated at line 3210 (originally ~3290).
- Last present line: `    // ── Section 3: About / provider ───────────────────────────`
- The `renderAiPanel` function body after that comment is gone.
- The closing `</script>`, `</body>`, `</html>` are gone.
- All my intended HTML edits to this file (see §3) were applied, but the page won't parse and JS will throw at parse-time when the browser hits the truncated script.

---

## 3. Patches that were applied to `index.html` (re-apply these to a restored copy)

These are the source-of-truth diffs. If you restore the original `index.html` from a backup, re-apply only these blocks (in this order) and you'll have the cleaned-up nav + Pipeline subtabs + Processing-filter removal + Send-feedback toast.

### 3.1 Remove the "Processing" filter option (B-02)

```html
<!-- BEFORE (around line 506) -->
<select class="sel" id="jobs-filter" onchange="renderJobs()">
  <option value="">All stages</option>
  <option value="received">Pending</option>
  <option value="processing">Processing</option>
  <option value="review">Review</option>
  <option value="completed">Completed</option>
  <option value="rejected">Rejected</option>
</select>

<!-- AFTER -->
<select class="sel" id="jobs-filter" onchange="renderJobs()">
  <option value="">All</option>
  <option value="received">Pending</option>
  <option value="review">Review</option>
  <option value="completed">Completed</option>
  <option value="rejected">Rejected</option>
</select>
```

And in `renderJobs()` (around line 1841), drop the dead `PROC` filter:

```js
// BEFORE
const PROC = ['stage1_sap','stage2_company','stage3_tech','stage4_people','stage5_enrich','stage6_poster','stage7_ai_search'];
let jobs = [..._allJobs];
if (filter === 'processing') jobs = jobs.filter(j => PROC.includes(j.stage));
else if (filter)             jobs = jobs.filter(j => j.stage === filter);

// AFTER
let jobs = [..._allJobs];
if (filter) jobs = jobs.filter(j => j.stage === filter);
```

### 3.2 Two-workbook nav (B-17 / restructure)

Replace the existing `<nav>` block (around line 419):

```html
<!-- ── Nav: two workbooks ──────────────────────────────────────────────────
     WB1 = Unprocessed                (incoming, raw jobs)
     WB2 = Pipeline                   (Company & Job · People · HeyReach · Job Poster)
     Utilities (Logs, Import, Dev) live in a right-side cluster.
─────────────────────────────────────────────────────────────────────────── -->
<nav id="primary-nav" style="display:flex;align-items:center;gap:0">
  <button class="active" onclick="showPage('unprocessed')" id="nav-unprocessed">Unprocessed <span class="nbadge" id="badge-unprocessed" style="display:none">0</span></button>
  <button onclick="showPage('jobs')" id="nav-jobs">Pipeline</button>
  <span style="flex:1"></span>
  <button onclick="showPage('review')"   id="nav-review"   style="font-size:11px;color:var(--fg-muted)">Review <span class="nbadge" id="badge-review" style="display:none">0</span></button>
  <button onclick="showPage('rejected')" id="nav-rejected" style="font-size:11px;color:var(--fg-muted)">Rejected <span class="nbadge nbadge-red" id="badge-rejected" style="display:none">0</span></button>
  <button onclick="showPage('logs')"     id="nav-logs"     style="font-size:11px;color:var(--fg-muted)">Logs</button>
  <button onclick="showPage('import')"   id="nav-import"   style="font-size:11px;color:var(--fg-muted)">Import</button>
  <button onclick="showPage('test')"     id="nav-test"     style="font-size:11px;color:var(--fg-muted)">Dev</button>
  <!-- folded -->
  <button onclick="showPage('variables')" id="nav-variables" style="display:none">Variables</button>
  <button onclick="showPage('companies')" id="nav-companies" style="display:none">Companies</button>
  <button onclick="showPage('people')"    id="nav-people"    style="display:none">People</button>
</nav>

<!-- Pipeline workbook sub-tabs (only visible inside Pipeline workbook) -->
<nav id="pipeline-subnav" style="display:none;align-items:center;gap:0;background:var(--bg-elev-2);border-bottom:1px solid var(--border-subtle);padding:0 8px">
  <button class="subtab active" data-sub="company-job" onclick="showSubTab('company-job')" id="sub-company-job">Company &amp; Job</button>
  <button class="subtab"        data-sub="people"      onclick="showSubTab('people')"      id="sub-people">People</button>
  <button class="subtab"        data-sub="heyreach"    onclick="showSubTab('heyreach')"    id="sub-heyreach">HeyReach</button>
  <button class="subtab"        data-sub="job-poster"  onclick="showSubTab('job-poster')"  id="sub-job-poster">Job Poster</button>
  <span style="flex:1"></span>
  <span id="pipeline-sub-hint" style="font-size:11px;color:var(--fg-muted);padding-right:8px">Replicating LPF flow — Company &amp; Job → People → HeyReach / Job Poster</span>
</nav>

<style>
#pipeline-subnav .subtab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--fg-muted);cursor:pointer;font-size:12px;padding:8px 14px;font-weight:500;transition:color .1s,border-color .1s}
#pipeline-subnav .subtab:hover{color:var(--fg-default)}
#pipeline-subnav .subtab.active{color:var(--fg-default);border-bottom-color:var(--accent)}
</style>
```

Then extend `showPage` (around line 1718) and add `showSubTab`:

```js
const PIPELINE_SUBTABS = ['company-job','people','heyreach','job-poster'];
const SUBTAB_TO_PAGE = {
  'company-job': 'jobs',
  'people':      'people',
  'heyreach':    'heyreach',
  'job-poster':  'job-poster',
};

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('page-'+name)?.classList.add('active');
  document.getElementById('nav-'+name)?.classList.add('active');
  _page = name;

  const subnav = document.getElementById('pipeline-subnav');
  const inPipelineWB = ['jobs','people','heyreach','job-poster'].includes(name);
  if (subnav) subnav.style.display = inPipelineWB ? 'flex' : 'none';
  if (inPipelineWB) document.getElementById('nav-jobs')?.classList.add('active');
  document.querySelectorAll('#pipeline-subnav .subtab').forEach(b => b.classList.remove('active'));
  if (inPipelineWB) {
    const sub = name === 'jobs' ? 'company-job' : name;
    document.getElementById('sub-'+sub)?.classList.add('active');
  }

  if (name === 'unprocessed') loadUnprocessed();
  if (name === 'jobs')        loadJobs();
  if (name === 'variables')   loadVariables();
  if (name === 'companies')   loadCompanies();
  if (name === 'people')      loadPeople();
  if (name === 'review')      loadReview();
  if (name === 'rejected')    loadRejected();
  if (name === 'logs')        loadLogs();
}

function showSubTab(sub) {
  const page = SUBTAB_TO_PAGE[sub] || 'jobs';
  showPage(page);
}
```

### 3.3 HeyReach + Job Poster placeholder pages

Add inside `<main>`, just before the existing `</main>`:

```html
<div id="page-heyreach" class="page">
  <div style="padding:48px;text-align:center;max-width:680px;margin:0 auto">
    <div style="font-size:48px;opacity:.4;margin-bottom:12px">∗</div>
    <h2 style="font-size:18px;font-weight:600;margin:0 0 8px;color:var(--fg-default)">HeyReach</h2>
    <p style="color:var(--fg-muted);font-size:13px;line-height:1.6;margin:0 0 16px">
      LinkedIn outbound. Mirrors Clay table <code>LPF - HeyReach Implementation · t_5hFBJS6c4haa</code> — 61 columns including connection-request gen, German InMail bodies, campaign routing, sender rotation.
    </p>
    <p style="color:var(--fg-muted);font-size:12px;margin:0">
      Not yet wired. To replace Stage 8 (Send to Instantly): implement Stage06-style routing against <code>HeyReachService.addLead()</code> and surface <code>free_inmail_heyreach</code>, <code>conreq_plus_inmail</code>, <code>connect_only</code> columns here.
    </p>
  </div>
</div>

<div id="page-job-poster" class="page">
  <div style="padding:48px;text-align:center;max-width:680px;margin:0 auto">
    <div style="font-size:48px;opacity:.4;margin-bottom:12px">☎</div>
    <h2 style="font-size:18px;font-weight:600;margin:0 0 8px;color:var(--fg-default)">Job Poster · Phone</h2>
    <p style="color:var(--fg-muted);font-size:13px;line-height:1.6;margin:0 0 16px">
      Hiring-manager phone enrichment. Mirrors Clay table <code>Phone (Job Poster) · t_yz33ovqbNW6K</code> — 62 columns, 10-provider waterfall.
    </p>
    <p style="color:var(--fg-muted);font-size:12px;margin:0">
      Waterfall: Datagma → Hunter → RocketReach → ContactOut → Prospeo → Wiza → Forager → LeadMagic → People Data Labs → LinkedIn API. Per-provider Clay-AI validation; master arbitration column picks the highest-scored validated phone.
    </p>
  </div>
</div>
```

### 3.4 Send-feedback toast + queued pill (B-01)

Patch `toast()` to accept HTML and a custom duration (~line 949):

```js
function toast(msg, type='info', durationMs=3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  if (typeof msg === 'string' && /<[a-z][^>]*>/i.test(msg)) el.innerHTML = msg;
  else el.textContent = msg;
  document.getElementById('toast-c').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, durationMs);
}
```

Replace `runJob()` (~line 2573) and add the queue-feedback helpers:

```js
async function runJob(id) {
  markUnpRowsAsQueued([id]);
  try {
    connectSSE();
    document.getElementById('live-log').style.display = '';
    setPipelineRunning(true);
    const r = await fetch(`/pipeline/run/${id}`, { method:'POST' });
    const d = await r.json();
    toast(toastWithViewLink(d.message || `Job ${id} sent to pipeline`), 'ok', 4500);
    setTimeout(() => fadeOutAndRemoveUnpRow(id), 1200);
    setTimeout(loadUnprocessed, 2500);
  } catch(e) {
    unmarkUnpRowAsQueued(id);
    toast('Error: '+e.message, 'error');
  }
}

function markUnpRowsAsQueued(ids) {
  for (const id of ids) {
    const tr = document.querySelector(`tr[data-id="${id}"]`);
    if (!tr) continue;
    tr.classList.add('row-queued');
    tr.style.boxShadow      = 'inset 4px 0 0 0 var(--accent)';
    tr.style.background     = 'rgba(59,130,246,.06)';
    tr.style.transition     = 'opacity 0.6s ease';
    const btnCell = tr.querySelector('td:last-child');
    if (btnCell) btnCell.innerHTML = '<span class="pill" style="background:rgba(59,130,246,.15);color:#3b82f6;border:1px solid rgba(59,130,246,.35);padding:2px 8px;border-radius:999px;font-size:11px;display:inline-flex;align-items:center;gap:6px"><span class="spinner-xs"></span>Queued</span>';
    const cb = tr.querySelector('.unp-chk');
    if (cb) cb.checked = false;
  }
  onUnpCheck();
}
function unmarkUnpRowAsQueued(id) {
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (!tr) return;
  tr.style.boxShadow = ''; tr.style.background = '';
  const btnCell = tr.querySelector('td:last-child');
  if (btnCell) btnCell.innerHTML = `<button class="btn btn-sm" onclick="runJob(${id})" title="Process this job only">▶</button>`;
}
function fadeOutAndRemoveUnpRow(id) {
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (!tr) return;
  tr.style.opacity = '0';
  setTimeout(() => tr.remove(), 600);
  const badge = document.querySelector('[data-badge="unprocessed"]');
  if (badge) {
    const n = parseInt(badge.textContent) || 1;
    if (n > 1) badge.textContent = String(n - 1); else badge.textContent = '';
  }
  const cnt = document.getElementById('unp-count');
  if (cnt) {
    const m = cnt.textContent.match(/(\d+)/);
    if (m) cnt.textContent = `${Math.max(0, parseInt(m[1]) - 1)} unprocessed`;
  }
}
function toastWithViewLink(text) {
  return `${text} · <a href="#" onclick="event.preventDefault();showPage('jobs');return false" style="text-decoration:underline">View in pipeline →</a>`;
}
```

Patch `processSelected()` to use the same helpers (~line 1787):

```js
async function processSelected() {
  if (!_unpSel.size) return;
  const ids  = [..._unpSel];
  const btn  = document.querySelector('#unp-bulk .btn-primary');
  btn.disabled = true;
  btn.textContent = `Starting ${ids.length} jobs…`;
  markUnpRowsAsQueued(ids);
  try {
    connectSSE();
    document.getElementById('live-log').style.display = '';
    setPipelineRunning(true);
    const r = await fetch('/pipeline/run-batch', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ ids })
    });
    const d = await r.json();
    toast(toastWithViewLink(d.message || `${ids.length} job${ids.length>1?'s':''} sent to pipeline`), 'ok', 5000);
    clearUnpSel();
    setTimeout(() => ids.forEach(fadeOutAndRemoveUnpRow), 1200);
    setTimeout(loadUnprocessed, 2500);
  } catch(e) {
    ids.forEach(unmarkUnpRowAsQueued);
    setPipelineRunning(false);
    toast('Error: '+e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Send to Pipeline';
  }
}
```

### 3.5 Visible bulk-action toolbar buttons on dark theme (B-09)

Replace the inline-styled bulk toolbar (~line 466):

```html
<div id="unp-bulk" style="display:none;background:var(--bg-elev-2);border-bottom:1px solid var(--border-default);padding:8px 16px;align-items:center;gap:10px;position:sticky;top:71px;z-index:150">
  <input type="checkbox" id="unp-sel-all-hdr" onchange="toggleUnpAll(this)">
  <span id="unp-bulk-cnt" style="font-size:12px;font-weight:600;color:var(--fg-default)">0 selected</span>
  <div style="flex:1"></div>
  <button class="btn btn-primary btn-sm" onclick="processSelected()">▶ Send to Pipeline</button>
  <button class="btn btn-sm" onclick="runAll()">▶ Run All Pending</button>
  <button class="btn btn-sm" onclick="clearUnpSel()">✕ Clear</button>
</div>
```

---

## 4. The truncated tail of `index.html` — what's missing

The file currently ends at:

```
    // ── Section 3: About / provider ───────────────────────────
```

…inside the `renderAiPanel(jobId, colId)` function. Everything after that line — including the rest of `renderAiPanel`, the closing `</script>`, `</body>`, `</html>`, and any tail functions — is gone.

If you have a backup (OneDrive history, Time Machine, VS Code Local-History, `.recovery` folder, an editor undo stack), restore from there. Otherwise, point Claude Code at this file with the prompt:

> "`public/index.html` is truncated at line 3210 inside `renderAiPanel(jobId, colId)` (right after the `// ── Section 3: About / provider ─` comment). Reconstruct the rest of the function by mirroring the four-section drawer pattern used elsewhere in the file — render: status, condition trace, about/provider, output (stored fields), run history. Then add the closing `</script>`, `</body>`, `</html>`. Verify the file parses with `node -e \"const fs=require('fs');const h=fs.readFileSync('public/index.html','utf-8');const s=h.indexOf('<script>')+8;const e=h.lastIndexOf('</script>');new Function(h.slice(s,e));console.log('OK')\"`."

---

## 5. The end-state intent (so Claude Code / you know what to aim for)

Read these two docs **in order** before starting:

1. `D:\Freelance\CTR\ClaudeworkspaceCTR\CTR\LPF_UI_CORRECTION_v2.md` — the brutal review + new IA + per-defect fix list.
2. This file — the recovery plan and surgical patches.

Highest-priority outcome:
- Server starts cleanly (`npm run dev` → `http://localhost:3000` returns 200).
- DACH no longer shows `OPENAI_API_KEY not set` after a stage-1 AI failure (the Pipeline.js fix is already in).
- "Processing" is gone from the stage-filter dropdown.
- Clicking ▶ on an Unprocessed row gives an immediate row-level "Queued" pill + a toast with a "View in pipeline" link, and the row fades out.
- Top nav has two workbooks: `Unprocessed | Pipeline`; Pipeline shows inner sub-tabs `Company & Job · People · HeyReach · Job Poster`.

---

## 6. What I will NOT do again from a Cowork session

Make multi-thousand-line edits to a single file with the `Edit` tool. The right pattern when the file is large (3000+ lines) is to either:
- read the file in full first, write the entire updated version with `Write`, OR
- use bash with `sed -i` / a small Node script for surgical text replacement, never `Edit` on a huge file.

Bash-based edits to `Pipeline.js` worked fine. `Edit`-based edits to `index.html` truncated it. Given that experience, all further surgical changes to `index.html` should be done via bash + a recovery checkpoint.

Sorry for the damage. Restore the file from your backup, apply §3, and the spec in `LPF_UI_CORRECTION_v2.md` will guide the rest.
