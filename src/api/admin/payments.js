// The seller's Stripe Connect routes and the platform's payout-delay route
// (CP5 brief FF; the Worker: cloudflare/src/routes/connect-admin.ts and
// connect-platform.ts, report docs/cf-port/CP3_F_REPORT.md).
//
//   GET  /v1/admin/payments/connect                  { connect: SellerConnectView }
//   POST /v1/admin/payments/connect/account          201|200 { connect } · 202 { connect, accountCreation: 'pending' } + Retry-After
//   POST /v1/admin/payments/connect/onboarding-link  { onboarding: { url, expiresAt } }
//   POST /v1/admin/payments/connect/refresh          { connect }
//   POST /v1/admin/payments/connect/login-link       { dashboard: { url } }   (404 while acting-as)
//   GET  /v1/admin/payments/connect/balance          { balance: { available, pending, payoutSchedule, retrievedAt } }
//                                                    409 connect_account_missing · 429 · 502 · 404 (CP5-FP)
//   GET  /v1/platform/tenants/:id/connect            { connect: PlatformConnectView, operations }
//   PUT  /v1/platform/tenants/:id/connect/payout-delay  { delayDays: 0..365 | 'minimum' } → { connect }
//
// The seller's routes carry X-Shop-Id (adminRequest); the platform's never do
// (platformRequest, D70). No body is sent to the seller's POSTs: the Worker
// reads none. Nothing here computes a figure: the views are passed on as the
// server gave them, and the page's adapter picks the fields it shows.

import { AdminApiError, adminRequest, platformRequest, segment } from './client.js';

export const CONNECT_PATH = '/v1/admin/payments/connect';

/** The seller's view, or null when the route answers the opaque 404. */
export async function getConnect({ shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', CONNECT_PATH, { shopId, signal });
    return data?.connect ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Creates the shop's one account, or answers the one it has.
 * → { connect, pending: boolean, retryAfterSeconds: number|null }
 */
export async function createConnectAccount({ shopId } = {}) {
  const { status, data, headers } = await adminRequest('POST', `${CONNECT_PATH}/account`, { shopId });
  const pending = status === 202 || data?.accountCreation === 'pending';
  const retry = Number(headers?.get?.('retry-after'));
  return {
    connect: data?.connect ?? null,
    pending,
    retryAfterSeconds: pending && Number.isFinite(retry) && retry >= 0 ? retry : null,
  };
}

/** A fresh Stripe-hosted onboarding address. → { url, expiresAt } */
export async function createOnboardingLink({ shopId } = {}) {
  const { data } = await adminRequest('POST', `${CONNECT_PATH}/onboarding-link`, { shopId });
  return { url: data?.onboarding?.url ?? null, expiresAt: data?.onboarding?.expiresAt ?? null };
}

/** Stripe's current status, written by the server. → the seller's view */
export async function refreshConnect({ shopId } = {}) {
  const { data } = await adminRequest('POST', `${CONNECT_PATH}/refresh`, { shopId });
  return data?.connect ?? null;
}

/** The seller's own Stripe dashboard. → { url } */
export async function createLoginLink({ shopId } = {}) {
  const { data } = await adminRequest('POST', `${CONNECT_PATH}/login-link`, { shopId });
  return { url: data?.dashboard?.url ?? null };
}

const platformConnectPath = (tenantId) => `/v1/platform/tenants/${segment(tenantId)}/connect`;

/** Platform only: the platform's view of the shop's account. */
export async function getPlatformConnect(tenantId, { signal } = {}) {
  const { data } = await platformRequest('GET', platformConnectPath(tenantId), { signal });
  return data?.connect ?? null;
}

/** Platform only: `delayDays` 0..365 or 'minimum'. → the platform's view */
export async function setPlatformPayoutDelay(tenantId, delayDays) {
  const { data } = await platformRequest('PUT', `${platformConnectPath(tenantId)}/payout-delay`, {
    json: { delayDays },
  });
  return data?.connect ?? null;
}

/**
 * The connected account's balance and payout schedule, read at Stripe now
 * (CP5-WK, unit WF): `{ available, pending, payoutSchedule, retrievedAt }`.
 * Rejects with the AdminApiError: 409 connect_account_missing, 429
 * rate_limited (`retryAfterSeconds`; the limiter the four POSTs share), 502
 * connect_unavailable, 404 (Connect not enabled for the shop).
 */
export async function getConnectBalance({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', `${CONNECT_PATH}/balance`, { shopId, signal });
  return data?.balance ?? null;
}
