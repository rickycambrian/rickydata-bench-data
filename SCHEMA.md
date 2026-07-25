# Schema

`schema_version` follows the pattern **`major.minor`**. A **minor** bump is additive (new
fields only); a **major** bump can rename or remove fields. Current: **`1.3`**.

**1.3 (additive):** `difficulty-*` rows gain `language` (normalized repo language, null when
unknown — 164/176 items today). Run rows already carried `task_language`; this makes the
difficulty table filterable on its own, without a join back to runs.

**1.2 (additive):** new `difficulty-*.jsonl.gz` shard — per-task difficulty snapshot
(blend-v1 score from observed outcomes). Unlike `tasks-*` (dimension deltas), the
difficulty shard is a **full re-emit in every release**: the score is mutable and
strengthens as more benchmarks run, so the latest release wins (dedupe by `item`,
keep max `as_of`). 1.0/1.1 consumers are unaffected.

**1.1 (additive):** run rows gain `task_complexity` / `task_issue_type` (denormalized from the
task join, like `task_language`), `reproduce_command` (the exact CLI line to re-run the
benchmark), `attestation_code_hash` / `attestation_image_digest` (TEE image provenance), and
`teammate_provider_models` (multi-agent lineups). `task_language` now also falls back to a
repo-level language map when the run's task row is absent (task-id fragmentation), since
language is a property of the repo. All new fields are nullable — 1.0 consumers are unaffected.

Every shard is gzipped JSON Lines (`.jsonl.gz`) — one JSON object per line. `manifest-*.json`
is uncompressed and carries the sha256, byte size, and row count of every asset in its release.

Nulls are explicit (`null`), not omitted. Numbers that KFDB stores as strings (cost metrics)
are cast back to numbers on export.

---

## `runs-*.jsonl.gz` / `runs-config-name-only-*.jsonl.gz` — one row per run

The leaderboard table, split into **two config-identity tiers** — both are
`proof_verified` and pass `verify-proof.mjs` (every run in this dataset is TEE-attested):

- **`runs-*.jsonl.gz`** — `config_name` resolves to the config catalog (`identity_tier: "catalog"`).
  The primary shard; take only this for a clean, catalogued leaderboard.
- **`runs-config-name-only-*.jsonl.gz`** — TEE-verified, but the config isn't in the
  catalog yet (newer engines/arms, e.g. `kimi-k2.7`, `routed-*`) so identity is the raw
  `config_name` (`identity_tier: "config_name_only"`, `config_id_resolved: null`). Still
  fully usable for routing — `config_name` is a valid grouping key. Concatenate both
  shards for maximum coverage.

Each row carries the raw config identity (as recorded) **and** the resolved identity
(normalized against the catalog) so you can group correctly without re-deriving anything.

### Identity & provenance
| Field | Type | Notes |
|-------|------|-------|
| `run_id` | string (uuid) | primary key; join key for diffs/proofs/traces |
| `task_id` | string | → `tasks` shard |
| `campaign_id` | string | e.g. `benchmark_matrix_current` |
| `repo` | string | public source repo |
| `issue_number` | number \| null | backfilled from the task when the run row lacks it |
| `source_repo` | string \| null | canonical repo from the task join |
| `item` | string \| null | `repo#issue` — the key for per-task routing cells; `null` for synthetic tasks with no GitHub issue |
| `task_language` | string \| null | from the task join; falls back to the repo-level language when the task row is absent |
| `task_complexity` | string \| null | from the task join (issue-specific — never inferred) |
| `task_issue_type` | string \| null | from the task join (issue-specific — never inferred) |
| `created_at` | string (ISO 8601) | |
| `created_at_ms` | number | epoch ms |

### Raw config identity (as recorded)
| Field | Type | Notes |
|-------|------|-------|
| `config_name` | string | the raw config string incl. overlay suffixes (`+ponytail`, `-evo-…`) |
| `provider` | string | noisy — engine-as-provider on some rows; prefer resolved fields |
| `model` | string | |
| `billing_profile` | string | |
| `runtime_family` | string | |
| `execution_mode` | string | |
| `execution_backend` | string | |
| `context_strategy` | string | |
| `thinking_mode` | string | `disabled`/`enabled`/`high`/`medium`/`ultra` |
| `orchestrator_provider` / `orchestrator_model` | string | multi-agent runs |
| `teammates` | array | redacted |
| `team_prompt` | string | redacted |
| `prompt_template_id` / `prompt_variant_id` / `prompt_version` | string | |
| `attempt_policy` | string | |
| `evo_experiment_id` / `learning_experiment_id` | string | |

### Resolved config identity (normalized)
| Field | Type | Notes |
|-------|------|-------|
| `identity_tier` | `catalog` \| `config_name_only` | which run shard the row lives in (see the two-shard split above) |
| `config_id_resolved` | string \| null | catalog id; `null` (flagged, not fabricated) when `config_name` has no catalog entry — always `null` for `config_name_only` rows |
| `base_config` | string | catalog id with overlay stripped |
| `tool_overlay` | string \| null | overlay arm (`ponytail`, `evo-…`) |
| `canonical_model` | string \| null | normalized model identity |
| `model_tier` | string \| null | frontier/mid/cheap tiering |
| `billing_class` | `subscription` \| `metered` | subscription = $0 marginal spend |
| `production_evidence` | boolean | true = apples-to-apples leaderboard cohort |

### Outcome
| Field | Type | Notes |
|-------|------|-------|
| `success` | boolean | |
| `test_passed` | boolean | the correctness gate |
| `quality_score` | object \| null | parsed; `composite` is the closeness-to-merged score |
| `verification_level` | string | |
| `evidence_class` | string | |
| `proof_verified` | boolean | always `true` in this dataset |
| `proof_verification_status` / `attestation_verdict` | string | |
| `proof_manifest_hash` | string | |
| `attestation_code_hash` / `attestation_image_digest` | string \| null | TEE image provenance |
| `stop_reason` | string | |
| `error` | string \| null | redacted |
| `failure_category` / `failure_source` | string \| null | from trace summary |
| `infra_excluded` | boolean | true = failure was infra, exclude from model rates |

### Cost
| Field | Type | Notes |
|-------|------|-------|
| `actual_cost_usd` | number | real incremental spend; `0` for subscription providers |
| `duration_seconds` | number | |
| `cost_metrics` | object | parsed; includes `theoretical_cost_usd` (PAYG rate-card reference used for cost charts) |

### Extras & sibling presence
| Field | Type | Notes |
|-------|------|-------|
| `metadata` | object | redacted; skill-experiment arm tags kept |
| `test_delta` | object | |
| `reproduce_command` | string \| null | exact CLI line to re-run this benchmark (repo/issue/config/base commit — all public) |
| `teammate_provider_models` | array \| null | provider/model lineup on multi-agent runs |
| `trace_id` | string \| null | → `traces` shard |
| `diff_present` / `trace_present` / `proof_present` | boolean | is there a sibling-shard row for this run |

**Never present:** `tenant_id`, `user_id`, wallet fields, `generated_diff`,
`proof_bundle_json`, `trace_kg_summary_json`, `run_configuration_json` (the heavy blobs live in
sibling shards, the identity fields are redacted out).

---

## `configs-*.jsonl.gz` — one row per config (dimension delta)

| Field | Type | Notes |
|-------|------|-------|
| `config_id` | string | primary key; matches `runs.base_config` |
| `provider` / `provider_label` | string | |
| `model_id` / `model_label` / `model_full_id` | string | |
| `execution_engine` | string | claude-code / hermes / rickydata-cli / … |
| `execution_mode` | string | |
| `toolset` | string | |
| `reasoning_effort` | string | |
| `display_label` | string | |
| `metered_pricing_profile` | string | PAYG rate card |
| `runner_provider` | string | |
| `currently_executable` | boolean | still runnable today |
| `canonical_model` / `model_tier` / `billing_class` | string | normalization (same basis as runs) |
| `first_seen_release` | string | tag where this config first appeared |

---

## `tasks-*.jsonl.gz` — one row per task (dimension delta)

| Field | Type | Notes |
|-------|------|-------|
| `task_id` | string | primary key |
| `source_repo` | string | |
| `issue_number` | number | |
| `issue_title` | string \| null | |
| `issue_type` | string | |
| `language` | string | |
| `complexity` | string | |
| `labels` | array \| null | GitHub issue labels |
| `base_commit` | string | pre-fix commit (public) |
| `sanitized_prompt` | string | the issue text given to the agent |
| `gold_diff` | string | the **merged human PR** — the grading gold |
| `gold_files_changed` | array | |
| `test_command` | string | the correctness gate |
| `test_framework` | string \| null | |
| `task_version` | string \| null | fixture revision |
| `created_at` | string (ISO 8601) \| null | when the fixture was registered |

A task is identified by `repo#issue`; it carries no `campaign_id` (a fixture can be reused across campaigns, and the column can hold a non-public research-campaign name).

---

## `diffs-*.jsonl.gz`
`run_id`, `generated_diff` (sanitized agent patch — separate shard because rows reach ~1 MB).

## `proofs-*.jsonl.gz`
`run_id`, `proof_bundle` (verbatim self-contained SEV-SNP quote + cert chain + Ed25519
signature over the canonical manifest — shipped byte-identical so signatures verify).

## `traces-*.jsonl.gz`
`run_id`, `trace_id`, `graph` (redacted public agent trace read model).

## `difficulty-*.jsonl.gz` — one row per task item (full snapshot, schema ≥ 1.2)

Per-task difficulty from observed benchmark outcomes. **Snapshot semantics** — every
release re-emits the full table; keep the row with the max `as_of` per `item` and join
runs via `item` (`repo#issue`).

| Field | Type | Notes |
|-------|------|-------|
| `item` | string | `repo#issue` — join key to run rows |
| `repo` | string \| null | |
| `difficulty_score` | number \| null | **headline, 0–100** — `blend-v1: 0.7·solve_pct + 0.3·cost_pct`; null when only one model attempted (unfittable) |
| `solve_pct` | number \| null | midrank percentile of Rasch difficulty (all-pass → 0, all-fail → 100) |
| `cost_pct` | number \| null | midrank percentile of `cost_to_solve_usd`; no successful run → 100 |
| `rasch_difficulty` | number \| null | 1-PL item difficulty (deterministic JMLE) |
| `rasch_se` | number \| null | standard error — how much evidence backs the estimate |
| `rasch_excluded` | string \| null | `all_pass` \| `all_fail` when degenerate |
| `discrimination` | number \| null | |
| `zone` | string \| null | `trivial` \| `premium_separable` \| `beyond_frontier` \| `partial_credit_hard` \| `no_frontier_data` |
| `mean_success_rate` | number \| null | raw solve rate across all runs |
| `cost_to_solve_usd` | number \| null | median PAYG **theoretical** cost over successful runs |
| `cheapest_solving_model` | string \| null | |
| `n_successful_runs`, `n_attempts`, `n_models`, `n_tiers` | number \| null | evidence counts |
| `frontier_ceiling`, `cheap_mean`, `gap` | number \| null | tier separation facets |
| `language` | string \| null | schema ≥ 1.3 — normalized repo language (`rust`, `python`, …); null when neither KFDB nor the core-set metadata knows it |
| `as_of` | string \| null | seed `generated_at` (max source-row timestamp, clock-free) |

---

## `manifest-*.json`

| Field | Notes |
|-------|-------|
| `schema_version`, `tag`, `kind` (`daily`\|`snapshot`), `generated_at`, `exporter_commit` | |
| `assets[]` | `{name, sha256, bytes, rows}` for every shard in the release |
| `run_ids[]` | every run in this release |
| `created_at_range` | `{min, max}` ISO |
| `campaigns[]` | distinct campaigns present |
| `counts_by_config` | `{config_name: count}` |
| `full_fidelity_since` | (optional) cutover date after which diffs/traces are full-fidelity vs legacy-truncated |
