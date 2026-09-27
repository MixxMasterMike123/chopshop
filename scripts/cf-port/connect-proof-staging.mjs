#!/usr/bin/env node
/**
 * scripts/cf-port/connect-proof-staging.mjs — the Connect v1 proof on STAGING
 * (docs/cf-port/CP3_F_REPORT.md, "Extended staging proof list"), with a tenant of its own:
 * the connected account is created BY THE WORKER, never by this script.
 *
 *   CHOPSHOP_API_URL=… CHOPSHOP_PLATFORM_EMAIL=… CHOPSHOP_PLATFORM_PASSWORD=… \
 *   STRIPE_SECRET_KEY=sk_test_… node scripts/cf-port/connect-proof-staging.mjs
 *
 * It refuses any API origin but the pinned staging one and any Stripe key that is not a test
 * key of the pinned sandbox account. Stripe is only READ here (the account the Worker made,
 * the list of accounts). Every line printed is a fact to compare with the expectation beside
 * it; the onboarding link itself is never printed. Re-running reuses the tenant and its
 * account. The tenant is a known test tenant of verify.mjs (KNOWN_NON_MANIFEST_TENANTS).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PINNED = JSON.parse(readFileSync(path.join(ROOT, "cloudflare/pinned.staging.json"), "utf8"));

function die(message) {
  console.error(`PROOF REFUSED: ${message}`);
  process.exit(1);
}
for (const name of ["CHOPSHOP_API_URL", "CHOPSHOP_PLATFORM_EMAIL", "CHOPSHOP_PLATFORM_PASSWORD", "STRIPE_SECRET_KEY"]) {
  if ((process.env[name] ?? "").trim() === "") die(`${name} is not set`);
}
if (new URL(process.env.CHOPSHOP_API_URL).origin !== PINNED.origins.api) {
  die(`CHOPSHOP_API_URL is not the pinned STAGING api origin ${PINNED.origins.api}`);
}
const API = PINNED.origins.api;
const TENANT = 'slice-connect-20260927';
const HOST = `${TENANT}.import.invalid`;
const KEY = process.env.STRIPE_SECRET_KEY;
if (!/^(sk|rk)_test_/.test(KEY)) die('STRIPE_SECRET_KEY is not a test-mode key');
const say = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
let cookie = null;
async function api(method, route, { json, shop = false } = {}) {
  const headers = { origin: API, cookie };
  if (shop) headers['x-shop-id'] = TENANT;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${API}${route}`, { body: json === undefined ? undefined : JSON.stringify(json), headers, method, redirect: 'manual' });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { body, status: r.status, text: text.slice(0, 200) };
}
async function stripe(route) {
  const r = await fetch(`https://api.stripe.com${route}`, { headers: { authorization: `Bearer ${KEY}` } });
  return r.json();
}
const signIn = await fetch(`${API}/api/auth/sign-in/email`, { body: JSON.stringify({ email: process.env.CHOPSHOP_PLATFORM_EMAIL, password: process.env.CHOPSHOP_PLATFORM_PASSWORD }), headers: { 'content-type': 'application/json', origin: API }, method: 'POST' });
cookie = signIn.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
if (signIn.status !== 200) die(`platform sign-in failed: HTTP ${signIn.status}`);
const platformAccount = await stripe('/v1/account');
if (platformAccount.id !== PINNED.stripeAccountId) die(`the Stripe key belongs to ${platformAccount.id}, not the pinned sandbox platform`);
say('sign-in', signIn.status);

const created = await api('POST', '/v1/platform/tenants', { json: { hostname: HOST, shopName: 'Slice Connect Proof', tenantId: TENANT } });
say('create tenant', `${created.status} ${created.status >= 400 && created.status !== 409 ? created.text : ''}`);
if (![201, 409].includes(created.status)) process.exit(1);
const grant = await api('POST', `/v1/platform/tenants/${TENANT}/acting-as`, { json: { reason: 'CP3-F Connect v1 proof' } });
say('acting-as', grant.status);

const P = `/v1/platform/tenants/${TENANT}/connect`;
let view = (await api('GET', P)).body.connect;
say('before: enabled / account', `${view.enabled} / ${view.accountId}`);
if (!view.enabled) {
  const closed = await api('POST', '/v1/admin/payments/connect/account', { shop: true });
  say('create while NOT enabled', `${closed.status} (expected 404)`);
  const en = await api('POST', `${P}/enable`);
  say('enable', en.status);
}
let status = null;
for (let i = 0; i < 12; i += 1) {
  const r = await api('POST', '/v1/admin/payments/connect/account', { shop: true });
  status = r.status;
  say(`create account (try ${i + 1})`, `${r.status} ${r.status >= 400 ? r.text : r.body?.connect?.status}`);
  if (r.status !== 202) break;
  await new Promise((res) => setTimeout(res, 5000));
}
const again = await api('POST', '/v1/admin/payments/connect/account', { shop: true });
say('create again', `${again.status} (expected 200, no second account)`);

const read = (await api('GET', P)).body;
view = read.connect;
say('account id', view.accountId);
say('operations', JSON.stringify((read.operations ?? []).map((o) => ({ state: o.state, api: o.api, outcome: o.outcome ?? o.failureCode ?? null }))));
if (view.accountId) {
  const acct = await stripe(`/v1/accounts/${view.accountId}`);
  say('stripe type / country', `${acct.type} / ${acct.country}`);
  say('stripe metadata', JSON.stringify(acct.metadata));
  say('stripe capabilities requested', Object.keys(acct.capabilities ?? {}).join(', '));
  say('stripe payout schedule', JSON.stringify(acct.settings?.payouts?.schedule));
  say('stripe business name', acct.business_profile?.name);
  // No second account carries this tenant in its metadata.
  let count = 0; let after = null;
  for (let p = 0; p < 10; p += 1) {
    const list = await stripe(`/v1/accounts?limit=100${after ? `&starting_after=${after}` : ''}`);
    count += list.data.filter((a) => a.metadata?.tenant_id === TENANT).length;
    if (!list.has_more) break;
    after = list.data[list.data.length - 1].id;
  }
  say('stripe accounts for this tenant', `${count} (expected 1)`);
  const link = await api('POST', '/v1/admin/payments/connect/onboarding-link', { shop: true });
  let host = '?';
  try { host = new URL(link.body.onboarding.url).host; } catch {}
  say('onboarding link', `${link.status}, host ${host}, expires ${link.body?.onboarding?.expiresAt}`);
  const refreshed = await api('POST', '/v1/admin/payments/connect/refresh', { shop: true });
  say('refresh', `${refreshed.status} status=${refreshed.body?.connect?.status} charges=${refreshed.body?.connect?.chargesEnabled} due=${(refreshed.body?.connect?.requirementsDue ?? []).length}`);
  const login = await api('POST', '/v1/admin/payments/connect/login-link', { shop: true });
  say('login link as acting-as', `${login.status} (expected 404)`);
  for (const delayDays of [10, 'minimum']) {
    const r = await api('PUT', `${P}/payout-delay`, { json: { delayDays } });
    const s = (await stripe(`/v1/accounts/${view.accountId}`)).settings?.payouts?.schedule;
    say(`payout delay ${delayDays}`, `${r.status} stored=${r.body?.connect?.payoutDelayDays} stripe=${JSON.stringify(s)} ${r.status >= 400 ? r.text : ''}`);
  }
  const bad = await api('PUT', `${P}/payout-delay`, { json: { delayDays: 1 } });
  say('payout delay 1 (below minimum)', `${bad.status} ${bad.body?.error?.code ?? ''}`);
  const seller = (await api('GET', '/v1/admin/payments/connect', { shop: true })).body;
  say('seller view keys', Object.keys(seller.connect).sort().join(','));
}
