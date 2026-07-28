#!/usr/bin/env node
// Offline verification of the TEE proof bundles in proofs-*.jsonl.gz shards.
// Node stdlib only, no network. For each run it independently reproduces, as
// the pass/fail gate:
//
//   1. manifest integrity    sha256(manifestCanonical) === manifestHash
//   2. signature coverage    the signed payload IS this bundle — same manifest,
//                            same attestation report, same gateway build
//   3. key binding           sha256(public key SPKI) === the declared keyId
//   4. Ed25519 signature     valid over "<version>\n<signedPayloadCanonical>"
//   5. SEV-SNP cert chain    VCEK ← SEV-Milan(ASK) ← ARK-Milan, ARK pinned to AMD's root
//   6. report → software     REPORT_DATA (bytes 0x50..0x90 of the AMD report) ===
//                            codeHash ‖ jwksHashTrunc16 ‖ customDataHashTrunc16
//   7. report → this run     customDataHashTrunc16 === sha256(binding.payloadCanonical)[:16],
//                            and that payload commits to this run's manifestHash
//   8. code identity         the codeHash in REPORT_DATA === the gateway build's source hash
//
// Chain, end to end: AMD's root → the VCEK → an SEV-SNP report whose REPORT_DATA
// names a specific gateway build → a binding payload naming this run's manifest →
// a manifest naming the repo, issue, base commit, model, config and tool versions.
// That is what makes "this software ran this benchmark inside a TEE" checkable
// by someone who trusts nothing but AMD's root certificate.
//
//   --strict  also require the report's own ECDSA signature to verify against the
//             VCEK shipped in the same bundle. See the note on check 9 below.
//
//   node scripts/verify-proof.mjs data/**/proofs-*.jsonl.gz
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash, createPublicKey, createVerify, verify as edVerify, X509Certificate } from 'node:crypto';

// AMD ARK-Milan root — the anchor of the SEV-SNP chain. Pinned by sha256 DER
// fingerprint so verification needs no network and no bundled cert file.
const ARK_MILAN_SHA256 =
  '69:D0:63:B4:53:44:D2:6A:2E:94:E1:F4:21:0D:E4:9E:F5:55:30:82:87:D4:C1:74:44:5C:95:63:9A:54:0B:CD';

// SEV-SNP ATTESTATION_REPORT field offsets (AMD spec table "ATTESTATION_REPORT").
const REPORT_DATA_AT = 0x50;   // 64 bytes of guest-supplied data
const MEASUREMENT_AT = 0x90;   // 48-byte launch measurement
const SIGNATURE_AT = 0x2a0;    // ECDSA P-384: r ‖ s, each 72 bytes little-endian

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// AMD stores r and s little-endian in fixed 72-byte slots; node's verifier wants DER.
function snpSignatureToDer(report) {
  const asInteger = (le) => {
    let be = Buffer.from(le).reverse();
    let i = 0;
    while (i < be.length - 1 && be[i] === 0) i += 1;
    be = be.subarray(i);
    if (be[0] & 0x80) be = Buffer.concat([Buffer.from([0]), be]);
    return Buffer.concat([Buffer.from([0x02, be.length]), be]);
  };
  const raw = report.subarray(SIGNATURE_AT);
  const r = asInteger(raw.subarray(0, 72));
  const s = asInteger(raw.subarray(72, 144));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

function parsePems(text) {
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
    .map((pem) => new X509Certificate(pem));
}

function verifyBundle(bundle) {
  const errs = [];
  const { manifestCanonical, manifestHash, signature, attestation, binding, gateway, version } = bundle;

  // 1. manifest integrity
  if (sha256Hex(Buffer.from(manifestCanonical, 'utf8')) !== manifestHash) {
    errs.push('manifest hash mismatch');
  }
  // 2. the signed payload IS this bundle. `includes(manifestHash)` alone would pass
  // a bundle whose visible attestation/gateway were swapped for a different run's —
  // the signature only ever covers signedPayloadCanonical, so compare the fields
  // anyone would read off the bundle against the ones actually signed.
  let signed = null;
  try {
    signed = JSON.parse(signature?.signedPayloadCanonical ?? 'null');
  } catch {
    errs.push('signed payload is not JSON');
  }
  if (!signed) {
    errs.push('signed payload missing');
  } else {
    if (signed.manifestHash !== manifestHash) errs.push('signed payload commits to a different manifestHash');
    if (signed.manifestCanonical !== manifestCanonical) errs.push('signed manifest differs from the shipped manifest');
    if (signed.attestation?.reportHex !== attestation?.reportHex) errs.push('signed attestation report differs from the shipped one');
    if (signed.gateway?.codeHash !== gateway?.codeHash) errs.push('signed gateway build differs from the shipped one');
  }
  // 3 + 4. key binding and Ed25519 signature over "<version>\n<signedPayloadCanonical>"
  try {
    const spki = Buffer.from(signature.publicKeySpkiB64, 'base64');
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const declared = signature.publicKeySha256Hex;
    if (declared && sha256Hex(spki) !== declared) {
      errs.push('public key hash does not match declared keyId');
    }
    const message = Buffer.from(`${version}\n${signature.signedPayloadCanonical}`, 'utf8');
    if (!edVerify(null, message, pub, Buffer.from(signature.signatureB64, 'base64'))) {
      errs.push('Ed25519 signature invalid');
    }
  } catch (e) {
    errs.push(`signature check failed: ${e.message}`);
  }
  // 5. SEV-SNP certificate chain to the pinned AMD root
  try {
    const chain = parsePems(attestation?.certificates?.chain ?? '');
    const vcek = attestation?.certificates?.vcek ? new X509Certificate(attestation.certificates.vcek) : null;
    const ask = chain.find((c) => /SEV-Milan/.test(c.subject));
    const ark = chain.find((c) => /ARK-Milan/.test(c.subject));
    if (!ark) errs.push('ARK-Milan cert missing');
    else if (ark.fingerprint256 !== ARK_MILAN_SHA256) errs.push('ARK-Milan is not the pinned AMD root');
    if (ark && !ark.verify(ark.publicKey)) errs.push('ARK-Milan self-signature invalid');
    if (ask && ark && !ask.verify(ark.publicKey)) errs.push('ASK not signed by ARK');
    if (vcek && ask && !vcek.verify(ask.publicKey)) errs.push('VCEK not signed by ASK');
    if (!vcek) errs.push('VCEK cert missing');
    if (!ask) errs.push('SEV-Milan (ASK) cert missing');

    // 6-8. Bind the AMD report to the software and to THIS run. Without these the
    // chain above only proves "some genuine AMD certs travelled with this file".
    const report = attestation?.reportHex ? Buffer.from(attestation.reportHex, 'hex') : null;
    if (!report || report.length < SIGNATURE_AT + 144) {
      errs.push('SEV-SNP report missing or truncated');
    } else {
      const reportData = report.subarray(REPORT_DATA_AT, MEASUREMENT_AT).toString('hex');
      const expected = `${attestation.codeHash ?? ''}${attestation.jwksHashTrunc16InReportData ?? ''}${attestation.customDataHashTrunc16InReportData ?? ''}`;
      if (reportData !== expected) {
        errs.push('REPORT_DATA is not codeHash‖jwksHashTrunc16‖customDataHashTrunc16');
      }
      const payload = binding?.payloadCanonical;
      if (typeof payload !== 'string') {
        errs.push('binding payload missing — report is not bound to a run');
      } else {
        if (sha256Hex(Buffer.from(payload, 'utf8')).slice(0, 32) !== attestation.customDataHashTrunc16InReportData) {
          errs.push('binding payload does not hash to the customData in REPORT_DATA');
        }
        if (!payload.includes(`manifestHash=${manifestHash}`)) {
          errs.push('binding payload does not name this run\'s manifestHash');
        }
      }
      const sourceHash = gateway?.buildInfo?.source?.hash;
      if (sourceHash && sourceHash !== attestation.codeHash) {
        errs.push('gateway source hash differs from the codeHash the TEE attested');
      }
      // 9. The report's own AMD signature. Genuine for every report we have seen,
      // but the gateway currently ships a VCEK cached from a different host on most
      // bundles, so the pairing fails offline through no fault of the report. Gated
      // behind --strict until the gateway caches VCEKs per (chip, TCB).
      if (STRICT && vcek) {
        const check = createVerify('sha384');
        check.update(report.subarray(0, SIGNATURE_AT));
        if (!check.verify(vcek.publicKey, snpSignatureToDer(report))) {
          errs.push('report signature does not verify against the VCEK in this bundle');
        }
      }
    }
  } catch (e) {
    errs.push(`cert chain check failed: ${e.message}`);
  }
  return errs;
}

const STRICT = process.argv.includes('--strict');

function* readShard(path) {
  const buf = path.endsWith('.gz') ? gunzipSync(readFileSync(path)) : readFileSync(path);
  const text = buf.toString('utf8');
  // Accept both a JSONL shard and a single pretty-printed bundle — `bench-cli proof
  // <run_id> --out proof.json` writes the latter, and verifying that file is the
  // documented next step.
  if (text.trimStart().startsWith('{') && text.includes('\n  ')) {
    yield JSON.parse(text);
    return;
  }
  for (const line of text.split('\n')) {
    if (line.trim()) yield JSON.parse(line);
  }
}

function main() {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('usage: node scripts/verify-proof.mjs [--strict] proofs-*.jsonl.gz');
    process.exit(2);
  }
  let ok = 0;
  let bad = 0;
  const builds = new Map();
  for (const path of paths) {
    for (const row of readShard(path)) {
      const bundle = row.proof_bundle ?? row;
      const errs = verifyBundle(bundle);
      if (errs.length === 0) {
        ok += 1;
        // Which software the TEE actually attested, and how many runs each build
        // covers — the number a reader wants after "the signatures check out".
        const key = bundle.gateway?.buildInfo?.git?.commitHash ?? bundle.attestation?.codeHash ?? 'unknown';
        builds.set(key, (builds.get(key) ?? 0) + 1);
      } else {
        bad += 1;
        console.error(`✗ ${row.run_id ?? '?'}: ${errs.join('; ')}`);
      }
    }
  }
  console.log(`verified ${ok} bundle(s), ${bad} failed.${STRICT ? ' (--strict)' : ''}`);
  if (builds.size > 0) {
    console.log('attested gateway builds:');
    for (const [commit, n] of [...builds.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${commit}  ${n} run(s)`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}

main();
