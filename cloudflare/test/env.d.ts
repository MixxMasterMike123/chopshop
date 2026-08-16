import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string;
      BOOTSTRAP_TOKEN: string;
      // Provided by the miniflare test config only; the deploy config has no
      // R2 binding until the buckets are provisioned.
      PRIVATE_BUCKET: R2Bucket;
      STRIPE_SECRET_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
