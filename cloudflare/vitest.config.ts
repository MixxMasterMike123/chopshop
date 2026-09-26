import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = decodeURIComponent(
        new URL("./migrations", import.meta.url).pathname,
      );
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            BETTER_AUTH_SECRET:
              "test-only-better-auth-secret-at-least-32-characters",
            BOOTSTRAP_TOKEN:
              "test-only-bootstrap-token-at-least-32-characters",
            // Test-only, and never a real key: the payment route's gate only
            // asks whether a key EXISTS, and every test injects a fake gateway
            // rather than the SDK, so no test can reach api.stripe.com. The
            // sk_test_ shape is cosmetic — it documents that this surface is
            // test mode only.
            STRIPE_SECRET_KEY: "sk_test_fake-key-for-workers-tests-only",
            // Test-only signing secret. Unlike the API key this one is USED for
            // real: the webhook suite signs its payloads with the SDK's own
            // generateTestHeaderStringAsync against this value and lets the
            // production constructEventAsync verify them, so the real
            // verification code runs under test rather than being stubbed out.
            STRIPE_WEBHOOK_SECRET: "whsec_fake-signing-secret-for-tests-only",
            // The six POD values. Test-only and never real: every suite injects
            // a fake farm client through the symbol seam, so no test performs
            // HTTP to a render farm, and the presigner (when not overridden)
            // signs against these credentials producing URLs no test ever
            // dereferences. The gate only asks whether all six EXIST.
            R2_ACCESS_KEY_ID: "test-only-r2-access-key-id-value",
            R2_ACCOUNT_ID: "test0account0id0for0workers0test",
            R2_PRIVATE_BUCKET_NAME: "meteorshop-test-private",
            R2_SECRET_ACCESS_KEY: "test-only-r2-secret-access-key-value",
            RENDER_FARM_TOKEN: "test-only-render-farm-token-32-chars",
            RENDER_FARM_URL:
              "https://render-farm.test.invalid/renderFarmProcessArtwork",
            TEST_MIGRATIONS: migrations,
          },
          // Test-only: the deploy config has no R2 binding yet, so the object
          // store must be exercised against a local bucket.
          r2Buckets: ["PRIVATE_BUCKET"],
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
