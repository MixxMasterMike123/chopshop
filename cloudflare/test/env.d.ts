import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      // Pinned by vitest.config.ts so the suites do not depend on which
      // environment section of wrangler.jsonc carries the vars.
      APP_ENV: string;
      AUTH_BASE_URL: string;
      AUTH_TRUSTED_ORIGINS: string;
      SERVICE_NAME: string;

      BETTER_AUTH_SECRET: string;
      BOOTSTRAP_TOKEN: string;
      // Test-only values: https://api.test.invalid / https://web.test.invalid.
      CANONICAL_ORIGINS: unknown;
      // Test-only; the consumer suites inject a fake fetch, so no test ever
      // presents this key to api.resend.com.
      EMAIL_FROM: string;
      RESEND_API_KEY: string;
      // Queue producers bound by the miniflare test config.
      EMAIL_QUEUE: Queue;
      OUTBOX_QUEUE: Queue;
      RENDER_JOBS_QUEUE: Queue;
      // Legacy producer; bound only while wrangler.jsonc still declares it.
      AUTH_EMAIL_QUEUE: Queue | undefined;
      // Provided by the miniflare test config only; the deploy config has no
      // R2 binding until the buckets are provisioned.
      PRIVATE_BUCKET: R2Bucket;
      // Not bound in tests: nothing reads them yet.
      PRODUCTION_BUCKET: R2Bucket | undefined;
      PUBLIC_BUCKET: R2Bucket | undefined;
      R2_ACCESS_KEY_ID: string;
      R2_ACCOUNT_ID: string;
      // The CP1 buckets are EU-jurisdiction; the suites presign against the
      // .eu. host by default and override to prove the plain-host fallback.
      R2_JURISDICTION: "eu";
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
