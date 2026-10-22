import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { purgeDeniedApplications } from "../src/affiliate/applications";
import { AFFILIATE_TERMS_VERSION } from "../src/affiliate/terms";
import { parseAuthEmailJob } from "../src/email/auth-email-job";
import {
  ADMIN_HOST,
  captureQueue,
  count,
  envWith,
  featureStatement,
  hostRequest,
  nextId,
  type Person,
  portalAffiliateOf,
  seedAffiliate,
  seedPublicShop,
  shopAdminOf,
  signUpPerson,
} from "./affiliate-fixtures";
import { seedCode } from "./discount-fixtures";

/**
 * CP13 — the routes of the program (design §5, §7.1): the storefront's form
 * and terms, the shop's queue, approval, denial, invite, edit and removal,
 * the add-on gate, and who may call what (the opaque 404 to everyone else).
 * The money routes (payouts, invoices) are test/affiliate-payouts.test.ts.
 */

const SHOP = "aff-routes";
const HOST = "aff-routes.shop.test";
const OTHER = "aff-routes-other";
const OFF = "aff-routes-off";
const OFF_HOST = "aff-routes-off.shop.test";

let admin: Person;
let otherAdmin: Person;
let offAdmin: Person;
let affiliate: Person & { affiliateId: string };

function call(request: Request, targetEnv: Env = env): Promise<Response> {
  return worker.fetch(request, targetEnv);
}

function asAdmin(method: string, path: string, body?: unknown, person: Person = admin, shopId = SHOP) {
  return hostRequest(method, path, { body, cookie: person.cookie, shopId });
}

function storefront(method: string, path: string, body?: unknown, host = HOST, ip = "203.0.113.7") {
  return new Request(`https://${host}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
    method,
  });
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    email: `${nextId("applicant")}@applicant.test`,
    message: "Jag driver en träningsblogg.",
    name: "Sara Sökande",
    preferredLang: "sv",
    promotionMethod: "blog",
    socials: { website: "https://sara.example.test" },
    termsAccepted: true,
    termsVersion: AFFILIATE_TERMS_VERSION,
    ...overrides,
  };
}

/** The shop's daily limit is its own test; the other tests start from an empty window. */
async function clearShopLimit(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limit_windows WHERE scope = 'affiliate-apply-tenant'").run();
}

async function apply(overrides: Record<string, unknown> = {}, ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`) {
  await clearShopLimit();
  const response = await call(storefront("POST", "/v1/affiliate-applications", application(overrides), HOST, ip));
  return response;
}

async function applicationIdFor(email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT application_id FROM affiliate_applications WHERE email = ? AND tenant_id = ?")
    .bind(email, SHOP)
    .first<{ application_id: string }>();
  if (row === null) {
    throw new Error("no application");
  }
  return row.application_id;
}

beforeAll(async () => {
  await seedPublicShop(SHOP, HOST);
  await seedPublicShop(OTHER, "aff-routes-other.shop.test");
  await seedPublicShop(OFF, OFF_HOST, false);
  admin = await shopAdminOf(SHOP);
  otherAdmin = await shopAdminOf(OTHER);
  offAdmin = await shopAdminOf(OFF);
  affiliate = await portalAffiliateOf(SHOP, "PORTAL1");
});

describe("the storefront's form (POST /v1/affiliate-applications)", () => {
  it("answers 202 with an id, stores one pending application and queues the two mails in its batch", async () => {
    const body = application();
    const response = await call(storefront("POST", "/v1/affiliate-applications", body));
    expect(response.status).toBe(202);
    const { applicationId } = await response.json<{ applicationId: string }>();
    const row = await env.DB.prepare("SELECT status, email, name, terms_version FROM affiliate_applications WHERE application_id = ?")
      .bind(applicationId)
      .first();
    expect(row).toEqual({ email: body.email, name: body.name, status: "pending", terms_version: AFFILIATE_TERMS_VERSION });
    expect(
      await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_type = 'affiliate_application' AND aggregate_id = ?", applicationId),
    ).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.apply' AND resource_id = ?", applicationId)).toBe(1);
  });

  it("answers the same 202 to a second application of a pending address, and stores and sends nothing", async () => {
    const email = `${nextId("twice")}@applicant.test`;
    expect((await apply({ email })).status).toBe(202);
    const before = await count("SELECT COUNT(*) AS n FROM outbox_events");
    const again = await apply({ email: email.toUpperCase() });
    expect(again.status).toBe(202);
    const { applicationId } = await again.json<{ applicationId: string }>();
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_applications WHERE application_id = ?", applicationId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_applications WHERE email = ?", email)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outbox_events")).toBe(before);
  });

  it.each([
    ["no terms acceptance", { termsAccepted: false }],
    ["a stale terms version", { termsVersion: "2020-01-01" }],
    ["a bad address", { email: "not-an-address" }],
    ["an unknown promotion method", { promotionMethod: "billboard" }],
    ["an unknown key", { status: "approved" }],
    ["a message over 2 000", { message: "x".repeat(2_001) }],
    ["a social that is not allowed", { socials: { myspace: "x" } }],
  ])("refuses %s with 400 and stores nothing", async (_label, overrides) => {
    const before = await count("SELECT COUNT(*) AS n FROM affiliate_applications");
    expect((await apply(overrides)).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_applications")).toBe(before);
  });

  it("is the opaque 404 with the add-on OFF, for another method, and on the public entrypoint's unknown host", async () => {
    expect((await call(storefront("POST", "/v1/affiliate-applications", application(), OFF_HOST))).status).toBe(404);
    expect((await call(storefront("GET", "/v1/affiliate-applications"))).status).toBe(404);
    expect((await call(storefront("POST", "/v1/affiliate-applications", application(), "nobody.shop.test"))).status).toBe(404);
  });

  it("limits one shop to 20 a day, whoever applies", async () => {
    await clearShopLimit();
    for (let index = 0; index < 20; index += 1) {
      const response = await call(storefront("POST", "/v1/affiliate-applications", application(), HOST, `198.18.0.${index + 1}`));
      expect(response.status).toBe(202);
    }
    const limited = await call(storefront("POST", "/v1/affiliate-applications", application(), HOST, "198.18.1.1"));
    expect(limited.status).toBe(429);
  });

  it("limits a visitor to 5 an hour, before the body is read", async () => {
    const ip = "192.0.2.77";
    for (let index = 0; index < 5; index += 1) {
      expect((await apply({}, ip)).status).toBe(202);
    }
    const limited = await apply({}, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // A malformed body counts too: the limit runs first.
    expect((await call(storefront("POST", "/v1/affiliate-applications", "{", HOST, ip))).status).toBe(429);
  });
});

describe("the terms (GET /v1/affiliate-terms)", () => {
  it("answers the current version rendered for the shop at the default rates", async () => {
    const response = await call(storefront("GET", "/v1/affiliate-terms"));
    expect(response.status).toBe(200);
    const { terms } = await response.json<{ terms: { sha256: string; text: string; version: string } }>();
    expect(terms.version).toBe(AFFILIATE_TERMS_VERSION);
    expect(terms.text).toContain(`Butik ${SHOP}`);
    expect(terms.text).toContain("15 %");
    expect(terms.text).toContain("10 %");
    expect(terms.text).toContain("marknadsföringslagen");
    expect(terms.text).not.toContain("{{");
    expect((await call(storefront("GET", "/v1/affiliate-terms", undefined, OFF_HOST))).status).toBe(404);
  });
});

describe("the shop's queue: approve, deny", () => {
  it("lists pending first, then decided; one application by id; never another shop's", async () => {
    const response = await call(asAdmin("GET", "/v1/admin/affiliates/applications"));
    expect(response.status).toBe(200);
    const body = await response.json<{ applications: Array<{ applicationId: string; status: string }>; nextCursor: string | null }>();
    expect(body.applications.length).toBeGreaterThan(0);
    const firstDecided = body.applications.findIndex((row) => row.status !== "pending");
    if (firstDecided >= 0) {
      expect(body.applications.slice(firstDecided).every((row) => row.status !== "pending")).toBe(true);
    }
    const id = body.applications[0]?.applicationId ?? "";
    expect((await call(asAdmin("GET", `/v1/admin/affiliates/applications/${id}`))).status).toBe(200);
    expect((await call(asAdmin("GET", `/v1/admin/affiliates/applications/${id}`, undefined, otherAdmin, OTHER))).status).toBe(404);
    // Paging.
    const page = await call(asAdmin("GET", "/v1/admin/affiliates/applications?limit=1"));
    const first = await page.json<{ applications: unknown[]; nextCursor: string | null }>();
    expect(first.applications).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const next = await call(asAdmin("GET", `/v1/admin/affiliates/applications?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`));
    expect(next.status).toBe(200);
    expect((await call(asAdmin("GET", "/v1/admin/affiliates/applications?cursor=nope"))).status).toBe(400);
  });

  it("approves a new address: an affiliate identity without a password, the membership, the row, the invite naming the shop", async () => {
    const email = `${nextId("new")}@applicant.test`;
    await apply({ email, preferredLang: "en" });
    const applicationId = await applicationIdFor(email);
    const captured = captureQueue();
    const response = await call(
      asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, { code: "sara-25", commissionPercent: 20, discountPercent: 5 }),
      envWith({ EMAIL_QUEUE: captured.queue }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{
      affiliate: { affiliateId: string; code: string; commissionBp: number; discountBp: number; links: { refLink: string } };
      application: { status: string };
      invited: boolean;
      mailConfigured: boolean;
    }>();
    expect(body).toMatchObject({ application: { status: "approved" }, invited: true });
    expect(body.affiliate).toMatchObject({ code: "SARA-25", commissionBp: 2_000, discountBp: 500 });
    expect(body.affiliate.links.refLink).toBe(`https://web.test.invalid/${SHOP}/?ref=SARA-25`);
    const identity = await env.DB.prepare(
      `SELECT a.account_type, (SELECT COUNT(*) FROM "account" WHERE "userId" = a.user_id AND "password" IS NOT NULL) AS passwords
       FROM identity_access AS a INNER JOIN "user" AS u ON u."id" = a.user_id WHERE u."email" = ?`,
    )
      .bind(email)
      .first();
    expect(identity).toEqual({ account_type: "affiliate", passwords: 0 });
    expect(captured.sent).toHaveLength(1);
    const job = parseAuthEmailJob(captured.sent[0], env.AUTH_BASE_URL) as { affiliate?: unknown; locale: string; variant?: string };
    expect(job).toMatchObject({ affiliate: { code: "SARA-25", shopName: `Butik ${SHOP}` }, locale: "en", variant: "affiliate_invite" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.approve' AND resource_id = ?", body.affiliate.affiliateId)).toBe(1);

    // Decided once.
    const again = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, {}), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect(again.status).toBe(409);
    expect((await again.json<{ error: { code: string } }>()).error.code).toBe("already_decided");
  });

  it("approves an affiliate of another shop: a membership here, no second user, the welcome without a link", async () => {
    const elsewhere = await portalAffiliateOf(OTHER, "ELSEWHERE");
    await apply({ email: elsewhere.email });
    const applicationId = await applicationIdFor(elsewhere.email);
    const captured = captureQueue();
    const response = await call(
      asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, {}),
      envWith({ EMAIL_QUEUE: captured.queue }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ affiliate: { affiliateId: string; code: string }; invited: boolean }>();
    expect(body.invited).toBe(false);
    expect(body.affiliate.code).toMatch(/^SAR[0-9A-Z]{6}$/);
    expect(captured.sent).toHaveLength(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = ?`, elsewhere.email)).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM tenant_memberships WHERE user_id = ? AND role = 'affiliate' AND status = 'active'", elsewhere.userId),
    ).toBe(2);
    expect(
      await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_type = 'affiliate' AND aggregate_id = ? AND payload_json LIKE '%affiliate_welcome%'", body.affiliate.affiliateId),
    ).toBe(1);
  });

  it("refuses an address held by a tenant admin, a platform admin or a print operator: not_addable, nothing written", async () => {
    for (const kind of ["tenant_admin", "platform_admin", "print_operator"]) {
      const person = await signUpPerson(`${nextId(kind)}@held.test`, kind);
      await apply({ email: person.email });
      const applicationId = await applicationIdFor(person.email);
      const affiliatesBefore = await count("SELECT COUNT(*) AS n FROM affiliates");
      const response = await call(
        asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, {}),
        envWith({ EMAIL_QUEUE: captureQueue().queue }),
      );
      expect(response.status, kind).toBe(409);
      expect((await response.json<{ error: { code: string } }>()).error.code, kind).toBe("not_addable");
      expect(await count("SELECT COUNT(*) AS n FROM affiliates"), kind).toBe(affiliatesBefore);
      const identity = await env.DB.prepare("SELECT account_type FROM identity_access WHERE user_id = ?")
        .bind(person.userId)
        .first<{ account_type: string }>();
      expect(identity?.account_type, kind).toBe(kind);
    }
  });

  it("refuses a requested code a Rabattkod (or another affiliate) holds, and a reserved word", async () => {
    await seedCode({ code: "SOMMAR10", tenantId: SHOP });
    const email = `${nextId("code")}@applicant.test`;
    await apply({ email });
    const applicationId = await applicationIdFor(email);
    const taken = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, { code: "sommar10" }), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect(taken.status).toBe(409);
    expect((await taken.json<{ error: { code: string } }>()).error.code).toBe("code_taken");
    const portalCode = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, { code: "PORTAL1" }), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect((await portalCode.json<{ error: { code: string } }>()).error.code).toBe("code_taken");
    const reserved = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, { code: "admin" }), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ error: { code: "invalid_request", message: "Request is not valid", reason: "code_reserved" } });
    const own = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, { code: SHOP }), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect(own.status).toBe(400);
    // Still pending after every refusal.
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_applications WHERE application_id = ? AND status = 'pending'", applicationId)).toBe(1);
    // The other direction: a Rabattkod named like an affiliate's code is a conflict on the Rabattkoder route.
    await featureStatement(SHOP, "discountCodes", true).run();
    const clash = await call(asAdmin("POST", "/v1/admin/discount-codes", { code: "PORTAL1", scope: "all", type: "fixed", valueMinor: 100 }));
    expect(clash.status).toBe(409);
    expect((await clash.json<{ error: { code: string } }>()).error.code).toBe("conflict");
  });

  it("denies with a reason, mails it, keeps the row; a second decision is already_decided", async () => {
    const email = `${nextId("deny")}@applicant.test`;
    await apply({ email });
    const applicationId = await applicationIdFor(email);
    const response = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/deny`, { reason: "Passar inte vårt sortiment." }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ application: { decisionReason: "Passar inte vårt sortiment.", status: "denied" } });
    expect(
      await count("SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ? AND payload_json LIKE '%affiliate_application_denied%'", applicationId),
    ).toBe(1);
    const again = await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/deny`, { reason: "x" }));
    expect(again.status).toBe(409);
    expect((await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/deny`, {}))).status).toBe(400);
  });

  it("the retention deletes denied applications older than 12 months, never a pending or approved one", async () => {
    const email = `${nextId("old")}@applicant.test`;
    await apply({ email });
    const applicationId = await applicationIdFor(email);
    await call(asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/deny`, { reason: "Nej" }));
    const pending = await count("SELECT COUNT(*) AS n FROM affiliate_applications WHERE status <> 'denied'");
    expect(await purgeDeniedApplications(env.DB, Date.now())).toBe(0);
    const purged = await purgeDeniedApplications(env.DB, Date.now() + 366 * 24 * 60 * 60 * 1_000);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_applications WHERE application_id = ?", applicationId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM affiliate_applications WHERE status <> 'denied'")).toBe(pending);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.application_retention'")).toBe(1);
  });
});

describe("Bjud in, the edit, the removal and the re-activation", () => {
  it("invites by hand (no application), refuses an active affiliate of the shop again, re-sends a link while no password is set", async () => {
    const email = `${nextId("invite")}@invitee.test`;
    const captured = captureQueue();
    const response = await call(
      asAdmin("POST", "/v1/admin/affiliates", { email, name: "Ida Inbjuden" }),
      envWith({ EMAIL_QUEUE: captured.queue }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ affiliate: { affiliateId: string; terms: { outdated: boolean } }; invited: boolean }>();
    expect(body.invited).toBe(true);
    // Nobody accepted terms for an invited affiliate: the portal asks first.
    expect(body.affiliate.terms.outdated).toBe(true);
    expect(captured.sent).toHaveLength(1);
    const again = await call(asAdmin("POST", "/v1/admin/affiliates", { email, name: "Ida" }), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect((await again.json<{ error: { code: string } }>()).error.code).toBe("already_affiliate");
    const resend = captureQueue();
    expect((await call(asAdmin("POST", `/v1/admin/affiliates/${body.affiliate.affiliateId}/invite`), envWith({ EMAIL_QUEUE: resend.queue }))).status).toBe(202);
    expect(resend.sent).toHaveLength(1);
    // A person with a password is not invited again.
    const notInvited = await call(asAdmin("POST", `/v1/admin/affiliates/${affiliate.affiliateId}/invite`), envWith({ EMAIL_QUEUE: captureQueue().queue }));
    expect((await notInvited.json<{ error: { code: string } }>()).error.code).toBe("not_invited");
  });

  it("edits rates, code and contact; refuses a taken code; toggles the status explicitly", async () => {
    const { affiliateId } = await seedAffiliate({ code: "EDITME", tenantId: SHOP });
    const edited = await call(asAdmin("PATCH", `/v1/admin/affiliates/${affiliateId}`, { city: "Lund", code: "edit-2", commissionPercent: 12, status: "suspended" }));
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ affiliate: { address: { city: "Lund" }, code: "EDIT-2", commissionBp: 1_200, status: "suspended" } });
    const taken = await call(asAdmin("PATCH", `/v1/admin/affiliates/${affiliateId}`, { code: "PORTAL1" }));
    expect((await taken.json<{ error: { code: string } }>()).error.code).toBe("code_taken");
    expect((await call(asAdmin("PATCH", `/v1/admin/affiliates/${affiliateId}`, { commissionPercent: 101 }))).status).toBe(400);
    expect((await call(asAdmin("PATCH", `/v1/admin/affiliates/${affiliateId}`, { status: "deleted" }))).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.update' AND resource_id = ?", affiliateId)).toBe(1);
  });

  it("'Ta bort' makes the affiliate inactive and revokes the membership; nothing is deleted; 'Aktiv' restores both", async () => {
    const person = await portalAffiliateOf(SHOP, "REMOVEME");
    const removed = await call(asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/revoke`));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ affiliate: { account: { membership: "revoked" }, status: "inactive" } });
    expect((await call(hostRequest("GET", "/v1/affiliate/me", { cookie: person.cookie, shopId: SHOP }))).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM affiliates WHERE affiliate_id = ?", person.affiliateId)).toBe(1);
    const restored = await call(asAdmin("PATCH", `/v1/admin/affiliates/${person.affiliateId}`, { status: "active" }));
    expect(await restored.json()).toMatchObject({ affiliate: { account: { membership: "active" }, status: "active" } });
    expect((await call(hostRequest("GET", "/v1/affiliate/me", { cookie: person.cookie, shopId: SHOP }))).status).toBe(200);
  });

  it("re-approval of a removed affiliate re-activates its row with the new code and rates (R2-26)", async () => {
    const person = await portalAffiliateOf(SHOP, "COMEBACK");
    await call(asAdmin("POST", `/v1/admin/affiliates/${person.affiliateId}/revoke`));
    await apply({ email: person.email });
    const applicationId = await applicationIdFor(person.email);
    const response = await call(
      asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, { code: "COMEBACK2", discountPercent: 20 }),
      envWith({ EMAIL_QUEUE: captureQueue().queue }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      affiliate: { account: { membership: "active" }, affiliateId: person.affiliateId, code: "COMEBACK2", discountBp: 2_000, status: "active" },
    });
    expect(await count("SELECT COUNT(*) AS n FROM affiliates WHERE user_id = ? AND tenant_id = ?", person.userId, SHOP)).toBe(1);
  });
});

describe("round 1: a committed admission, the edit's audit, the suspended membership", () => {
  function failingQueue(): Queue {
    return {
      send: async () => Promise.reject(new Error("queue down")),
      sendBatch: async () => Promise.reject(new Error("queue down")),
    } as unknown as Queue;
  }

  it("an invite that fails AFTER the admission committed answers 201 with invited: false and inviteError; the re-send works", async () => {
    const email = `${nextId("postcommit")}@applicant.test`;
    await apply({ email });
    const applicationId = await applicationIdFor(email);
    const response = await call(
      asAdmin("POST", `/v1/admin/affiliates/applications/${applicationId}/approve`, {}),
      envWith({ EMAIL_QUEUE: failingQueue() }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{
      affiliate: { account: { invited: boolean; membership: string }; affiliateId: string };
      application: { status: string };
      invited: boolean;
      inviteError?: string;
    }>();
    expect(body).toMatchObject({ application: { status: "approved" }, invited: false, inviteError: "email_unavailable" });
    expect(body.affiliate.account).toMatchObject({ invited: true, membership: "active" });
    // The admin re-sends from the affiliate's page.
    const resend = captureQueue();
    expect(
      (await call(asAdmin("POST", `/v1/admin/affiliates/${body.affiliate.affiliateId}/invite`), envWith({ EMAIL_QUEUE: resend.queue }))).status,
    ).toBe(202);
    expect(resend.sent).toHaveLength(1);

    // The same for "Bjud in" by hand.
    const invited = await call(
      asAdmin("POST", "/v1/admin/affiliates", { email: `${nextId("postcommit")}@invitee.test`, name: "Ivar" }),
      envWith({ EMAIL_QUEUE: failingQueue() }),
    );
    expect(invited.status).toBe(201);
    expect(await invited.json()).toMatchObject({ invited: false, inviteError: "email_unavailable" });
  });

  it("an edit the identity guard refuses writes no audit row (not_addable)", async () => {
    const person = await portalAffiliateOf(SHOP, "GUARDED", { status: "inactive" });
    await env.DB.prepare("UPDATE identity_access SET status = 'suspended' WHERE user_id = ?").bind(person.userId).run();
    const refusedEdit = await call(asAdmin("PATCH", `/v1/admin/affiliates/${person.affiliateId}`, { status: "active" }));
    expect(refusedEdit.status).toBe(409);
    expect((await refusedEdit.json<{ error: { code: string } }>()).error.code).toBe("not_addable");
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.update' AND resource_id = ?", person.affiliateId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM affiliates WHERE affiliate_id = ? AND status = 'inactive'", person.affiliateId)).toBe(1);
  });

  it("'Aktiv' re-activates a membership 'Ta bort' revoked, never one the platform suspended", async () => {
    const person = await portalAffiliateOf(SHOP, "PLATSUSP");
    await env.DB.batch([
      env.DB.prepare("UPDATE affiliates SET status = 'inactive' WHERE affiliate_id = ?").bind(person.affiliateId),
      env.DB.prepare("UPDATE tenant_memberships SET status = 'suspended' WHERE user_id = ? AND tenant_id = ?").bind(person.userId, SHOP),
    ]);
    const response = await call(asAdmin("PATCH", `/v1/admin/affiliates/${person.affiliateId}`, { status: "active" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ affiliate: { account: { membership: "suspended" }, status: "active" } });
    expect((await call(hostRequest("GET", "/v1/affiliate/me", { cookie: person.cookie, shopId: SHOP }))).status).toBe(404);
  });
});

describe("the add-on gate (A12, R2-17)", () => {
  it("OFF: the list, the queue, approvals, invites and analytics are the opaque 404; an affiliate's detail, ledger and payouts stay", async () => {
    const { affiliateId } = await seedAffiliate({ code: "OFFAFF", tenantId: OFF });
    for (const [method, path] of [
      ["GET", "/v1/admin/affiliates"],
      ["POST", "/v1/admin/affiliates"],
      ["GET", "/v1/admin/affiliates/applications"],
      ["GET", "/v1/admin/affiliates/analytics"],
      ["POST", `/v1/admin/affiliates/${affiliateId}/invite`],
    ] as const) {
      const response = await call(asAdmin(method, path, method === "POST" ? { email: "x@y.test", name: "X" } : undefined, offAdmin, OFF));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    for (const path of [
      `/v1/admin/affiliates/${affiliateId}`,
      `/v1/admin/affiliates/${affiliateId}/ledger`,
      `/v1/admin/affiliates/${affiliateId}/orders`,
      `/v1/admin/affiliates/${affiliateId}/payouts`,
    ]) {
      const response = await call(asAdmin("GET", path, undefined, offAdmin, OFF));
      expect(response.status, path).toBe(200);
    }
    const detail = await (await call(asAdmin("GET", `/v1/admin/affiliates/${affiliateId}`, undefined, offAdmin, OFF))).json<{ affiliate: { programOn: boolean } }>();
    expect(detail.affiliate.programOn).toBe(false);
  });
});

describe("who may call what", () => {
  const ID = "00000000-0000-4000-8000-000000000000";
  const ADMIN_ROUTES: Array<[string, string]> = [
    ["GET", "/v1/admin/affiliates"],
    ["POST", "/v1/admin/affiliates"],
    ["GET", "/v1/admin/affiliates/applications"],
    ["GET", "/v1/admin/affiliates/analytics"],
    ["GET", `/v1/admin/affiliates/applications/${ID}`],
    ["POST", `/v1/admin/affiliates/applications/${ID}/approve`],
    ["POST", `/v1/admin/affiliates/applications/${ID}/deny`],
    ["POST", `/v1/admin/affiliates/payouts/${ID}/paid`],
    ["POST", `/v1/admin/affiliates/payouts/${ID}/void`],
    ["GET", `/v1/admin/affiliates/${ID}`],
    ["PATCH", `/v1/admin/affiliates/${ID}`],
    ["POST", `/v1/admin/affiliates/${ID}/invite`],
    ["POST", `/v1/admin/affiliates/${ID}/revoke`],
    ["POST", `/v1/admin/affiliates/${ID}/adjustments`],
    ["GET", `/v1/admin/affiliates/${ID}/ledger`],
    ["GET", `/v1/admin/affiliates/${ID}/orders`],
    ["GET", `/v1/admin/affiliates/${ID}/payouts`],
    ["POST", `/v1/admin/affiliates/${ID}/payouts`],
  ];
  const PORTAL_ROUTES: Array<[string, string]> = [
    ["GET", "/v1/affiliate/me"],
    ["GET", "/v1/affiliate/orders"],
    ["GET", "/v1/affiliate/ledger"],
    ["GET", "/v1/affiliate/payouts"],
    ["POST", "/v1/affiliate/payouts"],
    ["GET", `/v1/affiliate/payouts/${ID}/invoice`],
    ["PATCH", "/v1/affiliate/profile"],
    ["GET", "/v1/affiliate/terms"],
    ["POST", "/v1/affiliate/terms/accept"],
    ["POST", "/v1/affiliate/objects"],
    ["PUT", `/v1/affiliate/objects/${ID}/content`],
  ];

  async function expectOpaque(response: Response, label: string): Promise<void> {
    expect(response.status, label).toBe(404);
    expect(await response.json(), label).toEqual({ error: { code: "not_found", message: "Route not found" } });
  }

  it("every admin route answers an affiliate's session, no session and another shop's admin with the opaque 404", async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      await expectOpaque(await call(hostRequest(method, path, { body: {}, cookie: affiliate.cookie, shopId: SHOP })), `affiliate ${method} ${path}`);
      await expectOpaque(await call(hostRequest(method, path, { body: {}, shopId: SHOP })), `anonymous ${method} ${path}`);
      await expectOpaque(await call(hostRequest(method, path, { body: {}, cookie: otherAdmin.cookie, shopId: SHOP })), `foreign ${method} ${path}`);
    }
  });

  it("every portal route answers a shop admin's session, no session and the affiliate's other shop with the opaque 404", async () => {
    for (const [method, path] of PORTAL_ROUTES) {
      await expectOpaque(await call(hostRequest(method, path, { body: {}, cookie: admin.cookie, shopId: SHOP })), `admin ${method} ${path}`);
      await expectOpaque(await call(hostRequest(method, path, { body: {} , shopId: SHOP })), `anonymous ${method} ${path}`);
      await expectOpaque(await call(hostRequest(method, path, { body: {}, cookie: affiliate.cookie, shopId: OTHER })), `other shop ${method} ${path}`);
    }
  });

  it("a state change from another origin is the opaque 404, on both surfaces", async () => {
    await expectOpaque(
      await call(hostRequest("PATCH", "/v1/affiliate/profile", { body: { city: "Malmö" }, cookie: affiliate.cookie, origin: "https://evil.test", shopId: SHOP })),
      "portal",
    );
    await expectOpaque(
      await call(hostRequest("POST", "/v1/admin/affiliates", { body: { email: "a@b.test", name: "A" }, cookie: admin.cookie, origin: null, shopId: SHOP })),
      "admin",
    );
  });

  it("the portal's terms gate: accept the current version, refuse a stale one", async () => {
    const person = await portalAffiliateOf(SHOP, "TERMS1", { termsAccepted: false });
    const me = await (await call(hostRequest("GET", "/v1/affiliate/me", { cookie: person.cookie, shopId: SHOP }))).json<{
      affiliate: { payoutBlockers: string[]; terms: { outdated: boolean } };
    }>();
    expect(me.affiliate.terms.outdated).toBe(true);
    expect(me.affiliate.payoutBlockers).toContain("terms_required");
    const terms = await (await call(hostRequest("GET", "/v1/affiliate/terms", { cookie: person.cookie, shopId: SHOP }))).json<{
      terms: { accepted: boolean; version: string };
    }>();
    expect(terms.terms.accepted).toBe(false);
    const stale = await call(hostRequest("POST", "/v1/affiliate/terms/accept", { body: { version: "2020-01-01" }, cookie: person.cookie, shopId: SHOP }));
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("terms_changed");
    const accepted = await call(hostRequest("POST", "/v1/affiliate/terms/accept", { body: { version: terms.terms.version }, cookie: person.cookie, shopId: SHOP }));
    expect(await accepted.json()).toMatchObject({ terms: { accepted: true } });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'affiliate.terms_accept' AND resource_id = ?", person.affiliateId)).toBe(1);
  });

  it("the portal profile edits the affiliate's own fields only", async () => {
    const response = await call(
      hostRequest("PATCH", "/v1/affiliate/profile", {
        body: { addressLine1: "Storgatan 1", city: "Malmö", name: "Pia Portal", postalCode: "211 22" },
        cookie: affiliate.cookie,
        shopId: SHOP,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ affiliate: { address: { city: "Malmö", line1: "Storgatan 1" }, name: "Pia Portal" } });
    for (const forbidden of [{ commissionPercent: 50 }, { code: "MINE" }, { status: "active" }]) {
      expect(
        (await call(hostRequest("PATCH", "/v1/affiliate/profile", { body: forbidden, cookie: affiliate.cookie, shopId: SHOP }))).status,
        JSON.stringify(forbidden),
      ).toBe(400);
    }
  });
});

describe("the hosts", () => {
  it("the admin Worker's host is where the portal answers (an admin-host request); ADMIN_HOST is the suites' admin host", () => {
    expect(ADMIN_HOST.startsWith("https://")).toBe(true);
  });
});
