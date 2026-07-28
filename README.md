# rickydata-bench-data

Complete, TEE-verified public benchmark data behind **[bench.rickydata.org](https://bench.rickydata.org)**.

Every row is a real coding-agent run on a **public** GitHub issue, solving the issue and
scoring the result against the merged human PR — carried out inside an AMD SEV-SNP Trusted
Execution Environment and shipped with a self-contained cryptographic proof.

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

Everything below uses only the Node standard library. 

First clone:
```bash
git clone https://github.com/rickycambrian/rickydata-bench-data.git
cd rickydata-bench-data
```

Then:
```bash
node scripts/bench-cli.mjs fetch                 # download + sha256-verify the dataset → ./data
node scripts/bench-cli.mjs fetch --shards runs,tasks,configs,difficulty
                                                 # …or ~2% of the bytes, skipping proofs + traces
node scripts/bench-cli.mjs info                  # what you have: runs, tasks, languages, dates
node scripts/bench-cli.mjs leaderboard --by=model --production
                                                 # solve% + cost per model, apples-to-apples cohort
node scripts/bench-cli.mjs best --group=language --by=model
                                                 # "which model is best for python? for rust?"
node scripts/bench-cli.mjs campaigns              # what each campaign is and how to read it
node scripts/bench-cli.mjs task pallets/click#3277
                                                 # every attempt on one issue + how to reproduce it
node scripts/bench-cli.mjs trace <run_id>        # what the agent actually did, step by step
node scripts/bench-cli.mjs proof <run_id>        # which software ran this, attested by the TEE
node scripts/bench-cli.mjs routing --out cells.csv
                                                 # per-(item, config) routing cells → CSV
node scripts/bench-cli.mjs export --shard runs --csv runs.csv
                                                 # flat CSV for spreadsheets / pandas / DuckDB
node scripts/bench-cli.mjs leaderboard --by=model --min-difficulty 70
                                                 # who actually solves the hard tasks?
```

Useful flags: `--language python|rust|…`, `--complexity simple|medium|high`, `--repo owner/name`,
`--issue-type bug_fix|…`, `--tier catalog` (only catalogued configs), `--min-runs N`, `--json`.

**Which rows count.** Rates are computed over *scored* runs only: `success` is true or false.
Runs whose failure was infrastructure (`infra_excluded`, or `verification_level:
runner_or_provider_error`) and runs that never reached a verdict are left out of both numerator
and denominator. `--class` picks the campaign class — `leaderboard` (the comparable cohort),
`study` (real experiments on a chosen issue set), `probe` (infra canaries). The default is
everything except `probe`; `--production` is the shorthand for `--class leaderboard`. Start with
`campaigns` to see what you have.

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
node scripts/fetch-dataset.mjs --shards runs,tasks,configs,difficulty --out ./data
```

The default is the newest full snapshot plus every release published after it — the smallest
set that reconstructs the current dataset. Superseded releases (the genesis snapshot, dailies
already folded into the newest snapshot) are never downloaded. `--shards` limits which kinds of
asset to pull: `proofs-*` and `traces-*` are ~95% of the bytes and no leaderboard or routing
query touches them, so `--shards runs,tasks,configs,difficulty` is ~2% of the full download.

Under `--verify`, the per-release `manifest-*.json` is itself checked against the
`manifest_sha256` recorded in `index/releases.json` — which lives in this repo's git history,
not in the mutable release assets — before any shard checksum is trusted.

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
       avg(CASE WHEN solved THEN 1 ELSE 0 END) AS solve_rate
FROM read_json_auto('data/**/runs-*.jsonl.gz')
WHERE campaign_class = 'leaderboard' AND score_status = 'scored'
GROUP BY 1, 2
ORDER BY solve_rate DESC;
```

> **Score on `solved`, never on `test_passed`.** `solved` (== `success`) is the canonical verdict
> and is what bench.rickydata.org reports. `test_passed` is populated only by the L4 harness
> paths, so a query that scores on it silently counts every L1/L3-verified solve as a failure —
> on the current corpus that turns a 60% model into a 4% one. `score_status` says whether a row
> belongs in a denominator at all (`scored` | `unscored` | `infra_excluded`).

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
signal (`solved` / `score_status`), closeness-to-merged-PR (`quality_score.composite`),
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
df = df[df['item'].notna()                                 # drop rows with no routable item
        & (df['score_status'] == 'scored')                 # drop infra + unscored
        & (df['campaign_class'] != 'probe')]               # drop infra canaries
df['cost'] = df['cost_metrics'].apply(lambda c: (c or {}).get('theoretical_cost_usd'))
cells = df.groupby(['item', 'config_name']).agg(          # config_name keeps uncatalogued arms distinct
    n=('run_id', 'size'),
    passes=('solved', 'sum'),
    solve_rate=('solved', 'mean'),
    mean_cost=('cost', 'mean')).reset_index()
```

Traces (`traces-*`) are only needed for step-level behavioral analysis, not routing. Trace
coverage is ~100% for recent runs and sparse for pre-July legacy runs (events were purged on
ingest); see each release's `manifest` for the fidelity range.

### Pull a full trace

Start from an issue, pick a run, read what the agent actually did:

```bash
node scripts/bench-cli.mjs task pallets/click#3277        # → run_id, outcome, level, cost
node scripts/bench-cli.mjs trace e447933a-1bb0-49b9-8481-c82535a31e38
```

```
run    e447933a-1bb0-49b9-8481-c82535a31e38
shard  data/snapshot-2026.07/traces-full.jsonl.gz
graph  89 nodes, 94 edges

timeline — 34 hook events
#   turn  event                   tool
--  ----  ----------------------  ------------
0   0     BenchmarkRunStarted     —
5   0     PostToolUse             Bash
13  0     PostToolUse             WebFetch
21  0     PostToolUse             Edit
33  0     AgentExecutionComplete  agent-runner

tool calls — 28
shell commands — 15
  $ python -m pytest tests/test_shell_completion.py -x 2>&1 | tail -20
  $ git diff
files touched — 5
  tests/test_shell_completion.py
  src/click/shell_completion.py
  ...
```

`--full` prints every event, command and tool call rather than the head of each list; `--out
trace.json` writes the whole graph (nodes + edges, verbatim from the shard) for your own
analysis; `--json` emits the summary as JSON. The trace is the read model published in
`traces-*.jsonl.gz` — join it yourself on `run_id` if you'd rather work in pandas.

### Prove it ran in a TEE

Every run ships a self-contained attestation bundle. `proof` reads it and prints what it
commits to — the task, the model and config, the agent binary, and the gateway build the AMD
hardware measured:

```bash
node scripts/bench-cli.mjs proof e447933a-1bb0-49b9-8481-c82535a31e38
```

```
what ran
  repo#issue             pallets/click#3277
  outcome                solved (L4, campaign benchmark_matrix_current)
  base commit            b8b9ffeb5d012f5d041685c81152636bf596cf72
  model                  minimax / MiniMax-M3  (resolved: MiniMax-M3)
  config                 minimax-minimax-m3-claude-code-single
  engine / mode          claude-code / single_agent
  reasoning effort       disabled
  agent binary           claude  2.1.212 (Claude Code)
  tool versions          {"claude_code":"image-installed","node":"v22.23.1"}
  prompt hash            sha256:e148577c…
  tool schema hash       sha256:4e651e42…
  mcp catalog            sha256:402dad9e… (2046 tools)

which software (from the signed manifest)
  gateway repo           rickycambrian/mcp_deployments_registry
  gateway commit         d9a32171c78bf06692139aa052e65706c9633d52
  image digest           sha256:1757434be73c1871376422005a757dccab41aeb6f46d734ee8ac4ec6a94625a4
  source codeHash        9c195ee37ee20a7040c1c7557bc88e3a682e0236baea82201a5cfdddba44d8b7

TEE attestation
  platform               AMD SEV-SNP
  attested at            2026-07-20T04:32:14.162Z
  codeHash in report     9c195ee37ee20a7040c1c7557bc88e3a682e0236baea82201a5cfdddba44d8b7
  launch measurement     e1bcdadef92887cb4512c079c485cf00…
  signing key            sha256:251bb5e587eceb34fda627adc6aa3c29d756e7829f363f0cf48ecb3bbbc2b1aa
  manifest hash          f80aa13ec91bf61733d8069853a5bdae47205ff7bcc7cd39b48d07c77f75f8bc
```

Then check it yourself. `verify-proof.mjs` recomputes every link offline — no network, no
trusted server, nothing but AMD's root certificate (pinned in the script by sha256 fingerprint):

```bash
node scripts/bench-cli.mjs proof e447933a-… --out proof.json
node scripts/verify-proof.mjs proof.json          # one run
node scripts/verify-proof.mjs data/**/proofs-*.jsonl.gz    # the whole corpus
```

**What the eight checks establish, in order:**

| # | Check | What it rules out |
|---|-------|-------------------|
| 1 | `sha256(manifestCanonical) == manifestHash` | the manifest was edited after signing |
| 2 | the signed payload **is** this bundle — same manifest, same attestation report, same gateway build | a real signature transplanted onto someone else's run |
| 3 | `sha256(public key SPKI) == keyId` | a substituted signing key |
| 4 | Ed25519 signature over `"<version>\n<signedPayloadCanonical>"` | forgery of the signed payload |
| 5 | VCEK ← SEV-Milan (ASK) ← ARK-Milan, ARK pinned to AMD's root | certs not descended from AMD |
| 6 | `REPORT_DATA` (bytes `0x50..0x90` of the AMD report) `== codeHash ‖ jwksHashTrunc16 ‖ customDataHashTrunc16` | a genuine report that attests *different* software |
| 7 | `sha256(binding.payloadCanonical)[:32] == customDataHashTrunc16`, and that payload contains `manifestHash=<this run's hash>` | a genuine report for a *different* run |
| 8 | `gateway.buildInfo.source.hash == codeHash` in `REPORT_DATA` | the disclosed source not being the attested source |

Read end to end: **AMD's root certificate → the VCEK → an SEV-SNP report whose `REPORT_DATA`
names one specific gateway build → a binding payload naming this run's manifest → a manifest
naming the repo, issue, base commit, model, config, agent binary, prompt hash and tool
versions.** Nothing in that chain requires trusting rickydata. The report's `MEASUREMENT` field
(bytes `0x90..0xC0`, printed as *launch measurement*) is the hardware's digest of the guest
image at launch; the `image digest` line is the OCI digest of the container that produced it.

`--strict` adds a ninth check: the report's own ECDSA-P384 signature against the VCEK shipped in
the same bundle. **This currently fails on most rows** — see [Known limitation](#known-limitation-vcek-pairing) below.

#### Known limitation: VCEK pairing

Each SEV-SNP report is signed by the VCEK of the specific CPU that produced it. On the current
corpus the gateway caches one VCEK per TCB rather than per (chip, TCB), so ~77% of bundles ship
a VCEK from a *different host in the same fleet*. Checks 1–8 all pass; check 9 does not.

Concretely: every report we have examined verifies against *some* VCEK in the fleet (9 distinct
certs), so the reports are genuine AMD hardware output — but you cannot complete that last step
using only the bytes in the bundle, which is exactly what "self-contained proof" should mean.
That is a gateway-side bug, tracked for a fix; until then check 9 is opt-in so the other eight
stay usable. If you need per-run hardware pairing today, use `--strict` and keep the ~23% that
pass.

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

- `proof_verified === true` — the TEE attestation bundle exists and checks out. Pre-proof-era
  and non-TEE rows are excluded entirely; the dataset is 100% TEE-attested;
- its config identity is coherent — the `config_name` resolves (directly or by decomposing a
  `+tool` / `-evo-…` overlay), and any signed `run_configuration` snapshot agrees with it;
- it is not an artifact/canary *model* row (a metadata placeholder, not a real inference);
- its campaign name does not belong to a third party (a tenant/customer/client namespace);
- it hasn't been published before.

**There is no campaign allowlist** (schema ≥ 1.5). Every TEE-verified run of a real task ships,
including the research campaigns and infra canaries that earlier schema versions withheld —
about 1,950 valid runs were being dropped on campaign name alone. Whether a run belongs in a
*leaderboard aggregate* is a different question from whether it exists, and each row answers it
itself via `campaign_class`:

| `campaign_class` | What it is | Use it for |
|---|---|---|
| `leaderboard` | the apples-to-apples cohort — a fixed config × issue matrix (`benchmark_matrix_*`, `routing_confirmatory_v1_*`, `subscription_causal_routing_v1_*`, `swebench-native*`) | ranking models against each other |
| `study` | a real experiment on a deliberately chosen issue set — tool overlays, routing pilots, difficulty calibration, extraction runs | studying the effect it was designed to measure |
| `probe` | infra canary / smoke / validation: real TEE runs that re-run a known-good issue to check the gateway | gateway health, nothing else |

`study` rows are valid evidence — the same TEE proof, the same grading — but their issue sets
were chosen for the experiment, so their solve rates are **not** comparable to the leaderboard's
or to each other's. `probe` rows would inflate any aggregate they land in, so the CLI excludes
them by default (`--class` overrides). `node scripts/bench-cli.mjs campaigns` lists every
campaign in your local data with its class, run count, solve rate and date range.

Each published run also lands in one of two **config-identity tiers** (see the shard table
above): `catalog` (config resolves to the catalog) or `config_name_only` (TEE-verified but not
catalogued yet — a new arm's first runs, or an arm carrying an active treatment that makes it
not-quite-the-catalog-config). Both are proof-verified; the split is a shard boundary, not an
eligibility gate.

For clean rates, filter on `score_status = 'scored'` (drops infra failures and runs that never
reached a verdict) and score on `solved`, not `test_passed`.

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
5. **It lands here.** Once the run is proof-verified, the next daily publisher picks it up and
   it appears in a `vYYYY.MM.DD` release. No campaign allowlist stands between a verified run
   and publication.

Steps 2's screening automation and one-command repo onboarding are on the roadmap; today they
are admin-local tooling. Everything from step 3 on is self-serve.

---

## License

The **data compilation** in the releases is licensed **CC-BY-4.0** (see [LICENSE](./LICENSE)).
Embedded source excerpts (`gold_diff`, generated diffs) remain under their originating repos'
licenses — attribution and license notices travel with each task's `repo` field. The scripts
in this repo are MIT.
