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
}
