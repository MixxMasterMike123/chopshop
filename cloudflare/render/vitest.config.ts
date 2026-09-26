import { defineConfig } from "vitest/config";

// Plain Node (not the Workers pool the parent package uses): the container runs on
// Node 22 with sharp, and so do its tests. No test reaches the network — every
// fetch is an injected fake.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Fixture synthesis with sharp at print resolution takes a few seconds.
    testTimeout: 60_000,
  },
});
