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
