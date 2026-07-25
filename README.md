# rickydata-bench-data

Complete, TEE-verified public benchmark data behind **[bench.rickydata.org](https://bench.rickydata.org)**.

Every row is a real coding-agent run on a **public** GitHub issue, solving the issue and
scoring the result against the merged human PR — carried out inside an AMD SEV-SNP Trusted
Execution Environment and shipped with a self-contained cryptographic proof. There is **no
private tenant data here** and no run that isn't proof-verified.

This repo holds only docs, schemas, and a small ledger. **The data ships as
[GitHub Release](https://github.com/rickycambrian/rickydata-bench-data/releases) assets** —
gzipped JSON Lines shards — so `git clone` stays tiny and you download only the shards you need.

- **Daily** tags (`vYYYY.MM.DD`) — incremental: the new eligible runs completed that UTC day.
- **Monthly** snapshots (`snapshot-YYYY.MM`) — a self-contained full copy.
- Genesis snapshot: `snapshot-2026.07-genesis`.

A release ships when there are new eligible runs **or** an updated difficulty snapshot (the
score is recomputed from all accumulated evidence, so it can move on its own). A day with
neither publishes nothing — there are gaps in the daily sequence by design. A difficulty-only
release carries just `difficulty-*.jsonl.gz` and its manifest; empty shards are never uploaded.

---

## Quick start — 60 seconds, no install

Everything below uses only the Node standard library. Clone, then:

```bash
node scripts/bench-cli.mjs fetch                 # download + sha256-verify the dataset → ./data
node scripts/bench-cli.mjs info                  # what you have: runs, tasks, languages, dates
node scripts/bench-cli.mjs leaderboard --by=model --production
                                                 # solve% + cost per model, apples-to-apples cohort
node scripts/bench-cli.mjs best --group=language --by=model
                                                 # "which model is best for python? for rust?"
node scripts/bench-cli.mjs task pallets/click#3277
                                                 # every attempt on one issue + how to reproduce it
node scripts/bench-cli.mjs routing --out cells.csv
                                                 # per-(item, config) routing cells → CSV
node scripts/bench-cli.mjs export --shard runs --csv runs.csv
                                                 # flat CSV for spreadsheets / pandas / DuckDB
node scripts/bench-cli.mjs leaderboard --by=model --min-difficulty 70
                                                 # who actually solves the hard tasks?
```

Useful flags: `--language python|rust|…`, `--complexity simple|medium|high`, `--repo owner/name`,
`--issue-type bug_fix|…`, `--tier catalog` (only catalogued configs), `--min-runs N`, `--json`.
Infra-caused failures (`infra_excluded`) are always excluded from rates.

**Difficulty filters** (schema ≥ 1.2): `--min-difficulty 0-100`, `--max-difficulty 0-100`,
`--difficulty-zone premium_separable|beyond_frontier|trivial|…`. The score is measured from
observed outcomes — `0.7 × solvability percentile + 0.3 × cost-to-solve percentile` — and is
recomputed as more benchmarks land, so it sharpens over time. Runs on items with no difficulty
row yet are excluded from difficulty-filtered views.

`fetch` wraps `scripts/fetch-dataset.mjs`, which also works standalone:

```bash
node scripts/fetch-dataset.mjs --out ./data --verify      # snapshot + all deltas after it
node scripts/fetch-dataset.mjs --snapshot-only --out ./data
node scripts/fetch-dataset.mjs --since v2026.08.01 --out ./data
```

### Query the shards directly

The shards are newline-delimited JSON, gzipped. Nothing is partitioned by config — download
flat and filter on the resolved columns.

The run rows come in **two config-identity tiers**, both TEE-attested (all `proof_verified`):
`runs-*.jsonl.gz` (catalog-resolved config) and `runs-config-name-only-*.jsonl.gz`
(TEE-verified but the config isn't catalogued yet — identity is the raw `config_name`). The
`runs-*` glob matches **both**; add `WHERE identity_tier = 'catalog'` (or read only the exact
`runs-<tag>` file) to restrict to the catalogued leaderboard.

```sql
-- DuckDB: solve rate by canonical model, leaderboard-grade rows only
SELECT canonical_model, model_tier,
       count(*) AS runs,
       avg(CASE WHEN test_passed THEN 1 ELSE 0 END) AS solve_rate
FROM read_json_auto('data/**/runs-*.jsonl.gz')
WHERE production_evidence AND NOT infra_excluded
GROUP BY 1, 2
ORDER BY solve_rate DESC;
```

```bash
# jq: every run for one config
zcat data/**/runs-*.jsonl.gz | jq -c 'select(.config_id_resolved == "anthropic-opus-4.8-claude-code-single")'
```

```python
# pandas
import gzip, json, glob, pandas as pd
rows = [json.loads(l) for f in glob.glob('data/**/runs-*.jsonl.gz', recursive=True)
        for l in gzip.open(f, 'rt')]
df = pd.DataFrame(rows)
```

Heavy blobs are **separate sibling shards keyed by `run_id`** so a leaderboard query never
downloads them: `diffs-*` (generated patch), `proofs-*` (attestation bundle),
`traces-*` (agent trace graph). Join on `run_id` only when you need them.

### Calibrate model routing (no benchmark compute)

Routing only needs **run-level outcomes**, not traces. Every run carries `item` (`repo#issue`),
a resolved config, task facets (`task_language` / `task_complexity` / `task_issue_type`), a pass
signal (`proof_verified` / `test_passed`), closeness-to-merged-PR (`quality_score.composite`),
and `cost_metrics.theoretical_cost_usd`. One command emits the per-`(item, config)` cells:

```bash
node scripts/bench-cli.mjs routing --out cells.csv    # or .json
```

Each cell: `{item, language, complexity, issue_type, config_name, canonical_model, model_tier,
billing_class, n, passes, solve_rate, mean_cost_usd, mean_closeness}` — feed it to a bandit /
router as-is. The same aggregation in pandas, if you'd rather own it:

```python
import gzip, json, glob, pandas as pd
rows = [json.loads(l) for f in glob.glob('data/**/runs-*.jsonl.gz', recursive=True)
        for l in gzip.open(f, 'rt')]
df = pd.DataFrame(rows)
df = df[df['item'].notna() & ~df['infra_excluded']]        # drop synthetic + infra failures
df['cost'] = df['cost_metrics'].apply(lambda c: (c or {}).get('theoretical_cost_usd'))
cells = df.groupby(['item', 'config_name']).agg(          # config_name keeps uncatalogued arms distinct
    n=('run_id', 'size'),
    passes=('test_passed', 'sum'),
    solve_rate=('test_passed', 'mean'),
    mean_cost=('cost', 'mean')).reset_index()
```

Traces (`traces-*`) are only needed for step-level behavioral analysis, not routing. Trace
coverage is ~100% for recent runs and sparse for pre-July legacy runs (events were purged on
ingest); see each release's `manifest` for the fidelity range.

### Verify a proof offline

```bash
node scripts/verify-proof.mjs data/**/proofs-*.jsonl.gz
```

Checks the Ed25519 signature over each run's canonical manifest and the AMD SEV-SNP
certificate chain against the pinned AMD root — entirely offline, no network.

---

## What's in each release

| Shard | One row per | Contents |
|-------|-------------|----------|
| `runs-*.jsonl.gz`    | run    | catalog-resolved-config runs (`identity_tier: catalog`) — outcome, cost, raw **and** resolved config identity, proof status; the leaderboard table |
| `runs-config-name-only-*.jsonl.gz` | run | TEE-verified runs whose config isn't catalogued yet (`identity_tier: config_name_only`); same columns, `config_id_resolved: null` |
| `configs-*.jsonl.gz` | config | catalog tuple (provider, model, engine, mode, toolset, reasoning effort) + normalization |
| `tasks-*.jsonl.gz`   | task   | the public issue: repo, language, complexity, sanitized prompt, **gold_diff** (merged PR), test command |
| `diffs-*.jsonl.gz`   | run    | the agent's generated patch (sanitized) |
| `proofs-*.jsonl.gz`  | run    | the self-contained TEE attestation bundle (verbatim, for signature checks) |
| `traces-*.jsonl.gz`  | run    | the public agent trace read model |
| `difficulty-*.jsonl.gz` | task item | measured per-task difficulty: `difficulty_score` (0–100), solvability + cost-to-solve components, Rasch estimate + SE, zone, evidence counts |
| `manifest-*.json`    | —      | sha256 + byte + row count for every asset; `run_ids`, campaigns, date range |

`configs` and `tasks` are **dimension deltas** — a daily ships only entries new since the last
release; monthly snapshots carry the full set. Run/diff/proof/trace shards are disjoint by
`run_id` across dailies. `difficulty` is different: it is a **full snapshot in every release**
(the score is mutable and keeps updating), so take the newest release's shard, or dedupe by
`item` keeping max `as_of`. See [SCHEMA.md](./SCHEMA.md) for every field.

### Eligibility (what makes it into the data)

A run is published when **all** hold:

- its campaign is on the bench public API surface (`benchmark_matrix_*`,
  `subscription_causal_routing_v1_*`, `routing_confirmatory_*`, `tools_comparison_*`,
  `ponytail_leanness_*`, `frontier_reference_*`, `cascade_routing_*`);
- it is **not** a non-production campaign (canary/test/debug/smoke/…);
- `proof_verified === true` (pre-proof-era / non-TEE rows are excluded entirely — the
  dataset is 100% TEE-attested);
- it is not an artifact/canary model row;
- it hasn't been published before.

Every published run is then placed in one of two config-identity tiers (see the shard table
above): **`catalog`** (config resolves to the catalog) or **`config_name_only`** (TEE-verified
but not catalogued yet). Both are proof-verified; the split is a shard boundary, not an
eligibility gate.

Research campaigns (wiki_*, fleet_routing_*, E0xx, causal_proof_*, …) are **never** published.

`production_evidence` flags the apples-to-apples leaderboard cohort; `infra_excluded` flags
runs whose failure was infrastructure, not the model — filter both for clean rates.

---

## Run your own benchmarks (non-admin path)

You do **not** need to be an operator to benchmark a coding agent on a public repo. With your
own wallet and provider credentials you drive the same TEE gateway that produces this dataset,
watch results live, and — once verified — they flow into a future daily batch here.

1. **Add credentials.** At [rickydata.org/settings](https://rickydata.org/settings) connect a
   wallet (pays the TEE resolver) and your model-provider keys/subscriptions. Runs execute in
   the TEE under your account; billing is your wallet + your provider plan.
2. **Pick a repo and candidate issues.** Any public GitHub repo with closed issues that have a
   merged fixing PR works — the merged PR is the grading gold. Good candidates are issues with
   a clear failing test that the PR turns green. *(Automated candidate screening and repo
   onboarding are operator-assisted today; the self-serve path is a hand-picked issue URL.)*
3. **Launch a run** against the Agent Gateway with your config (model + engine + thinking
   effort + any tool overlay). The run resolves the issue in the TEE and scores closeness to
   the merged PR. Most published run rows carry a `reproduce_command` — the exact CLI line
   that produced them (`bench-cli.mjs task <repo#issue>` prints one) — so you can rerun any
   existing benchmark verbatim.
4. **Watch it live** on [bench.rickydata.org](https://bench.rickydata.org) — the run, its
   compare view, and its trace appear as it executes, before any batch.
5. **It lands here.** Once the run is proof-verified and its campaign is public, the next daily
   publisher picks it up and it appears in a `vYYYY.MM.DD` release.

Steps 2's screening automation and one-command repo onboarding are on the roadmap; today they
are admin-local tooling. Everything from step 3 on is self-serve.

---

## License

The **data compilation** in the releases is licensed **CC-BY-4.0** (see [LICENSE](./LICENSE)).
Embedded source excerpts (`gold_diff`, generated diffs) remain under their originating repos'
licenses — attribution and license notices travel with each task's `repo` field. The scripts
in this repo are MIT.
