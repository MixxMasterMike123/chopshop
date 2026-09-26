import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

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
          // Bindings live under env.staging (top level is bindings-less by design).
          environment: "staging",
        },
        miniflare: {
          bindings: {
            // Pinned here rather than inherited from wrangler.jsonc, so the
            // suites keep one fixed origin whichever environment section the
            // deploy config moves these vars into. The suites hardcode this
            // origin as AUTH_ORIGIN.
            APP_ENV: "staging",
            AUTH_BASE_URL: "https://meteorshop-stg-api.micke-ohlen.workers.dev",
            AUTH_TRUSTED_ORIGINS:
              "https://meteorshop-stg-api.micke-ohlen.workers.dev",
            SERVICE_NAME: "meteorshop-stg-api",
            // The per-env canonical origin allowlist (PLAN §2.1), as an object
            // var exactly as the deploy config declares it. .invalid is
            // reserved (RFC 2606): a link built from these can never resolve.
            CANONICAL_ORIGINS: {
              api: "https://api.test.invalid",
              web: "https://web.test.invalid",
            },
            // Test-only and never real. Every email-consumer suite injects a
            // fake fetch through the symbol seam, and outboundService below
            // refuses any request that escapes it, so this key can never be
            // presented to api.resend.com.
            RESEND_API_KEY: "re_test_only_fake_key_for_workers_tests",
            EMAIL_FROM: "ChopShop Test <no-reply@mail.test.invalid>",
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
            // The CP1 buckets were created with EU jurisdiction, so the S3
            // endpoint is {account}.eu.r2.cloudflarestorage.com. Pinned here
            // exactly as deployed; the presigner suite overrides it to prove
            // the default-host fallback.
            R2_JURISDICTION: "eu",
            R2_PRIVATE_BUCKET_NAME: "meteorshop-test-private",
            R2_SECRET_ACCESS_KEY: "test-only-r2-secret-access-key-value",
            // ≥ 32 characters: since CP1-C this token also authenticates the
            // farm TO the worker on the /v1/render pull surface.
            RENDER_FARM_TOKEN: "test-only-render-farm-token-32-chars",
            // CP1-C dispatch: the staging shape (the reviewer adds
            // DISPATCH_TARGET="fake-printer" to env.staging.vars and
            // FAKE_PRINTER_TOKEN as a staging secret). Test-only token; the
            // suites override both to prove the route dark in every other
            // configuration.
            DISPATCH_TARGET: "fake-printer",
            FAKE_PRINTER_TOKEN: "test-only-fake-printer-token-32-characters",
            RENDER_FARM_URL:
              "https://render-farm.test.invalid/renderFarmProcessArtwork",
            TEST_MIGRATIONS: migrations,
          },
          // The three CP1 queues, under test-only names that keep the
          // production suffixes (`-email`, `-outbox`, `-render-jobs`) the
          // single queue() export dispatches on.
          queueProducers: {
            EMAIL_QUEUE: { queueName: "chopshop-test-email" },
            OUTBOX_QUEUE: { queueName: "chopshop-test-outbox" },
            RENDER_JOBS_QUEUE: { queueName: "chopshop-test-render-jobs" },
          },
          // No consumer for chopshop-test-render-jobs, deliberately (CP1-D): a
          // delivered nudge wakes the RenderContainer Durable Object, and the pool
          // has no Containers runtime — once wrangler.jsonc binds RENDER_CONTAINER,
          // every artwork created in a suite would construct a Container the pool
          // cannot run. Nudges are still SENT (and asserted where it matters); the
          // consumer itself is driven directly through worker.queue() with
          // hand-built batches (test/render-container.test.ts, render-jobs.test.ts).
          queueConsumers: {
            "chopshop-test-email": { maxBatchSize: 10, maxRetries: 8 },
            "chopshop-test-outbox": { maxBatchSize: 10, maxRetries: 8 },
          },
          // No test reaches the network. Every third-party client (Stripe, the
          // render farm, Resend) is replaced by a fake through its seam; this
          // is the backstop that makes a missed seam fail loudly instead of
          // quietly calling a real API with a fake key.
          outboundService: (request: Request) =>
            new Response(
              `outbound network is disabled in tests: ${new URL(request.url).host}`,
              { status: 599 },
            ),
        },
      };
    }),
  ],
  test: {
    // render/ is the render CONTAINER's own Node package (sharp, node:fs): its
    // suites run under plain Node with `npm test` in render/, never in workerd.
    exclude: [...configDefaults.exclude, "render/**"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
