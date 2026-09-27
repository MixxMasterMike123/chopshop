import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinUsersToAuth, transformUser, classifyUser, hasActivePlatformAdminAfterImport, ARCHIVED_USER_ROLES } from '../lib/transform-users.mjs';
import { normalizeEmailMap } from '../lib/scrub.mjs';

const emailMap = normalizeEmailMap({
  'admin1@example.com': 'admin1-test@example.com',
  'print1@example.com': 'print1-test@example.com',
  'tenant1@example.com': 'tenant1-test@example.com',
});

test('classifyUser: platform admin (role=admin, platform=true, no shopId)', () => {
  const c = classifyUser({ data: { platform: true, role: 'admin' } });
  assert.deepEqual(c, { accountType: 'platform_admin', membership: null });
});

test('classifyUser: tenant admin (role=admin, platform!=true, shopId set)', () => {
  const c = classifyUser({ data: { platform: false, role: 'admin', shopId: 'shop-a' } });
  assert.deepEqual(c, { accountType: 'tenant_admin', membership: { role: 'admin', tenantId: 'shop-a' } });
});

test('classifyUser: D12 print_shop is not carried', () => {
  assert.equal(classifyUser({ data: { role: 'print_shop' } }), null);
  assert.ok(ARCHIVED_USER_ROLES.has('print_shop'));
});

test('classifyUser: anything else is not carried', () => {
  assert.equal(classifyUser({ data: { role: 'customer' } }), null);
  assert.equal(classifyUser({ data: {} }), null);
});

test('joinUsersToAuth: counts Auth-only users and reports email mismatches', () => {
  const userDocs = [{ data: { email: 'a@example.com' }, id: 'uidA' }];
  const authUsers = [
    { email: 'a@example.com', uid: 'uidA' },
    { email: 'extra@example.com', uid: 'uidExtra' },
  ];
  const { authOnlyCount, joined, mismatchedEmails } = joinUsersToAuth(userDocs, authUsers);
  assert.equal(authOnlyCount, 1);
  assert.equal(joined.length, 1);
  assert.deepEqual(mismatchedEmails, []);
});

test('joinUsersToAuth: reports a mismatch between Auth email and users-doc email', () => {
  const userDocs = [{ data: { email: 'doc@example.com' }, id: 'uidA' }];
  const authUsers = [{ email: 'auth@example.com', uid: 'uidA' }];
  const { mismatchedEmails } = joinUsersToAuth(userDocs, authUsers);
  assert.equal(mismatchedEmails.length, 1);
  assert.equal(mismatchedEmails[0].uid, 'uidA');
});

test('transformUser: a platform admin is carried, gets a user+account+identity_access row, no membership', () => {
  const result = transformUser({
    authUser: { disabled: false, email: 'admin1@example.com', emailVerified: true },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
    targetState: null,
    uid: 'admin1',
    userDoc: { data: { active: true, contactPerson: 'Admin One', email: 'admin1@example.com', isActive: true, platform: true, role: 'admin' } },
  });
  assert.equal(result.carried, true);
  assert.equal(result.report.accountType, 'platform_admin');
  const tables = result.rows.map((r) => r.table);
  assert.ok(tables.includes('user'));
  assert.ok(tables.includes('account'));
  assert.ok(tables.includes('identity_access'));
  assert.ok(!tables.includes('tenant_memberships'));
  assert.ok(tables.includes('legacy_id_map'));
});

test('transformUser: password is always NULL', () => {
  const result = transformUser({
    authUser: { disabled: false, email: 'admin1@example.com', emailVerified: true },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
    targetState: null,
    uid: 'admin1',
    userDoc: { data: { active: true, email: 'admin1@example.com', platform: true, role: 'admin' } },
  });
  const accountStmt = result.rows.find((r) => r.table === 'account').statement;
  // The password column specifically is NULL (not merely "some column"):
  // column order is (id, accountId, providerId, userId, accessToken, refreshToken,
  // idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt).
  const columnsMatch = accountStmt.match(/INTO "account" \((.*)\) VALUES/)[1];
  const columns = columnsMatch.split(', ').map((c) => c.replaceAll('"', ''));
  const valuesMatch = accountStmt.match(/VALUES \((.*)\);/)[1];
  const values = valuesMatch.split(', ');
  const passwordIndex = columns.indexOf('password');
  assert.ok(passwordIndex >= 0, 'expected a password column');
  assert.equal(values[passwordIndex], 'NULL', 'the password column must be NULL');
});

test('transformUser: D12 print_shop is not carried at all', () => {
  const result = transformUser({
    authUser: { disabled: false, email: 'print1@example.com', emailVerified: true },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
    targetState: null,
    uid: 'printuser',
    userDoc: { data: { email: 'print1@example.com', role: 'print_shop' } },
  });
  assert.equal(result.carried, false);
  assert.deepEqual(result.rows, []);
});

test('transformUser: suspension when active=false, isActive=false or Auth disabled', () => {
  for (const [authDisabled, active, isActive] of [[true, true, true], [false, false, true], [false, true, false]]) {
    const result = transformUser({
      authUser: { disabled: authDisabled, email: 'tenant1@example.com', emailVerified: true },
      emailMap,
      env: 'staging',
      nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
      scrubUnmapped: false,
      targetState: null,
      uid: 'tenant1',
      userDoc: { data: { active, email: 'tenant1@example.com', isActive, platform: false, role: 'admin', shopId: 'shop-a' } },
    });
    assert.equal(result.report.suspended, true, `expected suspended for disabled=${authDisabled} active=${active} isActive=${isActive}`);
    const identityStmt = result.rows.find((r) => r.table === 'identity_access').statement;
    assert.match(identityStmt, /'suspended'/);
  }
});

test('transformUser: deterministic new user id — same uid, same env -> same id across two independent calls', () => {
  const args = {
    authUser: { disabled: false, email: 'admin1@example.com', emailVerified: true },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
    targetState: null,
    uid: 'admin1',
    userDoc: { data: { active: true, email: 'admin1@example.com', platform: true, role: 'admin' } },
  };
  const a = transformUser(args);
  const b = transformUser(args);
  assert.equal(a.report.newUserId, b.report.newUserId);
});

test('transformUser: D59 adoption — an existing target email adopts the existing id, no fresh user/account rows', () => {
  const result = transformUser({
    authUser: { disabled: false, email: 'admin1@example.com', emailVerified: true },
    emailMap,
    env: 'staging',
    nowMillis: Date.parse('2026-01-01T00:00:00.000Z'),
    scrubUnmapped: false,
    targetState: { emails: new Map([['admin1-test@example.com', 'existing-id-123']]) },
    uid: 'admin1',
    userDoc: { data: { active: true, email: 'admin1@example.com', platform: true, role: 'admin' } },
  });
  assert.equal(result.report.adopted, true);
  assert.equal(result.report.newUserId, 'existing-id-123');
  const tables = result.rows.map((r) => r.table);
  assert.ok(!tables.includes('user'));
  assert.ok(!tables.includes('account'));
  assert.ok(tables.includes('identity_access')); // still writes identity/membership against the adopted id
});

test('hasActivePlatformAdminAfterImport: true when a carried user is an active platform admin', () => {
  const transformed = [{ carried: true, report: { accountType: 'platform_admin', suspended: false } }];
  assert.equal(hasActivePlatformAdminAfterImport(transformed, 0), true);
});

test('hasActivePlatformAdminAfterImport: false when the only platform admin is suspended and target has none', () => {
  const transformed = [{ carried: true, report: { accountType: 'platform_admin', suspended: true } }];
  assert.equal(hasActivePlatformAdminAfterImport(transformed, 0), false);
});

test('hasActivePlatformAdminAfterImport: true when the target already has an active platform admin', () => {
  assert.equal(hasActivePlatformAdminAfterImport([], 1), true);
});
