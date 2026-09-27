/**
 * scripts/cf-port/migrate/test/fixtures.mjs — helpers to build a fixture
 * export bundle using the (finished, reviewed) export tool's OWN writer
 * functions, so the format is exactly right. All data invented, per the
 * hard rule: shops called "Test Shop A"/"Test Shop B", people called
 * "Test Admin One" etc., addresses at example.com.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runExport } from '../export.mjs';
import { FakeFirestore, FakeAuth, FakeFieldPath } from './fake-firestore.mjs';

export function tmpDir(prefix = 'cfport-migrate-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function rmDir(dir) {
  rmSync(dir, { force: true, recursive: true });
}

/**
 * Builds a minimal-but-representative fixture bundle covering every row this
 * checkpoint's importer handles, plus the awkward cases the manifest names:
 * mixed timestamp shapes on shops, empty strings, a shop with no features
 * field at all, a disabled shop, an unpublished shop.
 */
export async function buildFixtureBundle(outDir, overrides = {}) {
  const schema = {
    auditLogs: {
      log1: { data: { action: 'product.takedown', actorUid: 'admin1', createdAt: '2026-01-05T00:00:00.000Z', reason: 'test reason', shopId: 'test-shop-a', targetId: 'prod-1' } },
    },
    printerCatalog: {
      snapwear: {
        data: {
          models: { '64000': { back: { h: 400, w: 300 }, front: { h: 400, w: 300 } } },
          skus: { 'HOODIE-BLK-L': { garment: 'hoodie', model: '64000' }, 'TEE-BLK-M': { garment: 'tee', model: '64000' } },
          source: { generatedAt: '2026-09-01T00:00:00.000Z', generator: 'fixture' },
          pricingBasis: { buffer: 0.03, eurSek: 11.2 },
        },
      },
    },
    printers: {
      snapwear: {
        data: {
          active: true,
          garments: ['tee', 'hoodie'],
          name: 'Snapwear (Test)',
          pricing: { blankCostSek: { hoodie: 130, tee: 45 }, printCostSek: { back: 37, front: 37, pocket: 37 } },
          printAreasMm: { hoodie: { front: { h: 400, w: 300 } }, tee: { back: { h: 400, w: 300 }, front: { h: 400, w: 300 } } },
          provisionalAreas: [],
          shippingSek: 25,
          type: 'api',
        },
      },
      o7diaDJ01tRoBMs8d5OK9bPunMg1: { data: { active: false, name: 'Legacy uid printer', type: 'manual' } },
    },
    settings: {
      contentScreening: {
        data: {
          blocklist: [
            { kind: 'brand', note: '', term: 'nike' },
            { kind: 'band', note: 'Swedish band', term: 'Kent' },
            { kind: 'other', note: 'trademark sign', term: '™' },
            { kind: 'other', note: 'blank — normalises to nothing', term: '   ' },
          ],
          hardBlock: false,
          reviewFirstProducts: 2,
        },
      },
      platform: { data: {} },
      podProfiles: {
        data: {
          profiles: [{ accepted_formats: [{ ext: 'png' }, { ext: 'jpg' }], id: 'apparel_dtg', label: 'Textil (DTG)', max_file_mb: 50, min_dpi: 300, print_area_mm: { h: 400, w: 300 } }],
          version: 3,
        },
      },
      printRouting: { data: { byGarment: { hoodie: 'snapwear', tee: 'snapwear' }, defaultPrinterUid: 'snapwear' } },
    },
    shops: {
      'test-shop-a': {
        data: {
          createdAt: { __t: 'ts', iso: '2025-01-01T00:00:00.000Z', ns: 0, s: 1735689600 },
          features: { contentStudio: false, pod: true },
          name: 'Test Shop A',
          payments: { chargesEnabled: true, connectEnabled: true, detailsSubmitted: true, payoutDelayDays: 7, payoutsEnabled: true, stripeAccountId: 'acct_live_test_a' },
          published: true,
          status: 'active',
          storeIdentity: {
            emailLogoUrl: '',
            faviconUrl: '',
            heroImageUrl: '',
            logoUrl: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/branding%2Ftest-shop-a%2Flogo.png?alt=media&token=abc',
            menu: [{ label: 'Alla produkter', target: 'all', type: 'category' }],
            returnAddress: 'Test Shop A, Testgatan 1, 123 45 Teststad',
            sellerType: 'company',
            supportEmail: 'owner-a@example.com',
            trustpilot: { domain: '', email: 'reviews-a@example.com' },
            vatNumber: 'SE1234567890',
            vatRegistered: true,
          },
          updatedAt: '2026-01-01T00:00:00.000Z', // mixed timestamp shape: ISO STRING, not Timestamp (manifest §56 note)
        },
        subcollections: {
          legalAcceptances: {
            accept1: {
              data: {
                acceptedAt: { __t: 'ts', iso: '2025-01-02T00:00:00.000Z', ns: 0, s: 1735776000 },
                acceptedAtIso: '2025-01-02T00:00:00.000Z',
                custom: { angerratt: false, integritetspolicy: false, kopvillkor: false },
                email: 'tenantadmin1@example.com',
                pod: true,
                shopId: 'test-shop-a',
                templateVersion: '1',
                texts: { angerratt: '<p>Ånger</p>', integritetspolicy: '<p>Policy</p>', kopvillkor: '<p>Villkor</p>' },
                type: 'legalPages',
                uid: 'tenantadmin1',
                userAgent: 'test-agent',
              },
            },
          },
        },
      },
      'test-shop-b': {
        data: {
          // no features field at all (an awkward case the manifest names)
          name: 'Test Shop B',
          published: false, // unpublished shop
          status: 'disabled', // disabled shop
          storeIdentity: { shopName: 'Test Shop B', supportEmail: '' }, // empty string field
        },
      },
      robowatz: { data: { name: 'Robowatz', published: false, status: 'active' } }, // D21 archived
    },
    users: {
      admin1: { data: { active: true, contactPerson: 'Test Admin One', email: 'admin1@example.com', isActive: true, platform: true, role: 'admin' } },
      admin2: { data: { active: true, contactPerson: 'Test Admin Two', email: 'admin2@example.com', isActive: true, platform: true, role: 'admin' } },
      disabledadmin: { data: { active: false, contactPerson: 'Disabled Admin', email: 'disabled@example.com', isActive: true, platform: false, role: 'admin', shopId: 'test-shop-b' } },
      printshopuser: { data: { active: true, email: 'print1@example.com', role: 'print_shop' } },
      tenantadmin1: { data: { active: true, contactPerson: 'Shop Admin', email: 'tenantadmin1@example.com', isActive: true, platform: false, role: 'admin', shopId: 'test-shop-a' } },
    },
  };

  if (overrides.schemaPatch) overrides.schemaPatch(schema);

  const authUsers = [
    { disabled: false, displayName: 'Test Admin One', email: 'admin1@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'admin1' },
    { disabled: false, displayName: 'Test Admin Two', email: 'admin2@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'admin2' },
    { disabled: false, displayName: 'Shop Admin', email: 'tenantadmin1@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'tenantadmin1' },
    { disabled: false, displayName: null, email: 'print1@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'printshopuser' },
    { disabled: true, displayName: 'Disabled Admin', email: 'disabled@example.com', emailVerified: true, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'disabledadmin' },
    { disabled: false, displayName: null, email: 'authonly1@example.com', emailVerified: false, metadata: { creationTime: '2025-01-01T00:00:00.000Z', lastSignInTime: null }, providerData: [], uid: 'authonly1' },
  ];

  const db = new FakeFirestore(schema);
  const auth = new FakeAuth(overrides.authUsers ?? authUsers);

  const originalLog = console.log;
  if (!overrides.verbose) console.log = () => {};
  try {
    await runExport({
      apply: true,
      auth,
      db,
      FieldPath: FakeFieldPath,
      git: () => ({ dirty: false, sha: 'fixture' }),
      now: () => new Date(overrides.exportedAt ?? '2026-09-27T00:00:00.000Z'),
      only: null,
      outDir,
    });
  } finally {
    console.log = originalLog;
  }
}

export const FIXED_EMAIL_MAP = {
  'admin1@example.com': 'admin1-test@example.com',
  'admin2@example.com': 'admin2-test@example.com',
  'disabled@example.com': 'disabled-test@example.com',
  'owner-a@example.com': 'owner-a-test@example.com',
  'print1@example.com': 'print1-test@example.com',
  'reviews-a@example.com': 'reviews-a-test@example.com',
  'tenantadmin1@example.com': 'tenantadmin1-test@example.com',
};

export const FIXED_NOW = () => new Date('2026-09-27T12:00:00.000Z');
