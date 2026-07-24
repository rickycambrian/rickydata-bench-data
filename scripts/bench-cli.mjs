#!/usr/bin/env node
// Explore the dataset without writing any code. Node stdlib only — no install.
//
//   node scripts/bench-cli.mjs fetch [--out ./data]              download + verify the dataset
//   node scripts/bench-cli.mjs info                              what's in the local data dir
//   node scripts/bench-cli.mjs leaderboard [filters]             solve rate + cost by config/model
//   node scripts/bench-cli.mjs best --group language             best models per problem facet
//   node scripts/bench-cli.mjs task <repo#issue>                 every attempt on one issue
//   node scripts/bench-cli.mjs routing --out cells.csv           per-(item, config) routing cells
//   node scripts/bench-cli.mjs export --shard runs --csv out.csv flatten a shard to CSV
//
// Common flags:
//   --data ./data          where fetch put the releases (default ./data)
//   --language python      filter: task language        --repo pallets/flask   filter: source repo
//   --complexity high      filter: task complexity      --issue-type bug       filter: issue type
//   --by model             group by canonical model instead of config_name
//   --tier catalog         only catalog-resolved configs (default: both tiers)
//   --production           only apples-to-apples leaderboard-cohort runs
//   --min-runs 5           hide groups with fewer runs (leaderboard: 5, best: 3)
//   --json                 machine-readable output instead of a table
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
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

function applyFilters(runs, tasks) {
  const language = arg('language', null);
  const complexity = arg('complexity', null);
  const issueType = arg('issue-type', null);
  const repo = arg('repo', null);
  const production = arg('production', false);
  return runs.filter((run) => {
    if (run.infra_excluded) return false; // infra failures never count against a model
    if (production && !run.production_evidence) return false;
    const f = facetsOf(run, tasks);
    if (language && f.language !== language) return false;
    if (complexity && f.complexity !== complexity) return false;
    if (issueType && f.issue_type !== issueType) return false;
    if (repo && f.repo !== repo) return false;
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
    if (run.test_passed === true) g.passes += 1;
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
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

if (command === 'fetch') {
  const res = spawnSync(process.execPath, [join(here, 'fetch-dataset.mjs'), `--out=${dataDir}`, '--verify'], { stdio: 'inherit' });
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
  console.log(`runs        ${runs.length} (${runs.filter((r) => r.identity_tier === 'catalog').length} catalog + ${runs.filter((r) => r.identity_tier === 'config_name_only').length} config-name-only)`);
  console.log(`tasks       ${tasks.size} (${items.size} distinct repo#issue items)`);
  console.log(`configs     ${configs.size} distinct config_names, ${campaigns.size} campaigns`);
  console.log(`languages   ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`date range  ${dates[0]?.slice(0, 10)} → ${dates.at(-1)?.slice(0, 10)}`);
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
  console.log(`\n${runs.length} runs after filters; groups with <${minRuns} runs hidden (--min-runs). Cost = PAYG rate-card reference.`);
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
  const rows = runs.sort((a, b) => (b.test_passed === true) - (a.test_passed === true) || (costOf(a) ?? 1e9) - (costOf(b) ?? 1e9));
  printTable(rows, [
    { label: 'config', get: (r) => r.config_name },
    { label: 'passed', get: (r) => r.test_passed === true ? 'yes' : r.infra_excluded ? 'infra' : 'no' },
    { label: 'closeness', get: (r) => fmt(closenessOf(r)) },
    { label: 'cost $', get: (r) => fmt(costOf(r), 3) },
    { label: 'when', get: (r) => r.created_at?.slice(0, 10) ?? '—' },
  ]);
  const repro = runs.find((r) => r.reproduce_command)?.reproduce_command;
  if (repro) console.log(`\nreproduce: ${repro}`);
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
    if (run.test_passed === true) cell.passes += 1;
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
