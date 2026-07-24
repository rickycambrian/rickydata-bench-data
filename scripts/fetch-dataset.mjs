#!/usr/bin/env node
// Assemble the dataset locally from GitHub Releases. Node stdlib only — no install.
//
//   node scripts/fetch-dataset.mjs [--out ./data] [--verify]
//   node scripts/fetch-dataset.mjs --snapshot-only
//   node scripts/fetch-dataset.mjs --since v2026.08.01
//
// Default: newest full snapshot + every daily delta published after it.
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

async function fetchRelease(tag, outRoot, verify) {
  const release = await getJson(`${API}/releases/tags/${tag}`);
  const dir = join(outRoot, tag);
  await mkdir(dir, { recursive: true });
  const manifestAsset = release.assets.find((a) => a.name.startsWith('manifest-'));
  const manifest = manifestAsset
    ? JSON.parse((await download(manifestAsset.browser_download_url, join(dir, manifestAsset.name))).toString('utf8'))
    : null;
  const bySha = new Map((manifest?.assets ?? []).map((a) => [a.name, a.sha256]));
  for (const asset of release.assets) {
    if (asset.name === manifestAsset?.name) continue;
    const buf = await download(asset.browser_download_url, join(dir, asset.name));
    if (verify && bySha.has(asset.name)) {
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

  const latest = await getJson(`${RAW}/index/latest.json`);
  const releases = await getJson(`${RAW}/index/releases.json`);
  const tags = releases.map((r) => r.tag);

  let wanted;
  if (snapshotOnly) {
    wanted = [latest.snapshot_tag];
  } else if (typeof since === 'string') {
    const i = tags.indexOf(since);
    if (i < 0) throw new Error(`--since ${since}: not found in index/releases.json`);
    wanted = tags.slice(i + 1);
  } else {
    // newest snapshot + everything after it (releases.json is in publish order)
    const i = tags.indexOf(latest.snapshot_tag);
    wanted = i < 0 ? tags : tags.slice(i);
  }
  wanted = wanted.filter(Boolean);

  console.log(`fetching ${wanted.length} release(s) → ${outRoot}${verify ? ' (verifying sha256)' : ''}`);
  let runs = 0;
  for (const tag of wanted) {
    const m = await fetchRelease(tag, outRoot, verify);
    runs += m?.run_ids?.length ?? 0;
  }
  console.log(`done: ${wanted.length} releases, ~${runs} runs. schema_version ${latest.schema_version}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
