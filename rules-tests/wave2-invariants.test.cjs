/**
 * Wave 2 invariants (2026-08-15 audit) — pure unit tests against functions/lib.
 *
 *   • isBlockedHost / assertPublicUrl (P1-03 SSRF): literal private/metadata
 *     hosts and non-http schemes are rejected without any DNS involved.
 *     (Resolved-address cases need live DNS and are covered by code review —
 *     lookup() rejection is the same isBlockedHost predicate tested here.)
 *   • artworkDeliverable (P1-18): legacy originals outside the shop partition
 *     are NOT deliverable; gated print files and in-partition legacy pass.
 *   • signedUrlFor prefix guard: a path outside allowedPrefix returns null
 *     BEFORE any storage/signing work.
 *
 * RUN: node rules-tests/wave2-invariants.test.cjs   (needs functions/lib built)
 */

const admin = require('../functions/node_modules/firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-rules-test' });

const path = require('path');
const { isBlockedHost, assertPublicUrl } =
  require(path.join(__dirname, '..', 'functions', 'lib', 'email-orchestrator', 'functions', 'migrationShared.js'));
const { artworkDeliverable, signedUrlFor } =
  require(path.join(__dirname, '..', 'functions', 'lib', 'print', 'printProjection.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const rejects = async (p, m) => {
  try { await p; fail++; console.log('  ❌', m, '— expected a throw'); }
  catch { pass++; console.log('  ✅', m); }
};

(async () => {
  console.log('\n=== P1-03: SSRF host blocking (literal, no DNS) ===');
  ok(isBlockedHost('localhost') === true, 'localhost blocked');
  ok(isBlockedHost('169.254.169.254') === true, 'cloud metadata IP blocked');
  ok(isBlockedHost('10.1.2.3') === true, 'RFC1918 10/8 blocked');
  ok(isBlockedHost('172.20.0.1') === true, 'RFC1918 172.16/12 blocked');
  ok(isBlockedHost('192.168.1.1') === true, 'RFC1918 192.168/16 blocked');
  ok(isBlockedHost('127.0.0.1') === true, 'loopback blocked');
  ok(isBlockedHost('100.90.1.1') === true, 'CGNAT 100.64/10 blocked');
  ok(isBlockedHost('224.0.0.1') === true, 'multicast blocked');
  ok(isBlockedHost('::1') === true, 'IPv6 loopback blocked');
  ok(isBlockedHost('fd00::1') === true, 'IPv6 ULA blocked');
  ok(isBlockedHost('metadata.internal') === true, '.internal TLD blocked');
  ok(isBlockedHost('printer.local') === true, '.local TLD blocked');
  ok(isBlockedHost('shop.example.com') === false, 'ordinary public hostname passes the literal check');
  await rejects(assertPublicUrl('http://169.254.169.254/computeMetadata/v1/'), 'assertPublicUrl rejects metadata IP URL');
  await rejects(assertPublicUrl('http://localhost:8080/x'), 'assertPublicUrl rejects localhost URL');
  await rejects(assertPublicUrl('ftp://example.com/x'), 'assertPublicUrl rejects non-http scheme');
  await rejects(assertPublicUrl('file:///etc/passwd'), 'assertPublicUrl rejects file: scheme');
  await rejects(assertPublicUrl('not a url'), 'assertPublicUrl rejects malformed URL');

  console.log('\n=== P1-18: artworkDeliverable partition guard ===');
  ok(artworkDeliverable({ printStoragePath: 'pod-artwork/shopA/print/a.png', status: 'ready', validation: { gate: 'PASS' } }, 'shopA').deliverable === true,
    'gated print file in own partition → deliverable');
  ok(artworkDeliverable({ printStoragePath: 'pod-artwork/shopB/print/a.png', status: 'ready', validation: { gate: 'PASS' } }, 'shopA').deliverable === false,
    'print file in ANOTHER shop\'s partition → NOT deliverable');
  ok(artworkDeliverable({ status: 'rejected' }, 'shopA').deliverable === false,
    'status doc without print file → NOT deliverable');
  ok(artworkDeliverable({ originalStoragePath: 'pod-artwork/shopA/originals/x.tiff' }, 'shopA').deliverable === true,
    'legacy doc (no status) with in-partition original → deliverable');
  ok(artworkDeliverable({ originalStoragePath: 'pod-artwork/shopB/originals/x.tiff' }, 'shopA').deliverable === false,
    'legacy doc with FOREIGN-partition original → NOT deliverable (fail closed)');
  ok(artworkDeliverable({ originalUrl: 'https://evil.example/x.png' }, 'shopA').deliverable === false,
    'legacy doc with URL but NO storage path → NOT deliverable (fail closed)');

  console.log('\n=== signedUrlFor: prefix + fail-closed guards ===');
  ok((await signedUrlFor('', 'https://evil.example/x')) === null,
    'missing storage path → null (never the stored fallback URL)');
  ok((await signedUrlFor('pod-artwork/shopB/print/a.png', null, 'pod-artwork/shopA/')) === null,
    'path outside allowedPrefix → null before any signing');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
