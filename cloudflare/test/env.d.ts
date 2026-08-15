import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
