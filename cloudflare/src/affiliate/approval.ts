import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import type { AffiliateInviteContext } from "../email/auth-email-job";
import { issueInvite } from "../platform/invites";
import { createInvitedUser, parseEmail } from "../platform/provision-users";
import { ownPasswordSql } from "../platform/user-directory";
import {
  affiliatePortalUrl,
  affiliateRefLink,
  type CodeRefusal,
  generateAffiliateCode,
  isCodeTaken,
  parseLang,
  parseText,
  parseVanityCode,
  percentToBp,
} from "./affiliates";
import { type ApplicationRow, readApplication } from "./applications";
import { affiliateMailStatement } from "./mail";
import { DEFAULT_COMMISSION_BP, DEFAULT_DISCOUNT_BP } from "./terms";

/**
 * CP13 — admitting an affiliate (design §5.2): the approval of an
 * application, the shop's "Bjud in affiliate" (no application, [DEV-2]), and
 * the invite's resend.
 *
 * ── ONE ADDRESS, ONE KIND (A2, §8.1) ────────────────────────────────────────
 * The address is looked up first. An identity of ANY other kind (a tenant or
 * platform admin, a print operator, an ordinary account), a suspended or
 * revoked one, or a user without an identity is `not_addable`: the approval
 * never touches an existing account's credential or kind (Firebase's §8.1
 * overwrote passwords). An ACTIVE affiliate identity — an affiliate of
 * another shop, or this shop's again — is REUSED: it gains this shop's
 * membership and no second user. A new address becomes a password-less
 * affiliate identity (createInvitedUser).
 *
 * ── ONE GUARDED WRITE DECIDES ───────────────────────────────────────────────
 * One batch: the decision first (the application pending → approved, or for
 * an invite the affiliates row itself), guarded on the identity still being
 * an active affiliate; then, keyed on the decision's stamp, the affiliates
 * row (INSERTed, or RE-ACTIVATED when this person already has one here,
 * R2-26: new code, new rates, status active), the `affiliate` membership
 * (inserted or re-activated), the audit row and — for a person who already
 * has a password — the `affiliate_welcome` mail. A refused decision writes
 * nothing. A taken code (UNIQUE, or 0059's trigger pair against Rabattkoder)
 * aborts the whole batch: a requested code answers `code_taken`, a generated
 * one is drawn again (three times).
 *
 * ── THE LINK ────────────────────────────────────────────────────────────────
 * A person without a password of their own gets the invite (invites.ts: the
 * reset token, 72 h, single use, the previous unused one superseded) as the
 * `affiliate_invite` wording with the shop's context; a person who has one
 * gets the welcome without a link. Nothing stores or mails a password. The
 * approval is idempotent on retry (every statement guarded); a lost invite is
 * re-sent from the detail page (resendAffiliateInvite).
 */

const CODE_ATTEMPTS = 3;

export interface AdmitTerms {
  commissionBp: number;
  /** A requested code; null to generate one. */
  code: string | null;
  discountBp: number;
}

const APPROVE_KEYS = ["code", "commissionPercent", "discountPercent"] as const;

/** `{ code?, discountPercent?, commissionPercent? }` (whole percent; defaults 15/10). */
export function parseApproveInput(body: unknown, tenantId: string): { terms: AdmitTerms } | { refusal: CodeRefusal } | null {
  if (body === null || body === undefined) {
    return { terms: { code: null, commissionBp: DEFAULT_COMMISSION_BP, discountBp: DEFAULT_DISCOUNT_BP } };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => (APPROVE_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  return parseTerms(record, tenantId);
}

function parseTerms(record: Record<string, unknown>, tenantId: string): { terms: AdmitTerms } | { refusal: CodeRefusal } | null {
  let code: string | null = null;
  if (record.code !== undefined && record.code !== null && record.code !== "") {
    const parsed = parseVanityCode(record.code, tenantId);
    if ("refusal" in parsed) {
      return parsed;
    }
    code = parsed.code;
  }
  const commissionBp = record.commissionPercent === undefined ? DEFAULT_COMMISSION_BP : percentToBp(record.commissionPercent);
  const discountBp = record.discountPercent === undefined ? DEFAULT_DISCOUNT_BP : percentToBp(record.discountPercent);
  if (commissionBp === null || discountBp === null) {
    return null;
  }
  return { terms: { code, commissionBp, discountBp } };
}

export interface InviteAffiliateInput {
  email: string;
  name: string;
  preferredLang: "en" | "sv";
  terms: AdmitTerms;
}

const INVITE_KEYS = ["code", "commissionPercent", "discountPercent", "email", "name", "preferredLang"] as const;

/** `{ name, email, code?, discountPercent?, commissionPercent?, preferredLang? }`. */
export function parseInviteAffiliateInput(
  body: unknown,
  tenantId: string,
): { input: InviteAffiliateInput } | { refusal: CodeRefusal } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => (INVITE_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const name = parseText(record.name, 100);
  const email = parseEmail(record.email);
  const preferredLang = record.preferredLang === undefined ? "sv" : parseLang(record.preferredLang);
  if (name === undefined || name === null || email === null || preferredLang === null) {
    return null;
  }
  const terms = parseTerms(record, tenantId);
  if (terms === null || "refusal" in terms) {
    return terms;
  }
  return { input: { email, name, preferredLang, terms: terms.terms } };
}

export type AdmitRefusal =
  | "already_affiliate"
  | "already_decided"
  | "code_taken"
  | "not_addable";

export type AdmitResult =
  | {
      affiliateId: string;
      /** The welcome mail row (a person with a password), for the nudge. */
      outboxIds: string[];
      /** The invite was queued (a person without a password). */
      invited: boolean;
      /**
       * Set when the admission committed but the invite could not be queued
       * (round 1): the admin re-sends it from the affiliate's page.
       */
      inviteError?: "email_unavailable" | "not_invitable";
      status: "ok";
    }
  | { reason: AdmitRefusal; status: "refused" }
  | { status: "email_unavailable" | "invalid" | "not_found" };

interface KnownIdentity {
  account_type: string | null;
  identity_status: string | null;
  own_password: number;
  user_id: string;
}

async function readIdentity(db: D1Database, email: string): Promise<KnownIdentity | null> {
  return db
    .prepare(
      `SELECT u."id" AS user_id, a.account_type, a.status AS identity_status,
              ${ownPasswordSql('u."id"')} AS own_password
       FROM "user" AS u
       LEFT JOIN identity_access AS a ON a.user_id = u."id"
       WHERE u."email" = ?
       LIMIT 1`,
    )
    .bind(email)
    .first<KnownIdentity>();
}

/** An active affiliate identity may be admitted; anything else is not_addable. */
function isAdmittable(identity: KnownIdentity): boolean {
  return identity.account_type === "affiliate" && identity.identity_status === "active";
}

interface Person {
  email: string;
  name: string;
  phone: string | null;
  preferredLang: "en" | "sv";
  promotionMethod: string | null;
  socialsJson: string | null;
}

/** The shop's name, support address and currency (the admission's context). */
async function readShop(db: D1Database, tenantId: string) {
  return db
    .prepare("SELECT shop_name, support_email, default_currency FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ default_currency: string; shop_name: string | null; support_email: string | null }>();
}

/**
 * The common admission of approve and invite. `application`: the pending
 * application approved (its terms acceptance is copied), or null (invite).
 */
async function admit(
  env: Env,
  principal: TenantAdminPrincipal,
  person: Person,
  terms: AdmitTerms,
  application: ApplicationRow | null,
  now: number,
): Promise<AdmitResult> {
  const db = env.DB;
  const tenantId = principal.tenantId;
  const shop = await readShop(db, tenantId);
  if (shop === null) {
    return { status: "not_found" };
  }

  let identity = await readIdentity(db, person.email);
  if (identity !== null && !isAdmittable(identity)) {
    return { reason: "not_addable", status: "refused" };
  }
  if (identity === null) {
    const created = await createInvitedUser(
      env,
      principal,
      { accountType: "affiliate", email: person.email, name: person.name },
      now,
    );
    if (created.status === "invalid") {
      return { status: "invalid" };
    }
    // A concurrent admission created it first: take what it is now.
    identity = await readIdentity(db, person.email);
    if (identity === null || !isAdmittable(identity)) {
      return { reason: "not_addable", status: "refused" };
    }
  }
  const userId = identity.user_id;
  const ownPassword = identity.own_password === 1;

  const existing = await db
    .prepare("SELECT affiliate_id, status FROM affiliates WHERE tenant_id = ? AND user_id = ? LIMIT 1")
    .bind(tenantId, userId)
    .first<{ affiliate_id: string; status: string }>();
  if (application === null && existing !== null && existing.status === "active") {
    return { reason: "already_affiliate", status: "refused" };
  }

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = terms.code ?? generateAffiliateCode(person.name);
    const result = await admitBatch(env, principal, {
      application,
      code,
      existingId: existing?.affiliate_id ?? null,
      ownPassword,
      person,
      shopCurrency: shop.default_currency,
      terms,
      userId,
    }, now);
    if (result === "code_taken") {
      if (terms.code !== null) {
        return { reason: "code_taken", status: "refused" };
      }
      continue;
    }
    if (result === "refused") {
      if (application !== null) {
        const current = await readApplication(db, tenantId, application.application_id);
        if (current === null) {
          return { status: "not_found" };
        }
        if (current.status !== "pending") {
          return { reason: "already_decided", status: "refused" };
        }
      }
      return { reason: "not_addable", status: "refused" };
    }

    // THE ADMISSION HAS COMMITTED (A1 round 1, MUST-3). Whatever the invite
    // does now, the answer is the admission's: 201, with `invited: false` and
    // `inviteError` when the link could not be queued, so the admin re-sends
    // it (POST …/:affiliateId/invite). Never a 503, never `not_addable`: the
    // affiliate row, the membership and the decided application exist.
    if (!ownPassword) {
      const context = await inviteContext(env, tenantId, result.affiliateId, shop.shop_name);
      const invite =
        context === null
          ? ({ status: "email_unavailable" } as const)
          : await issueInvite(env, principal, userId, now, {
              affiliate: context,
              audit: {
                metadataJson: auditMetadataJson(principal, { affiliateId: result.affiliateId }) ?? "{}",
                tenantId,
              },
              locale: person.preferredLang,
            });
      if (invite.status !== "ok") {
        return {
          affiliateId: result.affiliateId,
          invited: false,
          inviteError: invite.status === "email_unavailable" ? "email_unavailable" : "not_invitable",
          outboxIds: result.outboxIds,
          status: "ok",
        };
      }
    }
    return { affiliateId: result.affiliateId, invited: !ownPassword, outboxIds: result.outboxIds, status: "ok" };
  }
  return { reason: "code_taken", status: "refused" };
}

/** The `affiliate_invite` context: every address from the canonical origins. */
async function inviteContext(
  env: Env,
  tenantId: string,
  affiliateId: string,
  shopName: string | null,
): Promise<AffiliateInviteContext | null> {
  const row = await env.DB
    .prepare("SELECT code, commission_bp, discount_bp FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? LIMIT 1")
    .bind(affiliateId, tenantId)
    .first<{ code: string; commission_bp: number; discount_bp: number }>();
  const refLink = row === null ? null : affiliateRefLink(env, tenantId, row.code);
  const portalUrl = affiliatePortalUrl(env, tenantId);
  if (row === null || refLink === null || portalUrl === null) {
    return null;
  }
  return {
    code: row.code,
    commissionBp: row.commission_bp,
    discountBp: row.discount_bp,
    portalUrl,
    refLink,
    shopName: shopName === null ? null : shopName.slice(0, 200),
  };
}

async function admitBatch(
  env: Env,
  principal: TenantAdminPrincipal,
  input: {
    application: ApplicationRow | null;
    code: string;
    existingId: string | null;
    ownPassword: boolean;
    person: Person;
    shopCurrency: string;
    terms: AdmitTerms;
    userId: string;
  },
  now: number,
): Promise<"code_taken" | "refused" | { affiliateId: string; outboxIds: string[] }> {
  const db = env.DB;
  const tenantId = principal.tenantId;
  const nowIso = new Date(now).toISOString();
  const changeId = crypto.randomUUID();
  const affiliateId = input.existingId ?? crypto.randomUUID();
  const identityGuard = `EXISTS (
      SELECT 1 FROM identity_access
      WHERE user_id = ? AND account_type = 'affiliate' AND status = 'active'
    )`;
  // The stamp every statement after the decision is keyed on.
  const admitted = {
    binds: [affiliateId, tenantId, changeId],
    sql: "EXISTS (SELECT 1 FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? AND change_id = ?)",
  };
  const application = input.application;
  const termsVersion = application?.terms_version ?? null;
  const termsAcceptedAt = application?.terms_accepted_at ?? null;

  const statements: D1PreparedStatement[] = [];
  // THE DECISION is the affiliates write (1): the identity still an active
  // affiliate and, for an approval, the application still pending. Every
  // later statement is keyed on the row's fresh stamp (`admitted`).
  const decided =
    application === null
      ? { binds: [input.userId], sql: identityGuard }
      : {
          binds: [input.userId, application.application_id, tenantId],
          sql: `${identityGuard} AND EXISTS (
              SELECT 1 FROM affiliate_applications
              WHERE application_id = ? AND tenant_id = ? AND status = 'pending'
            )`,
        };
  // 1. The affiliates row: inserted, or re-activated (R2-26).
  if (input.existingId === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO affiliates (
             affiliate_id, tenant_id, user_id, code, status, commission_bp, discount_bp, name, phone,
             socials_json, promotion_method, preferred_lang, terms_version, terms_accepted_at,
             application_id, currency, created_by, change_id, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${decided.sql}
             AND NOT EXISTS (SELECT 1 FROM affiliates WHERE tenant_id = ? AND user_id = ?)`,
        )
        .bind(
          affiliateId,
          tenantId,
          input.userId,
          input.code,
          input.terms.commissionBp,
          input.terms.discountBp,
          input.person.name,
          input.person.phone,
          input.person.socialsJson,
          input.person.promotionMethod,
          input.person.preferredLang,
          termsVersion,
          termsAcceptedAt,
          application?.application_id ?? null,
          input.shopCurrency,
          principal.userId,
          changeId,
          nowIso,
          nowIso,
          ...decided.binds,
          tenantId,
          input.userId,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE affiliates
           SET status = 'active', code = ?, commission_bp = ?, discount_bp = ?, change_id = ?,
               terms_version = COALESCE(?, terms_version), terms_accepted_at = COALESCE(?, terms_accepted_at),
               application_id = COALESCE(?, application_id), updated_at = MAX(updated_at, ?)
           WHERE affiliate_id = ? AND tenant_id = ? AND ${decided.sql}
             AND (? IS NOT NULL OR status <> 'active')`,
        )
        .bind(
          input.code,
          input.terms.commissionBp,
          input.terms.discountBp,
          changeId,
          termsVersion,
          termsAcceptedAt,
          application?.application_id ?? null,
          nowIso,
          affiliateId,
          tenantId,
          ...decided.binds,
          application?.application_id ?? null,
        ),
    );
  }
  // 2. The application pending → approved, naming its affiliate.
  if (application !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE affiliate_applications
           SET status = 'approved', decided_by = ?, decided_at = ?, decision_id = ?, affiliate_id = ?,
               updated_at = MAX(updated_at, ?)
           WHERE application_id = ? AND tenant_id = ? AND status = 'pending' AND ${admitted.sql}`,
        )
        .bind(principal.userId, nowIso, changeId, affiliateId, nowIso, application.application_id, tenantId, ...admitted.binds),
    );
  }
  // 3. The membership of role 'affiliate': inserted, or re-activated.
  statements.push(
    db
      .prepare(
        `INSERT INTO tenant_memberships (
           membership_id, tenant_id, user_id, role, status, created_at, updated_at, status_change_id
         )
         SELECT ?, ?, ?, 'affiliate', 'active', ?, ?, ?
         WHERE ${admitted.sql}
           AND NOT EXISTS (
             SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND user_id = ? AND role = 'affiliate'
           )`,
      )
      .bind(crypto.randomUUID(), tenantId, input.userId, now, now, changeId, ...admitted.binds, tenantId, input.userId),
    // Codex round 4 (finding 2): only a membership "Ta bort" REVOKED comes
    // back with an admission (approval or "Bjud in"); one the platform
    // SUSPENDED stays suspended, exactly as on the PATCH path (round 1). The
    // affiliate row itself is still (re-)activated; the admin sees the
    // membership as "suspended" on the affiliate's page (account.membership).
    db
      .prepare(
        `UPDATE tenant_memberships
         SET status = 'active', updated_at = MAX(updated_at, ?), status_change_id = ?
         WHERE tenant_id = ? AND user_id = ? AND role = 'affiliate' AND status = 'revoked'
           AND ${admitted.sql}`,
      )
      .bind(now, changeId, tenantId, input.userId, ...admitted.binds),
    // 4. The audit row: never the address or the code.
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'affiliate', ?, ?, ?, ?
         WHERE ${admitted.sql}`,
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        principal.userId,
        application === null ? "affiliate.invite" : "affiliate.approve",
        affiliateId,
        crypto.randomUUID(),
        auditMetadataJson(principal, {
          applicationId: application?.application_id ?? null,
          changeId,
          commissionBp: input.terms.commissionBp,
          discountBp: input.terms.discountBp,
          reactivated: input.existingId !== null,
          userId: input.userId,
        }),
        now,
        ...admitted.binds,
      ),
  );
  // 5. The welcome of a person who already has a password (no link).
  const outboxIds: string[] = [];
  if (input.ownPassword) {
    const welcome = affiliateMailStatement(db, {
      aggregateId: affiliateId,
      aggregateType: "affiliate",
      dedupeKey: `email:affiliate_welcome:${affiliateId}:${changeId}`,
      guard: admitted,
      kind: "affiliate_welcome",
      now,
      payload: { affiliateId },
      tenantId,
    });
    statements.push(welcome.statement);
    outboxIds.push(welcome.outboxId);
  }

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isCodeTaken(error)) {
      return "code_taken";
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return "refused";
  }
  return { affiliateId, outboxIds };
}

/** `POST …/applications/:id/approve`. */
export async function approveApplication(
  env: Env,
  principal: TenantAdminPrincipal,
  applicationId: string,
  terms: AdmitTerms,
  now: number,
): Promise<AdmitResult> {
  const application = await readApplication(env.DB, principal.tenantId, applicationId);
  if (application === null) {
    return { status: "not_found" };
  }
  if (application.status !== "pending") {
    return { reason: "already_decided", status: "refused" };
  }
  return admit(
    env,
    principal,
    {
      email: application.email,
      name: application.name,
      phone: application.phone,
      preferredLang: application.preferred_lang,
      promotionMethod: application.promotion_method,
      socialsJson: application.socials_json,
    },
    terms,
    application,
    now,
  );
}

/** `POST /v1/admin/affiliates` — "Bjud in affiliate": no application. */
export async function inviteAffiliate(
  env: Env,
  principal: TenantAdminPrincipal,
  input: InviteAffiliateInput,
  now: number,
): Promise<AdmitResult> {
  return admit(
    env,
    principal,
    {
      email: input.email,
      name: input.name,
      phone: null,
      preferredLang: input.preferredLang,
      promotionMethod: null,
      socialsJson: null,
    },
    input.terms,
    null,
    now,
  );
}

export type ResendResult =
  | { status: "ok" }
  | { reason: "not_invitable" | "not_invited"; status: "refused" }
  | { status: "email_unavailable" | "not_found" };

/**
 * `POST /v1/admin/affiliates/:id/invite` — a new 72-hour link for an
 * affiliate of this shop who has not set a password of their own (the
 * members' resend rule, tenant-members.ts). Both facts — still this shop's
 * affiliate with an active membership, still without a password — are
 * re-checked INSIDE the batch that would supersede the live link.
 */
export async function resendAffiliateInvite(
  env: Env,
  principal: TenantAdminPrincipal,
  affiliateId: string,
  now: number,
): Promise<ResendResult> {
  const row = await env.DB
    .prepare(
      `SELECT a.user_id, a.preferred_lang, t.shop_name, ${ownPasswordSql("a.user_id")} AS own_password
       FROM affiliates AS a INNER JOIN tenants AS t ON t.tenant_id = a.tenant_id
       WHERE a.affiliate_id = ? AND a.tenant_id = ? LIMIT 1`,
    )
    .bind(affiliateId, principal.tenantId)
    .first<{ own_password: number; preferred_lang: "en" | "sv"; shop_name: string | null; user_id: string }>();
  if (row === null) {
    return { status: "not_found" };
  }
  if (row.own_password === 1) {
    return { reason: "not_invited", status: "refused" };
  }
  const context = await inviteContext(env, principal.tenantId, affiliateId, row.shop_name);
  if (context === null) {
    return { status: "email_unavailable" };
  }
  const invite = await issueInvite(env, principal, row.user_id, now, {
    affiliate: context,
    audit: {
      metadataJson: auditMetadataJson(principal, { affiliateId, resend: true }) ?? "{}",
      tenantId: principal.tenantId,
    },
    condition: {
      binds: [principal.tenantId, row.user_id, row.user_id],
      sql: `EXISTS (
          SELECT 1 FROM tenant_memberships
          WHERE tenant_id = ? AND user_id = ? AND role = 'affiliate' AND status = 'active'
        )
        AND NOT ${ownPasswordSql("?")}`,
    },
    locale: row.preferred_lang,
  });
  switch (invite.status) {
    case "ok":
      return { status: "ok" };
    case "email_unavailable":
      return { status: "email_unavailable" };
    case "not_found":
      return { status: "not_found" };
    case "not_invitable":
      return { reason: "not_invitable", status: "refused" };
  }
}
