interface Env {
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
  // `Authorization: Bearer`; the farm compares it in constant time.
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
}
