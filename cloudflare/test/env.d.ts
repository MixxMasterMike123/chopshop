import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string;
      BOOTSTRAP_TOKEN: string;
      // Provided by the miniflare test config only; the deploy config has no
      // R2 binding until the buckets are provisioned.
      PRIVATE_BUCKET: R2Bucket;
      R2_ACCESS_KEY_ID: string;
      R2_ACCOUNT_ID: string;
      R2_PRIVATE_BUCKET_NAME: string;
      R2_SECRET_ACCESS_KEY: string;
      RENDER_FARM_TOKEN: string;
      RENDER_FARM_URL: string;
      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
