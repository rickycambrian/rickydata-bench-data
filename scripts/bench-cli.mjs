#!/usr/bin/env node
// Explore the dataset without writing any code. Node stdlib only — no install.
//
//   node scripts/bench-cli.mjs fetch [--data ./data]             download + verify the dataset
//                              [--shards runs,tasks,configs,difficulty]  skip proofs+traces (~95% of bytes)
//                              [--snapshot-only] [--since vYYYY.MM.DD]
//   node scripts/bench-cli.mjs info                              what's in the local data dir
//   node scripts/bench-cli.mjs leaderboard [filters]             solve rate + cost by config/model
//   node scripts/bench-cli.mjs best --group language             best models per problem facet
//   node scripts/bench-cli.mjs campaigns                         what each campaign is + how to read it
//   node scripts/bench-cli.mjs task <repo#issue>                 every attempt on one issue
//   node scripts/bench-cli.mjs trace <run_id>                    full agent trace for one run
//   node scripts/bench-cli.mjs proof <run_id>                    TEE attestation for one run
//   node scripts/bench-cli.mjs routing --out cells.csv           per-(item, config) routing cells
//   node scripts/bench-cli.mjs export --shard runs --csv out.csv flatten a shard to CSV
//
// Common flags:
//   --data ./data          where fetch put the releases (default ./data)
//   --language python      filter: task language        --repo pallets/flask   filter: source repo
//   --complexity high      filter: task complexity      --issue-type bug       filter: issue type
//   --by model             group by canonical model instead of config_name
//   --tier catalog         only catalog-resolved configs (default: both tiers)
//   --production           only apples-to-apples leaderboard-cohort runs (== --class leaderboard)
//   --class leaderboard    campaign class: leaderboard|study|probe (default: all but probe)
//   --min-runs 5           hide groups with fewer runs (leaderboard: 5, best: 3)
//   --min-difficulty 70    filter: blend-v1 difficulty score 0-100 (also --max-difficulty)
//   --difficulty-zone premium_separable   filter: difficulty zone
//   --json                 machine-readable output instead of a table
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOL_FLAGS = new Set(['production', 'json', 'full', 'snapshot-only']);
function arg(name, fallback) {
  // accepts both --name=value and --name value
  const idx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return fallback;
  const hit = process.argv[idx];
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const next = process.argv[idx + 1];
  return BOOL_FLAGS.has(name) || next === undefined || next.startsWith('--') ? true : next;
}

// --- load shards -----------------------------------------------------------

function findShardFiles(root, prefix) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.startsWith(prefix) && name.endsWith('.jsonl.gz')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function readJsonl(file) {
  const text = gunzipSync(readFileSync(file)).toString('utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
}

// traces-full/proofs-full are ~300 MB uncompressed — stream them and stop at the
// first hit instead of materializing the whole shard to find one run_id.
async function findByRunId(files, runId) {
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        // cheap pre-filter: skip JSON.parse on the ~99.98% of lines that can't match
        if (!line.includes(runId)) continue;
        const row = JSON.parse(line);
        if (row.run_id === runId) return { row, file };
      }
    } finally {
      lines.close();
    }
  }
  return null;
}

function loadRuns(dataDir, { tier }) {
  // runs-config-name-only-* also matches prefix 'runs-'; identity_tier disambiguates.
  const rows = findShardFiles(dataDir, 'runs-').flatMap(readJsonl);
  if (rows.length === 0) {
    console.error(`no runs-*.jsonl.gz under ${dataDir} — run: node scripts/bench-cli.mjs fetch`);
    process.exit(1);
  }
  // dailies are disjoint by run_id, but dedupe defensively (snapshot + overlapping fetches)
  const byId = new Map();
  for (const row of rows) byId.set(row.run_id, row);
  let runs = [...byId.values()];
  if (tier && tier !== 'all') runs = runs.filter((r) => r.identity_tier === tier);
  return runs;
}

function loadTasks(dataDir) {
  const byId = new Map();
  for (const row of findShardFiles(dataDir, 'tasks-').flatMap(readJsonl)) byId.set(row.task_id, row);
  // language is a repo-level property — lets runs whose task row is absent
  // (task-id fragmentation) still resolve a language via their repo
  const repoLanguage = new Map();
  for (const task of byId.values()) {
    if (task.source_repo && task.language && !repoLanguage.has(task.source_repo)) {
      repoLanguage.set(task.source_repo, task.language);
    }
  }
  byId.repoLanguage = repoLanguage;
  return byId;
}

// difficulty-* is a full snapshot per release (schema 1.2): latest as_of per item wins.
let _difficulty;
function loadDifficulty(root) {
  if (_difficulty) return _difficulty;
  _difficulty = new Map();
  for (const row of findShardFiles(root, 'difficulty-').flatMap(readJsonl)) {
    const prev = _difficulty.get(row.item);
    if (!prev || String(row.as_of ?? '') > String(prev.as_of ?? '')) _difficulty.set(row.item, row);
  }
  return _difficulty;
}

// schema 1.0 rows lack task_complexity/task_issue_type on the run — join from tasks shard.
function facetsOf(run, tasks) {
  const task = tasks.get(run.task_id);
  const repo = run.source_repo ?? run.repo ?? task?.source_repo ?? null;
  return {
    language: run.task_language ?? task?.language ?? (repo ? tasks.repoLanguage.get(repo) : null) ?? null,
    complexity: run.task_complexity ?? task?.complexity ?? null,
    issue_type: run.task_issue_type ?? task?.issue_type ?? null,
    repo,
  };
}

// --- outcome ---------------------------------------------------------------

// The solve verdict is `success` — the run produced a change that passed the
// task's verification at whatever level that task supports (L1..L4). `test_passed`
// is NARROWER: only the L4 harness paths (tdd_harness_red_green_trace,
// swebench_official) ever set it, so scoring on it counts every L1/L3-verified
// solve as a failure and silently ranks harness-path models above evidence-path
// ones. Same definition bench.rickydata.org uses; schema ≥1.5 also ships it
// precomputed as `solved` / `score_status`.
const INFRA_LEVEL = 'runner_or_provider_error';
function outcomeOf(run) {
  if (run.infra_excluded === true || run.verification_level === INFRA_LEVEL || run.failure_source === 'infra') return 'infra';
  if (run.success === true) return 'solved';
  if (run.success === false) return 'failed';
  return 'unscored';
}
const isScored = (run) => { const o = outcomeOf(run); return o === 'solved' || o === 'failed'; };

// Campaign class (schema ≥1.5 ships it as `campaign_class`; derived here so the
// same filters work on older releases). probe = infra canary/smoke/validation
// runs — real TEE runs, but they re-run one known-good issue and would inflate
// any rate they land in, so they are out of the default view.
const PROBE_PATTERNS = [/(?:^|[_-])(?:canary|smoke|probe|debug|validation|uncalibrated)(?:[_-]|$)/i, /^test-/i];
const LEADERBOARD_PREFIXES = ['benchmark_matrix_', 'subscription_causal_routing_v1_', 'routing_confirmatory_v1_', 'swebench-native'];
// Campaigns that sit on a leaderboard prefix but are not the leaderboard cohort: soak
// runs, plugin variance/pilot sweeps, repeat batches. They deliberately re-run a small
// fixed set, so they read as 100% and would swamp the matrix if pooled with it.
const STUDY_PATTERNS = [/(?:^|[_-])(?:soak\d*|variance|pilot|repeats)(?:[_-]|$)/i];
function campaignClass(run) {
  if (run.campaign_class) return run.campaign_class;
  const id = String(run.campaign_id ?? '');
  if (PROBE_PATTERNS.some((p) => p.test(id))) return 'probe';
  if (STUDY_PATTERNS.some((p) => p.test(id))) return 'study';
  return LEADERBOARD_PREFIXES.some((p) => id.startsWith(p)) ? 'leaderboard' : 'study';
}

function applyFilters(runs, tasks) {
  const language = arg('language', null);
  const complexity = arg('complexity', null);
  const issueType = arg('issue-type', null);
  const repo = arg('repo', null);
  const production = arg('production', false);
  const minDifficulty = arg('min-difficulty', null);
  const maxDifficulty = arg('max-difficulty', null);
  const difficultyZone = arg('difficulty-zone', null);
  const wantsClass = arg('class', null);
  const wantsDifficulty = minDifficulty != null || maxDifficulty != null || difficultyZone != null;
  const difficulty = wantsDifficulty ? loadDifficulty(dataDir) : null;
  if (wantsDifficulty && difficulty.size === 0) {
    console.error(`no difficulty-*.jsonl.gz under ${dataDir} — difficulty filters need a schema ≥1.2 release`);
    process.exit(1);
  }
  return runs.filter((run) => {
    if (!isScored(run)) return false; // infra failures and verdict-less rows are not evidence
    const klass = campaignClass(run);
    if (wantsClass ? klass !== wantsClass : klass === 'probe') return false;
    // --production is the shorthand for --class leaderboard. Deliberately NOT
    // `run.production_evidence`: that column is a prefix test mirrored with the live
    // site, so it still calls soak/variance/pilot batches production.
    if (production && klass !== 'leaderboard') return false;
    const f = facetsOf(run, tasks);
    if (language && f.language !== language) return false;
    if (complexity && f.complexity !== complexity) return false;
    if (issueType && f.issue_type !== issueType) return false;
    if (repo && f.repo !== repo) return false;
    if (difficulty) {
      const d = run.item ? difficulty.get(run.item) : null;
      if (!d) return false; // no difficulty row -> excluded from difficulty-filtered views
      if (minDifficulty != null && !(d.difficulty_score >= Number(minDifficulty))) return false;
      if (maxDifficulty != null && !(d.difficulty_score <= Number(maxDifficulty))) return false;
      if (difficultyZone != null && d.zone !== difficultyZone) return false;
    }
    return true;
  });
}

// --- aggregate -------------------------------------------------------------

function costOf(run) {
  const v = run.cost_metrics?.theoretical_cost_usd;
  return Number.isFinite(v) ? v : null;
}

function closenessOf(run) {
  const v = run.quality_score?.composite;
  return Number.isFinite(v) ? v : null;
}

function groupKeyFn() {
  return arg('by', 'config') === 'model'
    ? (run) => run.canonical_model ?? run.model ?? run.config_name
    : (run) => run.config_name;
}

function aggregate(runs, keyFn) {
  const groups = new Map();
  for (const run of runs) {
    const key = keyFn(run);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, n: 0, passes: 0, costs: [], closenesses: [], tier: run.model_tier, billing: run.billing_class });
    g.n += 1;
    if (outcomeOf(run) === 'solved') g.passes += 1;
    const cost = costOf(run); if (cost != null) g.costs.push(cost);
    const close = closenessOf(run); if (close != null) g.closenesses.push(close);
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    n: g.n,
    passes: g.passes,
    solve_rate: g.n ? g.passes / g.n : 0,
    mean_cost_usd: g.costs.length ? g.costs.reduce((a, b) => a + b, 0) / g.costs.length : null,
    mean_closeness: g.closenesses.length ? g.closenesses.reduce((a, b) => a + b, 0) / g.closenesses.length : null,
    model_tier: g.tier ?? null,
    billing_class: g.billing ?? null,
  }));
}

// --- output ----------------------------------------------------------------

function fmt(value, digits = 2) {
  if (value == null) return '—';
  return typeof value === 'number' ? value.toFixed(digits) : String(value);
}

function printTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => c.get(row))));
}

function toCsv(rows, headers) {
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

// --- commands --------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = arg('data', './data');
const command = process.argv[2];

if (!command || command === 'help' || command === '--help') {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

if (command === 'fetch') {
  // Pass the selection flags straight through: proofs+traces are ~95% of the bytes,
  // so `fetch --shards runs,tasks,configs,difficulty` is the fast path for anyone who
  // only wants leaderboard/routing data.
  const passthrough = ['shards', 'since', 'snapshot-only']
    .flatMap((name) => { const v = arg(name, null); return v == null || v === false ? [] : [v === true ? `--${name}` : `--${name}=${v}`]; });
  const res = spawnSync(process.execPath, [join(here, 'fetch-dataset.mjs'), `--out=${dataDir}`, '--verify', ...passthrough], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

if (command === 'info') {
  const runs = loadRuns(dataDir, { tier: 'all' });
  const tasks = loadTasks(dataDir);
  const campaigns = new Set(runs.map((r) => r.campaign_id));
  const configs = new Set(runs.map((r) => r.config_name));
  const items = new Set(runs.map((r) => r.item).filter(Boolean));
  const langs = {};
  for (const run of runs) { const l = facetsOf(run, tasks).language ?? 'unknown'; langs[l] = (langs[l] ?? 0) + 1; }
  const dates = runs.map((r) => r.created_at).filter(Boolean).sort();
  const tally = (fn) => Object.entries(runs.reduce((a, r) => { const k = fn(r); a[k] = (a[k] ?? 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`runs        ${runs.length} (${runs.filter((r) => r.identity_tier === 'catalog').length} catalog + ${runs.filter((r) => r.identity_tier === 'config_name_only').length} config-name-only)`);
  console.log(`outcome     ${tally(outcomeOf)}`);
  console.log(`class       ${tally(campaignClass)}`);
  console.log(`tasks       ${tasks.size} (${items.size} distinct repo#issue items)`);
  console.log(`configs     ${configs.size} distinct config_names, ${campaigns.size} campaigns`);
  console.log(`languages   ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`date range  ${dates[0]?.slice(0, 10)} → ${dates.at(-1)?.slice(0, 10)}`);
  console.log(`\nsolve rates count 'solved'/(solved+failed); infra and unscored rows are never denominators.`);
  process.exit(0);
}

if (command === 'campaigns') {
  const runs = loadRuns(dataDir, { tier: 'all' });
  const byCampaign = new Map();
  for (const run of runs) {
    const key = run.campaign_id ?? '(none)';
    let c = byCampaign.get(key);
    if (!c) byCampaign.set(key, c = { key, klass: campaignClass(run), n: 0, scored: 0, solved: 0, first: '', last: '', configs: new Set() });
    c.n += 1;
    if (isScored(run)) c.scored += 1;
    if (outcomeOf(run) === 'solved') c.solved += 1;
    if (run.config_name) c.configs.add(run.config_name);
    const day = run.created_at?.slice(0, 10) ?? '';
    if (day && (!c.first || day < c.first)) c.first = day;
    if (day && day > c.last) c.last = day;
  }
  const rows = [...byCampaign.values()].sort((a, b) => b.n - a.n);
  if (arg('json', false)) { console.log(JSON.stringify(rows.map((r) => ({ ...r, configs: r.configs.size })), null, 2)); process.exit(0); }
  printTable(rows, [
    { label: 'campaign', get: (r) => r.key },
    { label: 'class', get: (r) => r.klass },
    { label: 'runs', get: (r) => r.n },
    { label: 'scored', get: (r) => r.scored },
    { label: 'solve%', get: (r) => r.scored ? fmt(r.solved / r.scored * 100, 1) : '—' },
    { label: 'configs', get: (r) => r.configs.size },
    { label: 'from', get: (r) => r.first || '—' },
    { label: 'to', get: (r) => r.last || '—' },
  ]);
  console.log(`
class    what it is                                          in default views?
------   -------------------------------------------------   -----------------
leaderboard  the apples-to-apples cohort: a fixed config x issue matrix   yes (--production narrows to exactly this)
study        a real experiment — routing, tool overlays, difficulty       yes; its issue set is chosen for the study,
             calibration, wiki extraction. TEE-verified, valid configs.   so never compare a study rate to a leaderboard rate
probe        infra canary / smoke / validation. Re-runs one known-good    no — pass --class probe to see them
             issue to check the gateway; would inflate any rate.`);
  process.exit(0);
}

if (command === 'leaderboard') {
  const tasks = loadTasks(dataDir);
  const runs = applyFilters(loadRuns(dataDir, { tier: arg('tier', 'all') }), tasks);
  const minRuns = Number(arg('min-runs', 5));
  const sort = arg('sort', 'solve');
  let rows = aggregate(runs, groupKeyFn()).filter((g) => g.n >= minRuns);
  rows.sort((a, b) => sort === 'cost' ? (a.mean_cost_usd ?? 1e9) - (b.mean_cost_usd ?? 1e9)
    : sort === 'n' ? b.n - a.n
    : b.solve_rate - a.solve_rate || b.n - a.n);
  if (arg('json', false)) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  printTable(rows, [
    { label: arg('by', 'config') === 'model' ? 'model' : 'config', get: (r) => r.key },
    { label: 'runs', get: (r) => r.n },
    { label: 'solve%', get: (r) => fmt(r.solve_rate * 100, 1) },
    { label: 'closeness', get: (r) => fmt(r.mean_closeness) },
    { label: 'cost $', get: (r) => fmt(r.mean_cost_usd, 3) },
    { label: 'tier', get: (r) => r.model_tier ?? '—' },
    { label: 'billing', get: (r) => r.billing_class ?? '—' },
  ]);
  console.log(`\n${runs.length} scored runs after filters; groups with <${minRuns} runs hidden (--min-runs). Cost = PAYG rate-card reference.`);
  console.log(`solve% = solved/(solved+failed) on the 'success' verdict; infra failures, unscored rows and probe`);
  console.log(`campaigns are excluded. Without --production this mixes leaderboard and study cohorts (bench-cli campaigns).`);
  process.exit(0);
}

if (command === 'best') {
  const tasks = loadTasks(dataDir);
  const runs = applyFilters(loadRuns(dataDir, { tier: arg('tier', 'all') }), tasks);
  const facet = arg('group', 'language');
  if (!['language', 'complexity', 'repo', 'issue_type'].includes(facet)) {
    console.error(`--group must be language|complexity|repo|issue_type`); process.exit(1);
  }
  const minRuns = Number(arg('min-runs', 3));
  const keyFn = groupKeyFn();
  const byFacet = new Map();
  for (const run of runs) {
    const value = facetsOf(run, tasks)[facet] ?? 'unknown';
    if (!byFacet.has(value)) byFacet.set(value, []);
    byFacet.get(value).push(run);
  }
  const out = [];
  for (const [value, facetRuns] of [...byFacet.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ranked = aggregate(facetRuns, keyFn).filter((g) => g.n >= minRuns)
      .sort((a, b) => b.solve_rate - a.solve_rate || (a.mean_cost_usd ?? 1e9) - (b.mean_cost_usd ?? 1e9));
    out.push({ [facet]: value, runs: facetRuns.length, top: ranked.slice(0, 3) });
  }
  if (arg('json', false)) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  for (const entry of out) {
    console.log(`\n${facet}: ${entry[facet]}  (${entry.runs} runs)`);
    if (entry.top.length === 0) { console.log(`  (no group reaches --min-runs ${minRuns})`); continue; }
    for (const [i, g] of entry.top.entries()) {
      console.log(`  ${i + 1}. ${g.key}  —  ${fmt(g.solve_rate * 100, 1)}% solve over ${g.n} runs, ~$${fmt(g.mean_cost_usd, 3)}/run${g.mean_closeness != null ? `, closeness ${fmt(g.mean_closeness)}` : ''}`);
    }
  }
  process.exit(0);
}

if (command === 'task') {
  const item = process.argv[3];
  if (!item || !item.includes('#')) { console.error('usage: bench-cli.mjs task <repo#issue>'); process.exit(1); }
  const tasks = loadTasks(dataDir);
  const runs = loadRuns(dataDir, { tier: 'all' }).filter((r) => r.item === item);
  if (runs.length === 0) { console.error(`no runs for ${item}`); process.exit(1); }
  const task = tasks.get(runs[0].task_id);
  if (task) console.log(`${item}  [${task.language ?? '?'}/${task.complexity ?? '?'}/${task.issue_type ?? '?'}]  ${task.issue_title ?? ''}\n`);
  const rank = (r) => ({ solved: 0, failed: 1, unscored: 2, infra: 3 })[outcomeOf(r)];
  const rows = runs.sort((a, b) => rank(a) - rank(b) || (costOf(a) ?? 1e9) - (costOf(b) ?? 1e9));
  printTable(rows, [
    { label: 'run_id', get: (r) => r.run_id },
    { label: 'config', get: (r) => r.config_name },
    { label: 'outcome', get: (r) => outcomeOf(r) },
    { label: 'level', get: (r) => r.verification_level || '—' },
    { label: 'closeness', get: (r) => fmt(closenessOf(r)) },
    { label: 'cost $', get: (r) => fmt(costOf(r), 3) },
    { label: 'when', get: (r) => r.created_at?.slice(0, 10) ?? '—' },
  ]);
  const repro = runs.find((r) => r.reproduce_command)?.reproduce_command;
  if (repro) console.log(`\nreproduce: ${repro}`);
  console.log(`trace:     node scripts/bench-cli.mjs trace ${rows[0].run_id}`);
  console.log(`proof:     node scripts/bench-cli.mjs proof ${rows[0].run_id}`);
  process.exit(0);
}

if (command === 'trace') {
  const runId = process.argv[3];
  if (!runId) { console.error('usage: bench-cli.mjs trace <run_id> [--out trace.json] [--full]'); process.exit(1); }
  const files = findShardFiles(dataDir, 'traces-');
  if (files.length === 0) { console.error(`no traces-*.jsonl.gz under ${dataDir} — run: node scripts/bench-cli.mjs fetch`); process.exit(1); }
  const hit = await findByRunId(files, runId);
  if (!hit) { console.error(`no trace for ${runId}. The run may predate trace capture — check trace_present on its run row.`); process.exit(1); }
  const out = arg('out', null);
  if (out) { writeFileSync(out, JSON.stringify(hit.row, null, 2)); console.log(`trace ${hit.row.trace_id} → ${out}`); process.exit(0); }
  if (arg('json', false)) { console.log(JSON.stringify(hit.row, null, 2)); process.exit(0); }

  // Two views of the same graph: hook events are the ordered timeline (they carry
  // `sequence`); tool/command/file nodes are the deduped entities the run touched.
  const nodes = hit.row.graph?.nodes ?? [];
  const of = (label) => nodes.filter((n) => n.label === label);
  const full = arg('full', false);
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
  const cap = (rows, n) => full ? rows : rows.slice(0, n);
  const more = (rows, n) => full || rows.length <= n ? '' : `  … +${rows.length - n} (--full)`;

  console.log(`run    ${runId}\ntrace  ${hit.row.trace_id}\nshard  ${hit.file}`);
  console.log(`graph  ${nodes.length} nodes, ${hit.row.graph?.edges?.length ?? 0} edges`);

  const events = of('BenchmarkTraceHookEvent').sort((a, b) => (a.properties?.sequence ?? 0) - (b.properties?.sequence ?? 0));
  console.log(`\ntimeline — ${events.length} hook events${more(events, 40)}`);
  printTable(cap(events, 40), [
    { label: '#', get: (n) => n.properties?.sequence ?? '—' },
    { label: 'turn', get: (n) => n.properties?.turn_index ?? '—' },
    { label: 'event', get: (n) => n.title ?? '—' },
    { label: 'tool', get: (n) => n.properties?.tool_name ?? '—' },
  ]);

  const tools = of('BenchmarkTraceToolUse');
  console.log(`\ntool calls — ${tools.length}${more(tools, 25)}`);
  printTable(cap(tools, 25), [
    { label: 'tool', get: (n) => n.title ?? '—' },
    { label: 'input', get: (n) => clip(n.properties?.input_text ?? n.properties?.input_summary, 78) },
    { label: 'result', get: (n) => clip(n.properties?.output_summary, 22) },
  ]);

  const commands = of('BenchmarkTraceCommand');
  console.log(`\nshell commands — ${commands.length}${more(commands, 20)}`);
  for (const n of cap(commands, 20)) console.log(`  $ ${clip(n.properties?.command ?? n.title, 150)}`);

  const touched = of('BenchmarkTraceCodeFile');
  console.log(`\nfiles touched — ${touched.length}${more(touched, 20)}`);
  for (const n of cap(touched, 20)) console.log(`  ${n.subtitle ?? n.title}`);

  console.log(`\nwhole graph as JSON:  node scripts/bench-cli.mjs trace ${runId} --out trace.json`);
  process.exit(0);
}

if (command === 'proof') {
  const runId = process.argv[3];
  if (!runId) { console.error('usage: bench-cli.mjs proof <run_id> [--out proof.json]'); process.exit(1); }
  const files = findShardFiles(dataDir, 'proofs-');
  if (files.length === 0) { console.error(`no proofs-*.jsonl.gz under ${dataDir} — run: node scripts/bench-cli.mjs fetch`); process.exit(1); }
  const hit = await findByRunId(files, runId);
  if (!hit) { console.error(`no proof bundle for ${runId}`); process.exit(1); }
  const out = arg('out', null);
  if (out) {
    writeFileSync(out, JSON.stringify(hit.row, null, 2));
    console.log(`proof bundle → ${out}\nverify it: node scripts/verify-proof.mjs ${out}`);
    process.exit(0);
  }
  if (arg('json', false)) { console.log(JSON.stringify(hit.row, null, 2)); process.exit(0); }

  const b = hit.row.proof_bundle ?? hit.row;
  const m = JSON.parse(b.manifestCanonical);
  const run = loadRuns(dataDir, { tier: 'all' }).find((r) => r.run_id === runId);
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v ?? '—'}`);
  console.log(`run ${runId}   (${hit.file})\n`);
  console.log('what ran');
  // manifest.issue_number is 0 for PR-targeted (SWE-bench) instances; the run row's
  // `item` is the resolved repo#issue in every case.
  line('repo#issue', run?.item ?? `${m.repo}#${m.issue_number}`);
  line('outcome', run ? `${outcomeOf(run)} (${run.verification_level || 'no level'}, campaign ${run.campaign_id})` : null);
  line('base commit', m.base_commit);
  line('model', `${m.provider} / ${m.model}  (resolved: ${m.agent_runtime?.provider_resolved_model ?? '—'})`);
  line('config', m.canonical_model_config);
  line('engine / mode', `${m.execution_engine} / ${m.execution_mode}`);
  line('reasoning effort', m.reasoning_effort);
  line('agent binary', `${m.agent_runtime?.binary_path ?? '—'}  ${m.agent_runtime?.version_probe_status?.stdout ?? ''}`.trim());
  line('tool versions', JSON.stringify(m.tool_versions ?? {}));
  line('prompt hash', m.agent_runtime?.prompt_hash);
  line('tool schema hash', m.agent_runtime?.tool_schema_hash);
  line('mcp catalog', `${m.agent_runtime?.mcp_catalog_hash ?? '—'} (${m.agent_runtime?.mcp_tool_count ?? 0} tools)`);
  console.log('\nwhich software (from the signed manifest)');
  line('gateway repo', m.gateway?.git_repository);
  line('gateway commit', m.gateway?.git_commit);
  line('image digest', m.gateway?.image_digest);
  line('source codeHash', b.gateway?.buildInfo?.source?.hash);
  console.log('\nTEE attestation');
  line('platform', b.attestation?.platform);
  line('attested at', b.attestation?.timestamp);
  line('codeHash in report', b.attestation?.codeHash);
  line('launch measurement', Buffer.from(b.attestation?.reportHex ?? '', 'hex').subarray(0x90, 0xC0).toString('hex') || null);
  line('signing key', b.signature?.keyId);
  line('manifest hash', b.manifestHash);
  console.log(`\nverify it offline (recomputes every link, no network):\n  node scripts/bench-cli.mjs proof ${runId} --out proof.json && node scripts/verify-proof.mjs proof.json`);
  process.exit(0);
}

if (command === 'routing') {
  const tasks = loadTasks(dataDir);
  const runs = applyFilters(loadRuns(dataDir, { tier: arg('tier', 'all') }), tasks)
    .filter((r) => r.item); // synthetic tasks have no repo#issue — not routable
  const minRuns = Number(arg('min-runs', 1));
  const cells = new Map();
  for (const run of runs) {
    const key = `${run.item} ${run.config_name}`;
    let cell = cells.get(key);
    if (!cell) {
      const f = facetsOf(run, tasks);
      cells.set(key, cell = {
        item: run.item, task_id: run.task_id, language: f.language, complexity: f.complexity,
        issue_type: f.issue_type, config_name: run.config_name, config_id_resolved: run.config_id_resolved,
        canonical_model: run.canonical_model, model_tier: run.model_tier, billing_class: run.billing_class,
        n: 0, passes: 0, costs: [], closenesses: [],
      });
    }
    cell.n += 1;
    if (outcomeOf(run) === 'solved') cell.passes += 1;
    const cost = costOf(run); if (cost != null) cell.costs.push(cost);
    const close = closenessOf(run); if (close != null) cell.closenesses.push(close);
  }
  const rows = [...cells.values()].filter((c) => c.n >= minRuns).map((c) => ({
    item: c.item, task_id: c.task_id, language: c.language, complexity: c.complexity, issue_type: c.issue_type,
    config_name: c.config_name, config_id_resolved: c.config_id_resolved, canonical_model: c.canonical_model,
    model_tier: c.model_tier, billing_class: c.billing_class,
    n: c.n, passes: c.passes, solve_rate: c.n ? c.passes / c.n : 0,
    mean_cost_usd: c.costs.length ? c.costs.reduce((a, b) => a + b, 0) / c.costs.length : null,
    mean_closeness: c.closenesses.length ? c.closenesses.reduce((a, b) => a + b, 0) / c.closenesses.length : null,
  }));
  const out = arg('out', null);
  const headers = ['item', 'task_id', 'language', 'complexity', 'issue_type', 'config_name', 'config_id_resolved',
    'canonical_model', 'model_tier', 'billing_class', 'n', 'passes', 'solve_rate', 'mean_cost_usd', 'mean_closeness'];
  if (out?.endsWith('.csv')) { writeFileSync(out, toCsv(rows, headers)); console.log(`${rows.length} routing cells → ${out}`); }
  else if (out) { writeFileSync(out, JSON.stringify(rows, null, 2)); console.log(`${rows.length} routing cells → ${out}`); }
  else console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (command === 'export') {
  const shard = arg('shard', 'runs');
  const csvPath = arg('csv', null);
  if (!csvPath) { console.error('usage: bench-cli.mjs export --shard runs|tasks|configs --csv out.csv'); process.exit(1); }
  const files = findShardFiles(dataDir, `${shard}-`);
  const rows = files.flatMap(readJsonl);
  if (rows.length === 0) { console.error(`no ${shard}-*.jsonl.gz under ${dataDir}`); process.exit(1); }
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  writeFileSync(csvPath, toCsv(rows, headers));
  console.log(`${rows.length} ${shard} rows → ${csvPath} (${headers.length} columns; nested objects JSON-encoded)`);
  process.exit(0);
}

console.error(`unknown command: ${command} — run with no arguments for help`);
process.exit(1);
