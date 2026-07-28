#!/usr/bin/env node
// Assemble the dataset locally from GitHub Releases. Node stdlib only — no install.
//
//   node scripts/fetch-dataset.mjs [--out ./data] [--verify]
//   node scripts/fetch-dataset.mjs --snapshot-only
//   node scripts/fetch-dataset.mjs --since v2026.08.01          releases published AFTER that tag
//   node scripts/fetch-dataset.mjs --shards runs,tasks,configs,difficulty
//
// Default: newest full snapshot + every delta published after it — the smallest
// set of releases that reconstructs the current dataset. Superseded releases
// (the genesis snapshot, dailies already folded into the newest snapshot) are
// never downloaded.
//
// --shards limits which kinds of asset to pull. proofs-* and traces-* are ~95% of
// the bytes and no leaderboard/routing query touches them:
//   --shards runs,tasks,configs,difficulty     ~2% of the full download
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const REPO = process.env.DATA_REPO ?? 'rickycambrian/rickydata-bench-data';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const API = `https://api.github.com/repos/${REPO}`;

const BOOL_FLAGS = new Set(['verify', 'snapshot-only']);
function arg(name, fallback) {
  // accepts both --name=value and --name value
  const idx = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return fallback;
  const hit = process.argv[idx];
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const next = process.argv[idx + 1];
  return BOOL_FLAGS.has(name) || next === undefined || next.startsWith('--') ? true : next;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'rickydata-bench-data-fetch' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'rickydata-bench-data-fetch' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function fetchRelease(tag, outRoot, verify, ledgerSha, shards) {
  const release = await getJson(`${API}/releases/tags/${tag}`);
  const dir = join(outRoot, tag);
  await mkdir(dir, { recursive: true });
  const manifestAsset = release.assets.find((a) => a.name.startsWith('manifest-'));
  if (!manifestAsset) {
    // Without the manifest there is nothing to check the shards against, so --verify
    // would silently degrade to "downloaded something".
    if (verify) throw new Error(`${tag}: release has no manifest asset — cannot verify`);
    console.warn(`  WARNING ${tag}: no manifest asset; shard checksums unavailable`);
  }
  let manifest = null;
  if (manifestAsset) {
    const buf = await download(manifestAsset.browser_download_url, join(dir, manifestAsset.name));
    // The manifest is the trust root for every shard in the release, so check IT
    // against index/releases.json — which lives in git history, not in the mutable
    // release assets. Without this, whoever can rewrite an asset can rewrite the
    // checksums it is verified against.
    if (ledgerSha) {
      const got = sha256(buf);
      if (got !== ledgerSha) {
        throw new Error(`${tag}: manifest sha256 ${got} does not match index/releases.json (${ledgerSha})`);
      }
    } else if (verify) {
      console.warn(`  WARNING ${tag}: not in index/releases.json — manifest is self-attested only`);
    }
    manifest = JSON.parse(buf.toString('utf8'));
  }
  const bySha = new Map((manifest?.assets ?? []).map((a) => [a.name, a.sha256]));
  for (const asset of release.assets) {
    if (asset.name === manifestAsset?.name) continue;
    if (shards && !shards.has(asset.name.replace(/-.*$/, ''))) continue;
    const buf = await download(asset.browser_download_url, join(dir, asset.name));
    if (verify) {
      if (!bySha.has(asset.name)) throw new Error(`${tag}/${asset.name}: not listed in the manifest`);
      const got = sha256(buf);
      if (got !== bySha.get(asset.name)) throw new Error(`sha256 mismatch: ${tag}/${asset.name}`);
    }
    console.log(`  ${tag}/${asset.name} (${buf.length} bytes)${verify ? ' ✓' : ''}`);
  }
  return manifest;
}

async function main() {
  const outRoot = arg('out', './data');
  const verify = Boolean(arg('verify', false));
  const since = arg('since', null);
  const snapshotOnly = Boolean(arg('snapshot-only', false));

  const shardList = arg('shards', null);
  const shards = typeof shardList === 'string' ? new Set(shardList.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const latest = await getJson(`${RAW}/index/latest.json`);
  const releases = await getJson(`${RAW}/index/releases.json`);
  const byTag = new Map(releases.map((r) => [r.tag, r]));
  const at = (tag) => byTag.get(tag)?.published_at ?? '';

  // Order by published_at, not array position: a --republish rewrites its entry in
  // place, so a rebuilt snapshot keeps the array slot it had before the dailies
  // that are now older than it. Slicing on position then re-downloads releases the
  // snapshot already contains.
  const ordered = [...releases].sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));

  let wanted;
  if (snapshotOnly) {
    wanted = [latest.snapshot_tag];
  } else if (typeof since === 'string') {
    if (!byTag.has(since)) throw new Error(`--since ${since}: not found in index/releases.json`);
    wanted = ordered.filter((r) => String(r.published_at) > at(since)).map((r) => r.tag);
  } else {
    // Newest snapshot + every release published after it. A snapshot is self-contained,
    // so everything published before it is already inside it and is skipped.
    const cutoff = at(latest.snapshot_tag);
    wanted = cutoff
      ? [latest.snapshot_tag, ...ordered.filter((r) => String(r.published_at) > cutoff).map((r) => r.tag)]
      : ordered.map((r) => r.tag);
  }
  wanted = wanted.filter(Boolean);

  const skipped = releases.length - wanted.length;
  console.log(`fetching ${wanted.length} release(s) → ${outRoot}${verify ? ' (verifying sha256)' : ''}`
    + `${skipped > 0 ? `; ${skipped} superseded release(s) skipped` : ''}`
    + `${shards ? `; shards: ${[...shards].join(', ')}` : ''}`);
  let runs = 0;
  for (const tag of wanted) {
    const m = await fetchRelease(tag, outRoot, verify, byTag.get(tag)?.manifest_sha256 ?? null, shards);
    runs += m?.run_ids?.length ?? 0;
  }
  console.log(`done: ${wanted.length} releases, ~${runs} runs. schema_version ${latest.schema_version}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
