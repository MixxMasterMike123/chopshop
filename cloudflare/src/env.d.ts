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
}
