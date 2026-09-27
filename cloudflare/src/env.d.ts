interface Env {
  // ── THE CP1 BINDING/VAR CONTRACT (shared with the wrangler.jsonc owner) ───
  // Declared here so the code compiles against the contract rather than
  // against whichever environment `wrangler types` last generated from. Every
  // binding a surface needs is optional (`| undefined`) and that surface
  // answers a fail-closed 404 — or, for a queue consumer, retries — until it
  // exists.

  // "staging" | "production", and the Worker's name. Reported by /health.
  APP_ENV: string;
  SERVICE_NAME: string;

  // The API's own origin; Better Auth's baseURL, and the only origin an
  // auth-email action link may point at (src/email/auth-email-job.ts).
  AUTH_BASE_URL: string;

  // Comma-separated origins Better Auth accepts state-changing requests from.
  AUTH_TRUSTED_ORIGINS: string;

  // JSON object var `{ "api": "https://…", "web": "https://…" }` — the
  // per-environment canonical origin allowlist (PLAN §2.1). Typed `unknown`
  // on purpose: it is only ever read through src/lib/origins.ts, which
  // validates it and fails closed when it is missing or malformed.
  CANONICAL_ORIGINS: unknown;

  // Resend API key (Worker secret). Absent ⇒ the email consumer never
  // attempts delivery; it logs and retries the batch with a delay.
  RESEND_API_KEY: string | undefined;

  // The `from` address for transactional email, e.g.
  // "ChopShop <no-reply@example.com>". Absent or malformed ⇒ same as a
  // missing RESEND_API_KEY: no delivery attempt, retry later.
  EMAIL_FROM: string | undefined;

  // Queue producers. The consumer side is the single `queue()` export, which
  // dispatches on the SUFFIX of `batch.queue` (`-outbox`, `-email`,
  // `-render-jobs`) because the full names are environment-specific
  // (`chopshop-stg-email`, `chopshop-prod-email`, ...).
  OUTBOX_QUEUE: Queue | undefined;
  EMAIL_QUEUE: Queue | undefined;
  RENDER_JOBS_QUEUE: Queue | undefined;

  // The three storage classes (PLAN §2.5). Only PRIVATE_BUCKET is read today.
  PUBLIC_BUCKET: R2Bucket | undefined;
  PRODUCTION_BUCKET: R2Bucket | undefined;

  // Deployed as a Worker secret; absent until the auth checkpoint provisions
  // it, so every reader must treat "not configured" as "no session possible".
  BETTER_AUTH_SECRET: string | undefined;

  // Deployed as a Worker secret; absent until the owner sets it to mint the
  // first platform admin, so every reader must treat "not configured" as
  // "the bootstrap route does not exist".
  BOOTSTRAP_TOKEN: string | undefined;

  // Private object bucket. Bound in staging, but any environment without its
  // buckets provisioned lacks the binding, so every delivery path must still
  // fail closed when it is undefined.
  PRIVATE_BUCKET: R2Bucket | undefined;

  // Deployed as a Worker secret; absent until the owner sets a TEST-MODE Stripe
  // key, so every reader must treat "not configured" as "the payment surface
  // does not exist". Same fail-closed contract as BETTER_AUTH_SECRET: staging
  // deploys dark and the surface lights up on the secret alone, with no code
  // change and no wrangler.jsonc entry (secrets are bindings-invisible).
  STRIPE_SECRET_KEY: string | undefined;

  // Deployed as a Worker secret; absent until the owner creates the Stripe
  // webhook endpoint and copies its signing secret here, so every reader must
  // treat "not configured" as "the webhook surface does not exist". Same
  // fail-closed contract as STRIPE_SECRET_KEY, and for a sharper reason: this
  // secret IS the authentication on that surface — there is no session, no
  // origin check, and no tenant hostname behind it, only the signature. A
  // webhook endpoint that answered without a secret would be an unauthenticated
  // order-creation surface.
  STRIPE_WEBHOOK_SECRET: string | undefined;

  // Worker SECRET, optional: the signing secret of the second Stripe webhook
  // endpoint, created with `connect: true`, which delivers the CONNECTED
  // accounts' events (`account.updated`). Both endpoints point at
  // /v1/webhooks/stripe; the verifier tries the platform secret first, then
  // this one. Absent ⇒ Connect-signed deliveries fail verification (400).
  // Events verified by it are acted on only when they are `account.updated`.
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;

  // Optional plain var: the platform operator's address for the 15-minute
  // alert digest (D40, runAlertDigest in src/commerce/crons.ts). Absent or
  // not an email address ⇒ no digest is built (one log line per tick). The
  // digest goes through EMAIL_QUEUE and Resend like every other mail, so it
  // also needs RESEND_API_KEY + EMAIL_FROM to be delivered.
  PLATFORM_ALERT_EMAIL?: string;

  // ── THE POD / RENDER-FARM CONFIGURATION ──────────────────────────────────
  // Six values, and the ENTIRE POD surface answers a fail-closed 404 until all
  // six exist (isPodConfigured in src/pod/render-farm-client.ts). Partial
  // configuration is not a degraded mode — a worker holding the farm's address
  // but no R2 credentials could dispatch a job whose URLs it cannot sign — so
  // the gate is all-or-nothing and runs before the method check, the path
  // parse, D1 and the rate limiter.

  // The render farm's endpoint URL. Deployed as a Worker SECRET rather than a
  // var: it is set with `wrangler secret put` alongside the others so the whole
  // surface lights up on secrets alone with no wrangler.jsonc change, and the
  // address of a compute endpoint is not something a repository should carry.
  RENDER_FARM_URL: string | undefined;

  // The shared secret the farm authenticates the platform with — the same value
  // held in Firebase Secret Manager as RENDER_FARM_TOKEN. Sent as
  // `Authorization: Bearer`; the farm compares it in constant time. Since CP1-C
  // it ALSO authenticates the farm to this worker on the pull surface
  // (/v1/render/*, src/routes/render-jobs.ts), which requires it to be ≥ 32
  // characters and stays a 404 otherwise.
  RENDER_FARM_TOKEN: string | undefined;

  // R2 S3-API credentials. Required because R2 BINDINGS CANNOT PRESIGN: an
  // R2Bucket has get/put/head/delete and no signing capability, while the farm
  // will only fetch from and PUT to `.r2.cloudflarestorage.com` hosts. The
  // bytes must therefore move directly between the farm and R2's S3 endpoint,
  // and this worker must sign those URLs.
  R2_ACCESS_KEY_ID: string | undefined;
  R2_SECRET_ACCESS_KEY: string | undefined;

  // The account id the S3 endpoint hostname is built from
  // (`https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).
  //
  // A plain `var`, NOT a secret, and deliberately so: it appears in plaintext
  // inside every presigned URL this worker mints, so treating it as
  // confidential would be ceremony implying a protection it does not have. It
  // must be supplied as configuration because CLOUDFLARE EXPOSES NO ACCOUNT ID
  // TO A WORKER AT RUNTIME — there is no binding and no global, and
  // wrangler.jsonc's top-level `account_id` is a deploy-time targeting field
  // that is never injected into `env` (verified against current Cloudflare
  // documentation, 2026-08-22).
  R2_ACCOUNT_ID: string | undefined;

  // The private bucket's NAME, as opposed to PRIVATE_BUCKET which is its
  // binding. Both are needed and they are not interchangeable: the binding
  // moves bytes without credentials (used for HEAD verification and delete),
  // while the S3 path addresses the bucket by name inside a signed URL. A
  // binding carries no way to recover the name it points at.
  R2_PRIVATE_BUCKET_NAME: string | undefined;

  // The buckets' R2 jurisdiction. "eu" ⇒ presigned URLs use the
  // `{account}.eu.r2.cloudflarestorage.com` host that EU-jurisdiction buckets
  // are only reachable through; unset ⇒ the default host. Typed as the two
  // values the code accepts; any other runtime value darkens the POD surface
  // (src/pod/render-farm-client.ts) rather than being guessed at.
  R2_JURISDICTION: "eu" | undefined;

  // ── PRINTER DISPATCH (PLAN §2.3, §2.6) ─────────────────────────────────────
  // Which printer this environment dispatches to: "snapwear" (production pins
  // it; the preflight refuses anything else there) or "fake-printer" (staging).
  // Unset or any other value ⇒ resolvePrinterClient returns null and dispatch
  // holds its work (src/dispatch/printer-client.ts).
  DISPATCH_TARGET: string | undefined;

  // ── THE RENDER CONTAINER (CP1-D, DECISIONS D6) ────────────────────────────
  // Durable Object namespace of the Container-enabled class RenderContainer
  // (src/render/render-container.ts; the image is cloudflare/render/). The
  // `-render-jobs` queue consumer wakes it on every nudge. Absent (no
  // `containers` + `durable_objects` entry for this environment) ⇒ the consumer
  // acks and logs `container_not_bound`; nothing else depends on it.
  RENDER_CONTAINER:
    | DurableObjectNamespace<import("./render/render-container").RenderContainer>
    | undefined;

  // Worker SECRET, staging only: the bearer the staging fake printer route
  // (/v1/staging/fake-printer/jobs) requires, and the dispatcher presents. The
  // route is a 404 unless APP_ENV="staging", DISPATCH_TARGET="fake-printer"
  // and this is ≥ 32 characters.
  FAKE_PRINTER_TOKEN: string | undefined;
}
