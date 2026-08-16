interface Env {
  // Deployed as a Worker secret; absent until the auth checkpoint provisions
  // it, so every reader must treat "not configured" as "no session possible".
  BETTER_AUTH_SECRET: string | undefined;

  // Deployed as a Worker secret; absent until the owner sets it to mint the
  // first platform admin, so every reader must treat "not configured" as
  // "the bootstrap route does not exist".
  BOOTSTRAP_TOKEN: string | undefined;

  // Private object bucket. Absent from wrangler.jsonc until the buckets are
  // provisioned, so every delivery path must fail closed when it is undefined.
  PRIVATE_BUCKET: R2Bucket | undefined;
}
