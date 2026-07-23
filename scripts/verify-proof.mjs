#!/usr/bin/env node
// Offline verification of the TEE proof bundles in proofs-*.jsonl.gz shards.
// Node stdlib only, no network. For each run it independently reproduces, as
// the pass/fail gate:
//
//   1. manifest integrity   sha256(manifestCanonical) === manifestHash
//   2. signature coverage    manifestHash is embedded in the signed payload
//   3. key binding           sha256(public key SPKI) === the declared keyId
//   4. Ed25519 signature     valid over "<version>\n<signedPayloadCanonical>"
//   5. SEV-SNP cert chain    VCEK ← SEV-Milan(ASK) ← ARK-Milan, ARK pinned to AMD's root
//
// Together these prove the attestation certs are genuine AMD, the signing key is
// the one the bundle names, the manifest wasn't altered post-hoc, and the whole
// proof carries a valid signature from that key.
//
//   node scripts/verify-proof.mjs data/**/proofs-*.jsonl.gz
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash, createPublicKey, verify as edVerify, X509Certificate } from 'node:crypto';

// AMD ARK-Milan root — the anchor of the SEV-SNP chain. Pinned by sha256 DER
// fingerprint so verification needs no network and no bundled cert file.
const ARK_MILAN_SHA256 =
  '69:D0:63:B4:53:44:D2:6A:2E:94:E1:F4:21:0D:E4:9E:F5:55:30:82:87:D4:C1:74:44:5C:95:63:9A:54:0B:CD';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parsePems(text) {
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
    .map((pem) => new X509Certificate(pem));
}

function verifyBundle(bundle) {
  const errs = [];
  const { manifestCanonical, manifestHash, signature, attestation, version } = bundle;

  // 1. manifest integrity
  if (sha256Hex(Buffer.from(manifestCanonical, 'utf8')) !== manifestHash) {
    errs.push('manifest hash mismatch');
  }
  // 2. the signed payload actually commits to this manifest
  if (!signature?.signedPayloadCanonical?.includes(manifestHash)) {
    errs.push('signed payload does not embed manifestHash');
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
  } catch (e) {
    errs.push(`cert chain check failed: ${e.message}`);
  }
  return errs;
}

function* readShard(path) {
  const buf = path.endsWith('.gz') ? gunzipSync(readFileSync(path)) : readFileSync(path);
  for (const line of buf.toString('utf8').split('\n')) {
    if (line.trim()) yield JSON.parse(line);
  }
}

function main() {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('usage: node scripts/verify-proof.mjs proofs-*.jsonl.gz');
    process.exit(2);
  }
  let ok = 0;
  let bad = 0;
  for (const path of paths) {
    for (const row of readShard(path)) {
      const bundle = row.proof_bundle ?? row;
      const errs = verifyBundle(bundle);
      if (errs.length === 0) {
        ok += 1;
      } else {
        bad += 1;
        console.error(`✗ ${row.run_id ?? '?'}: ${errs.join('; ')}`);
      }
    }
  }
  console.log(`verified ${ok} bundle(s), ${bad} failed.`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
