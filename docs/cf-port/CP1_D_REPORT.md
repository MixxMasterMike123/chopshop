# CP1-D report — the render container on Cloudflare Containers (DECISIONS D6)

Branch `cf-port`, worker in `cloudflare/`.
- Nothing committed and nothing deployed.
- No `wrangler` command reached Cloudflare. Only local `wrangler types --check` ran, via
  `npm run check`.
- No state-changing git command ran. `git archive HEAD` was used read-only to extract
  the baseline tree.
- Docker Desktop was **not running** (no socket, no process), so the image was **not
  built**. That is noted wherever it matters below.

## Test counts

| Suite | Before | After |
|---|---|---|
| Worker `npm run check` (types:check + tsc + vitest) | **1235 / 33 files** at HEAD `7024f91` | **1246 / 34 files**, green |
| Container `cloudflare/render` `npm run check` (tsc + vitest on Node) | — | **88 / 5 files**, green |

About the baseline:
- It was verified by extracting HEAD with `git archive` and running it: 1235 tests,
  green.
- The CP1-C report (and my first in-place run) say 1229. The committed CP1-C tree
  already has 6 more tests: `render-jobs.test.ts` has 68 and `pod-artwork.test.ts` 111,
  against 64 and 109 in that report's table.
- My first in-place run also hit a **timing flake**:
  `checkout.test.ts › throttles the eleventh request…` got 201 instead of 429 under
  full-suite load. It passes alone and passed in every later full run.
- The +11 are all in the new `test/render-container.test.ts`. `vitest list` shows no
  other file's count changed.

```
worker:  ✨ Types at worker-configuration.d.ts are up to date.
          Test Files  34 passed (34)
               Tests  1246 passed (1246)
            Start at  22:58:01
            Duration  33.96s (transform 20.30s, setup 230.30s, import 2.10s, tests 25.86s, environment 2ms)
render:   Test Files  5 passed (5)
               Tests  88 passed (88)
            Start at  22:58:36
            Duration  14.69s (transform 283ms, setup 0ms, import 527ms, tests 17.60s, environment 0ms)
```

Other checks:
- `node guard/guards.test.mjs`: PASS, baseline unchanged. The guard reads tracked files
  only, so I ran the same three regexes over all 36 new and changed files (docs included): clean.
- The image holds no Firebase code. The pipeline is ported, not copied, and the only
  production dependency is `sharp`.
- Worker `npm audit`: unchanged (the same 6 pre-existing findings). The new
  `@cloudflare/containers@0.3.7` has **zero** transitive dependencies (7 lock lines).
- Container production deps: **0 vulnerabilities**, after bumping sharp 0.35.3 → 0.35.4
  (see "Divergences").

## Files

**New: the container (`cloudflare/render/`)**

| File | What |
|---|---|
| `Dockerfile` | Two stages (`npm ci --omit=dev`, then runtime), both `--platform=linux/amd64`, `node:22-bookworm-slim`, `USER node`, `EXPOSE 8080`. No compile stage: Node 22 runs the `.ts` with `--experimental-strip-types`. |
| `.dockerignore` | Only `package*.json` and `src/` reach the image. |
| `package.json`, `package-lock.json` | `sharp` 0.35.4 (exact). Dev: `typescript` 7.0.2, `vitest` 4.1.10, `@types/node` 22.20.4. The lock carries `@img/sharp-linux-x64` and `@img/sharp-libvips-linux-x64`, so `npm ci` in the amd64 image installs the right binaries. |
| `tsconfig.json`, `vitest.config.ts` | Typecheck only (`erasableSyntaxOnly`, `.ts` imports). Tests run on plain Node. |
| `src/contract.ts` | The wire contract. **Pure: no Node API, no import.** The farm's envelope validator ported, the host allowlist, the lease fields, and the builders for the complete and fail bodies. The Worker's own suite imports it. |
| `src/pipeline.ts` | The sharp pipeline, ported (see below). |
| `src/transfer.ts` | Streamed download to disk under a byte cap; streamed PUT with Content-Length and sha256 over exactly the bytes sent; `redirect: "error"`. |
| `src/api.ts` | The `/v1/render` client: bearer, 30 s timeouts, acquire back-off (429 honours `Retry-After`; 404 waits 30 s), reports retried only on no answer, 429 or 5xx. |
| `src/worker.ts` | The loop and the job runner. |
| `src/control.ts` | `GET /healthz`, `POST /wake`; a pure handler. |
| `src/config.ts` | The env contract; fails closed with exit 78. |
| `src/log.ts` | JSON lines to stdout. |
| `src/metrics.ts` | VmHWM and VmRSS; resets the peak via `/proc/self/clear_refs`. |
| `src/main.ts` | The entrypoint; SIGTERM drains jobs in flight for up to 120 s. |
| `test/*.test.ts` | pipeline 20, contract 30, transfer 7, config+control 17, worker 14. |
| `bench/bench.ts` | The benchmark harness (`docs/cf-port/RENDER_BENCHMARK.md`). |

**New: the Worker side**

| File | What |
|---|---|
| `src/render/render-container.ts` | `RenderContainer extends Container<Env>` with `defaultPort` 8080 and `sleepAfter` `"5m"`. `envVars` come from `renderContainerEnvVars(env)`. RPC `wake()` runs `startAndWaitForPorts` then `POST /wake`. `onActivityExpired` asks `/healthz` first; `onStop` logs. |
| `src/render/wake.ts` | `wakeRenderContainer(env)` → `not_bound` / `not_configured` / `woken`. |
| `test/render-container.test.ts` | 11 tests: the consumer with a fake DO namespace, the env contract, and the **cross-package contract** (below). |

**Changed**

| File | Change |
|---|---|
| `src/pod/render-jobs-queue.ts` | The consumer now wakes the container: one wake per batch. The binding is optional. |
| `src/queues.ts` | `await handleRenderJobsQueueBatch(batch, env)`. |
| `src/env.d.ts` | `RENDER_CONTAINER: DurableObjectNamespace<RenderContainer> \| undefined`. |
| `test/env.d.ts` | The same binding, for the test pool. |
| `test/render-jobs.test.ts` | The CP1-C nudge test. It now passes an explicitly unbound env and compares acks as a set: order changed, because malformed messages are acked as read and valid ones after the wake. It also asserts `container_not_bound`. |
| `vitest.config.ts` | `exclude: render/**` (the container's Node suites never run in workerd). The pool's `chopshop-test-render-jobs` **consumer is removed** (see "Test pool" below). |
| `package.json`, `package-lock.json` | `@cloudflare/containers` 0.3.7, exact. |

**New docs:** this report and `docs/cf-port/RENDER_BENCHMARK.md`.

## For the reviewer to apply

These are not my files. Apply them in this order.

### 1. `wrangler.jsonc` — inside `env.staging`, after `queues`

`containers` and `durable_objects` are **not inherited** from the top level (wrangler
schema). `migrations` goes in each env, keeping every section self-contained as this
config already is.

```jsonc
      // CP1-D (DECISIONS D6): the render container. wrangler builds ./render/Dockerfile at
      // deploy — Docker must be running on the deploying machine. One instance; the
      // -render-jobs consumer wakes it (src/render/wake.ts). EU placement matches the D1/R2
      // jurisdiction (D32).
      "containers": [
        {
          "class_name": "RenderContainer",
          "image": "./render/Dockerfile",
          "instance_type": "standard-1",
          "max_instances": 1,
          "constraints": { "jurisdiction": "eu" }
        }
      ],
      "durable_objects": {
        "bindings": [{ "name": "RENDER_CONTAINER", "class_name": "RenderContainer" }]
      },
      "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RenderContainer"] }]
```

**`env.production`: identical**, `max_instances: 1`. Each env deploys its own Worker
script (`chopshop-api-stg` / `chopshop-api`), so each has its own DO migration history
and both start at tag `v1`.

About the values:
- `standard-1` (½ vCPU, 4 GiB, 8 GB) is the starting point. `RENDER_BENCHMARK.md` §6 has
  the rule for moving to `basic` or `standard-2`.
- `image_build_context` defaults to the Dockerfile's directory (`render/`), so the
  `.dockerignore` there applies.
- `constraints.jurisdiction: "eu"` places the container in EEUR/WEUR only
  (https://developers.cloudflare.com/containers/concepts/placement/).

### 2. `src/index.ts` — one export

Wrangler resolves `class_name` against the main module's exports:

```ts
// The render container's Durable Object class (CP1-D, DECISIONS D6). Must be exported
// from the main module: containers[].class_name / durable_objects.bindings[].class_name
// resolve against these exports.
export { RenderContainer } from "./render/render-container";
```

Export it **by name**. A probe re-exporting through `export *` broke `exports.Internal`
in `entrypoints.test.ts`.

### 3. Regenerate and check

Run `npm run types`, which regenerates `worker-configuration.d.ts` to include
`RENDER_CONTAINER: DurableObjectNamespace<import("./src/index").RenderContainer>`. Then
run `npm run check`.

I **probed exactly this shape** without touching `wrangler.jsonc`:
- a scratch copy of the config with the block above;
- a scratch entry re-exporting `src/index` plus `RenderContainer` by name;
- the whole suite through it.

Result: 1246/1246 in the pool **without Docker**. The pool does not build the image.

### 4. Preflight (`scripts/cf-preflight.sh`, not mine)

The preflight **ignores** `durable_objects` and `containers`. It won't refuse them, and
it won't pin them either. I suggest extending `cmd_config` to require, per env:
- exactly one DO binding `RENDER_CONTAINER → RenderContainer`;
- exactly one container with `class_name: "RenderContainer"`,
  `image: "./render/Dockerfile"`, `max_instances: 1` and `jurisdiction: "eu"`;
- `migrations[].new_sqlite_classes` containing `RenderContainer`.

Pinning the instance type in `pinned.<env>.json` is optional.

### 5. Secrets and prerequisites

- **No new secret.** The container gets `RENDER_FARM_TOKEN`, the same secret the API
  checks and already ≥ 32 characters since CP1-C, as an env var at start. Nothing is
  baked into the image.
- Deploy prerequisites:
  - Docker running on the deploying machine (wrangler builds and pushes the image);
  - Containers available on Kent's account (Workers Paid);
  - the first deploy provisions for a few minutes before an instance can start (the
    package's 503 text says so).

## The container's environment contract

| Var | Set by | Rule |
|---|---|---|
| `RENDER_API_URL` | `renderContainerEnvVars`: `canonicalOrigin(env, "api")` | a bare https origin, else exit 78 |
| `RENDER_FARM_TOKEN` | the Worker secret, unchanged | ≥ 32 characters, no whitespace, else exit 78 |
| `IDLE_EXIT_SECONDS` | `"120"` | 10–3600; default 120 |
| `MAX_CONCURRENT_JOBS` | `"1"` | 1–4; default 1 |

The container serves port **8080**: `GET /healthz` →
`{ ok, polling, inFlight, jobsCompleted, jobsFailed, uptimeMs }`, and `POST /wake`.
Anything else is a 404.

If `renderContainerEnvVars` returns null (the token is under 32 or the origins are
invalid), the DO never starts the container. The consumer also checks
`isRenderJobsConfigured` first: when `/v1/render` is dark it acks with
`render_not_configured` and starts nothing.

## How it works

### The loop

- Polling starts at process start, and `/wake` re-arms it.
- While armed, the container calls `POST /v1/render/jobs/acquire`:
  - immediately after a job;
  - every **3 s** after a 204;
  - after the back-off when the API cannot answer.
- It asks only while a job slot is free, so idle polling is one request per 3 s whatever
  `MAX_CONCURRENT_JOBS` is.
- **Disarm:** after `IDLE_EXIT_SECONDS` with no lease acquired and no job running. A
  failing acquire counts as idle, so a misconfigured container stops polling on its own.

### A job

1. `parseLease`. If the envelope is malformed but the claim is intact, the container
   sends `fail invalid_envelope`. With no claim at all, it logs and lets the lease
   expire.
2. The input GET is streamed to `/tmp/render-job-*/input`. The cap is
   `min(input.maxBytes, 200 MiB)`.
3. The pipeline runs.
4. A verdict of `ok:false` is sent as `complete` with the reasons.
5. On `ok:true`, both PUTs are streamed with sha256, then `complete` is sent with
   `{ attempt, leaseToken, ok, fields, notices, outputs: { printPng: { key, sha256, bytes }, previewWebp: {…} }, metrics }`.
   The keys are `{outputPrefix}print.png` and `{outputPrefix}preview.webp`, exactly the
   set `COMPLETE_KEYS` and `parseCompletionReport` accept.
6. Any error becomes a `fail` with a code:
   - `input_fetch_failed`, `input_too_large`, `pipeline_crashed`, `output_put_failed`;
   - `completion_invalid`, sent after a 400 on `complete`, so the job requeues now
     instead of at lease expiry.
7. 404, 409 and 422 on `complete` are final: the API has already settled the job.
8. The temp dir is always removed.

### Metrics

The container sends at most 20 numbers:
- `fetchMs`, `pipelineMs`, `uploadMs`, `wallMs`;
- `inputBytes`, `printBytes`, `previewBytes`;
- `peakRssMb`, `rssMb`, `peakIsPerJob`, `jobsSinceStart`, `processUptimeMs`.

The API logs them keyed by job id, as CP1-C built.

### Logs

Logs never include the token, a URL, a response body or the lease token. The worker
test asserts that against captured output.

### Wake and sleep

- **Wake.** The queue consumer calls `RENDER_CONTAINER.get(idFromName("render")).wake()`.
  That is exactly what `getContainer()` does. It is called directly because the helper's
  `T extends Container` is typed against `Cloudflare.Env` and would erase the stub's RPC
  type.
- **Waking a sleeping instance.** `wake()` runs `startAndWaitForPorts` and **then**
  `POST /wake`. Without that re-arm, a running container whose loop had gone idle would
  not see the new job.
- **Keeping it awake.** `sleepAfter` counts only requests the DO proxies. The container's
  own outbound work (acquire, R2, sharp) is invisible to it, so the default
  `onActivityExpired` → `stop()` could kill a job mid-flight. `onActivityExpired` asks
  `/healthz` instead:
  - polling, or a job in flight: keep running (the timer renews);
  - idle: `stop()` (SIGTERM);
  - no answer twice in a row: `destroy()` (SIGKILL). A wedged process must not bill
    forever, and its lease expiry hands the job on.
- **Queue outcomes.** Binding absent: ack + `container_not_bound`. `/v1/render` dark: ack
  + `render_not_configured`. Wake threw: each nudge `retry({ delaySeconds: 30 })`, and
  malformed messages are still acked.
- **Documented behaviour this relies on**
  (https://developers.cloudflare.com/containers/reference/container-class/, and the
  package source 0.3.7):
  - `sleepAfter` defaults to 10m;
  - an override that doesn't stop the container renews the timer;
  - `envVars` is read at start (`options?.envVars ?? this.envVars`);
  - the constructor throws without the containers runtime.

### Test pool

- A Container DO cannot be constructed in vitest-pool-workers: there is no Containers
  runtime ("Containers have not been enabled…").
- With the binding configured, every real `-render-jobs` delivery would therefore fail.
  The probe showed exactly that: the CP1-C test failed, and pod-artwork logged uncaught
  errors.
- So the pool no longer auto-delivers that queue. Nudges are still **sent**, and the
  consumer is driven through `worker.queue()` with hand-built batches.
- Miniflare's option schema rejects an `undefined` DO override, so dropping the binding
  in the pool was not an option.

### The cross-package contract test

`test/render-container.test.ts` imports `render/src/contract.ts`, the file the container
runs, and drives the real routes:
- `parseLease` accepts the **real** acquire response (real SigV4 URLs on the `.eu.` host);
- the success body completes the job with the artwork `ready` and R2 verifying the
  sha256;
- the rejection body sets the artwork to `rejected`;
- **every** fail code the container can send is accepted (200 `queued`).

A drift between the two deploy units fails the Worker's gate.

## Auth trade-off (as the brief asked)

PLAN §2.6 says "Containers = private binding, no public ingress". There are two
directions, and they differ:
- **DO → container** is private: `containerFetch` on the instance's port. A Container
  has no public ingress, and the Worker never forwards requests to it.
- **Container → API** is the bearer `RENDER_FARM_TOKEN` over TLS to the API's public
  canonical origin: `/v1/render/*` on the public entrypoint, constant-time compare,
  per-IP limiter. That is the same contract the Firebase farm had.

The trade-off:
- `/v1/render` stays internet-reachable, guarded only by the token (≥ 32 characters) and
  the limiter.
- The token lives in the container's environment.

The upgrade path exists in `@cloudflare/containers` today:
- the container calls a fake host (e.g. `http://render.api`);
- `static outboundByHost = { "render.api": handler }` runs **in the Worker runtime**,
  attaches the credential, and calls the render routes in-process;
- the token never enters the container, and `/v1/render` could be removed from the
  public entrypoint.

It needs a `ContainerProxy` export from `src/index.ts` and a decision to move
`/v1/render` off the public surface (CP1-C open question 1). I did not build it.
https://developers.cloudflare.com/containers/guides/outbound-traffic/ describes it
("Securely inject credentials").

## The pipeline, and where it diverges from the Firebase farm

**What it does.** The source is `artworkPipelineCore.ts` plus `processArtworkJob.ts` on
`origin/cloudflare-migration`, read with `git show`:
- Decode by content, with no pixel limit for `metadata()`, so oversize gets the
  actionable message.
- The HEIC magic sniff, and the special-format messages (heif, pdf, svg, gif).
- Accepted-format check; dimensions measured in the EXIF display orientation;
  `px_too_large` over 10 000 px.
- Rotate, then trim (threshold 13, only with alpha, falling back to untrimmed on
  failure), then sRGB 8-bit PNG.
- The `trimmed` notice, then the **contain-fit gate**, rounding at the boundary, with
  the exact Swedish `resolution_too_low` message.
- The alpha profile on a ≤ 512 px derivative:
  - `fully_transparent` rejects;
  - `opaque` or `semi_transparent` notices only — transparency is **inform-only**;
  - the `cmyk_converted` notice;
- An 800 px `webp({ quality: 70 })` preview.
- `sharp.cache(false)`, `sharp.concurrency(1)`, `PIPELINE_VERSION` 1, and `maxPrintMm`
  rounded in the meta.

Every threshold, message and code is unchanged. The tests pin the farm's own 8 verify
cases plus the boundary (2948 px → 300 DPI passes, 2947 → 299 fails), contain on the
height axis, CMYK, semi-transparency, GIF, HEIC, garbage input, EXIF orientation 6, and
the file-too-large verdict.

**Divergences, and why:**
1. **File I/O instead of Buffers.** The input is streamed to disk and sharp reads the
   path. The print PNG and the preview are written with `toFile`. A test proves the
   bytes are **identical** to the farm's all-in-memory encode chain. Why: the compressed
   input and the encoded 45 MB print PNG never sit in the JS heap, which was the
   2026-07-27 OOM.
2. **The download cap is `min(input.maxBytes, 200 MiB)`, not the profile's
   `max_file_mb`.**
   - The farm capped at the profile size and answered 502. With the async contract that
     would be 3 failed attempts, then an alert, then a deleted artwork row: the user
     sees a 404, not "Filen är 60 MB — max 50 MB".
   - Now the file lands on disk and the pipeline's own size gate gives the Swedish
     `file_too_large` **verdict**, which the callable (`processArtwork.ts`) also gave.
     There is no memory cost, since it is on disk.
   - The Worker does not check the profile size at enqueue (`artwork-store.ts`).
3. **sharp 0.35.4, not the farm's 0.35.3.** 0.35.3 bundles a libheif with two published
   advisories (GHSA-g89c-p67h-r497, GHSA-2jg2-4ch7-h545), and this process parses
   untrusted uploads. This was an exact bump, not `audit fix --force`. The libvips patch
   level moved 8.18.3 → 8.18.6. Verdicts and meta are unchanged (all tests pass on both
   versions), but print bytes are not promised identical to a 0.35.3 render.
4. **Pull, not push.** Failures are codes on `fail`, not a constant 502. A malformed
   envelope with an intact claim is `fail invalid_envelope` (the farm answered 400).
5. **`jobId` must be a UUID.** The farm accepted any non-empty string; here it is
   interpolated into the report path.
6. **The PUT streams from disk** with explicit Content-Length (verified: Node's fetch
   then sends unchunked) and sha256 computed over the bytes sent. The farm hashed a
   buffer after the fact. A short body is detected.
7. **`redirect: "error"` is kept for every fetch.** That is correct in Node. The workerd
   TypeError from CP1-C applies only to the Worker.

## Docker build and image size

**Not run**: the Docker daemon was not running, and I did not start it. Nothing in the
image was executed.

What was verified:
- `npm run check` in `render/` (typecheck and 88 tests).
- The entrypoint smoke on this Mac under Node type stripping:
  - bad env → exit 78 naming only the variables;
  - good env → `/healthz` and `/wake` answer; the poller backs off on a refused API;
    `/wake` cuts the back-off short; SIGTERM → `drained`, exit 0;
  - no secret in the logs.

**Image size: unknown.** The production deps on top of `node:22-bookworm-slim` are about
20 MB:
- `@img/sharp-libvips-linux-x64` 18.6 MB unpacked;
- `@img/sharp-linux-x64` 0.4 MB;
- `sharp` about 1 MB;
- `src/` 80 KB.

`RENDER_BENCHMARK.md` §5 has the exact `docker build` / `docker image inspect` commands.

## Benchmark

`docs/cf-port/RENDER_BENCHMARK.md` contains:
- the caps and the fixture;
- the staging protocol for 1, 3 and 10 queued jobs and a typical upload, cold and warm:
  what to read from which log line, and a D1 correctness query;
- the cost model, from the pricing page fetched 2026-09-26;
- the Docker version of the measurement;
- proposed pass thresholds with reasons, and the decision rule;
- an empty staging results table.

**Local numbers (M1 Pro, native Node 22.14, sharp 0.35.4; not Docker, not Cloudflare):**

| Artwork | Runs | Per job | Peak RSS |
|---|---|---|---|
| Largest allowed: 10 000 × 10 000 px, 45.5 MB | 1 | 10.7 s | **539 MB** |
| Largest allowed | 10 queued, serial | ≈ 9.9 s each; drain 99.5 s | 587 MB |
| Largest allowed | 3 in parallel | ≈ 10.9 s each | 1.18 GB |
| Typical: 3 600², 0.23 MB | 1 | 0.84 s | ≈ 180 MB |

Process start to first acquire: 105 ms.

Cost, estimated:
- About **$0.0036 per isolated wake** on `standard-1`, dominated by the ~300 s idle tail,
  not the render.
- 75 wakes a month fit inside the Workers Paid memory allowance on `standard-1`; 300 on
  `basic`.

## Open questions

1. **Instance type.** Locally the peak is ~0.55 GB, which would fit `basic` (1 GiB, ¼
   vCPU) at about a third of the cost. The staging run decides, per §6. Start on
   `standard-1`?
2. **glibc fragmentation.** macOS showed no growth across 10 jobs. Linux glibc can
   fragment libvips allocations, and sharp's docs recommend jemalloc for long-lived
   processes. If staging `peakRssMb` creeps across a scenario-C run, add `libjemalloc2`
   and `LD_PRELOAD`. Not added blind.
3. **`sleepAfter` "5m" and `IDLE_EXIT_SECONDS` 120.** Upload sessions are bursty, and
   the idle tail is most of the cost. 2m/60s would cut the per-wake cost about 2.5×, at
   the price of more cold starts. Decide after staging §7.
4. **A stranded queued job.** If every wake retry fails (8 queue retries × 30 s), the
   row stays `queued` until the next nudge. The CP2 15-minute sweeper should re-nudge
   (or wake directly) when any job has been `queued` for more than N minutes. Not built:
   the cron is not in my files.
5. **The auth upgrade** (outbound interception, `/v1/render` off the public surface):
   now, or with CP1-C open question 1?
6. **Base image pinning.** `node:22-bookworm-slim` is a floating tag. Pin it by digest
   once a Docker host can resolve it.
7. **The preflight** should pin the new sections (item 4 of "For the reviewer to
   apply").
8. **Pinned versus farm bytes.** Canonical output keys are immutable and unversioned
   (CP1-C open question 7). A re-render of an old artwork on 0.35.4 would produce
   different bytes and hit `canonical_conflict`. That only matters if version-2
   reprocessing is ever built.

---

## Codex fixes (after `dfe7269`)

All four findings are fixed in my files, each with regression tests.
- Nothing was committed and no `wrangler` command reached Cloudflare.
- `wrangler.jsonc` and `src/pod/render-jobs.ts` are untouched.
- Where this section contradicts the text above, this section wins: `/healthz` now also
  carries `leaseHoldMs`, and a report is retried until the lease runs short, not three
  times.

**Counts:**

| Suite | Before | After |
|---|---|---|
| Worker | 1246 / 34 files | **1262 / 34**. All +16 in `test/render-container.test.ts` (11 → 27). |
| Container | 88 / 5 files | **121 / 6**. New `test/api.test.ts` has 25; `worker.test.ts` 14 → 21; `config-control.test.ts` 17 → 18. |

```
worker:  ✨ Types at worker-configuration.d.ts are up to date.
          Test Files  34 passed (34)
               Tests  1262 passed (1262)
            Start at  23:26:45
            Duration  34.77s (transform 24.81s, setup 236.32s, import 2.10s, tests 28.90s, environment 1ms)
render:   Test Files  6 passed (6)
               Tests  121 passed (121)
            Start at  23:27:22
            Duration  16.25s (transform 430ms, setup 0ms, import 1.29s, tests 22.21s, environment 1ms)
```

**Mutation checks.** Each fix was reverted in the source, its suite run, and the source
restored and verified byte-identical by sha256. **5 of 5 were killed:**

| Mutation | Tests that failed |
|---|---|
| The stale-observation guard ignored | 2 |
| `polling:false` accepted as a wake | 3 |
| `leaseHoldMs` not counted as busy | 1 |
| The loop disarms despite the hold | 4 |
| Retry-After ignored, with three fixed attempts | 4 |

The timing-based worker suite passed 5 of 5 back-to-back runs.

### 1. [P1] A job leased to the container but not held by it

`render/src/worker.ts` (THE LEASE HOLD), `render/src/api.ts`, `render/src/control.ts`.

The container now records a **lease horizon** whenever a job may be leased to it without
being worked on:
- **An acquire that may have leased:** no answer after the request was sent, an
  unreadable 200, or a 5xx (it may come after the lease batch committed). The horizon is
  the send time + `API_LEASE_MS`.
- **An envelope with no claim to report against:** the same assumed end.
- **A crashed runner:** the same assumed end.
- **A `complete` or `fail` report ultimately abandoned:** the lease's own `leaseUntil`.

The loop does **not disarm** before horizon + `LEASE_HOLD_MARGIN_MS` (60 s, for clock skew
and a few polls after expiry). It keeps polling, and the first acquire after expiry
re-leases the job as attempt+1, or ends it after attempt 3.

`/healthz` carries `leaseHoldMs`, and the Durable Object counts `leaseHoldMs > 0` as busy
(`classifyHealth`). So the instance is kept through the hold even if the loop state ever
said otherwise.

Supporting pieces:
- `API_LEASE_MS` (`render/src/contract.ts`) is pinned equal to `RENDER_JOB_LEASE_MS` by a
  Worker test.
- `AcquireResult.unavailable` gained `mayHaveLeased`. 429, 404 and other 4xx are decided
  before acquire writes D1, so they hold nothing.

One refinement beyond the finding:
- A failure while **connecting** never sent the request, so it cannot have leased. Such
  failures are logged as `acquire_unreachable` and hold nothing: `ECONNREFUSED` (also on
  the dual-stack `AggregateError`), `ENOTFOUND`, `EAI_AGAIN`, unreachable network or
  host, a rejected TLS certificate, and undici's connect timeout.
- Without this, a container pointed at a wrong or down API would extend its hold
  forever.
- The codes were probed against Node's fetch. A socket dropped after sending
  (`UND_ERR_SOCKET`) or a timeout still holds.
- A live smoke confirmed it: an unreachable API gives `acquire_unreachable`, then
  `polling_idle_exit` at 10 s, with `leaseHoldMs` 0.
- ⚠️ **For the unreachable-API smoke, use an ordinary closed port** (e.g.
  `https://127.0.0.1:54329`), not `:9`. Port 9 is on fetch's blocked-port list and fails
  without a connect code. It therefore counts as possibly sent, and the container would
  hold.

Tests (`worker.test.ts` "the lease hold", 7; `api.test.ts` acquire table, 10; the
`classifyHealth` case):
- **The finding's scenario:** a lost acquire answer, then 204s until the lease expires,
  then the same job re-leased as **attempt 2** and completed. The test asserts the loop is
  still polling past the idle window.
- A refused acquire still disarms on the idle clock.
- An abandoned completion holds until lease end + margin, and no earlier.
- An abandoned fail holds.
- An unusable envelope holds for the assumed lease.
- A settled 409 holds nothing.
- The report deadline equals `leaseUntil − REPORT_DEADLINE_MARGIN_MS`.

**The durable backstop is not this hold.** It covers a container that stays up; a
container that is stopped, crashes or is redeployed mid-hold leaves the job `leased`
until the next nudge. The backstop is the **CP2 15-minute sweeper re-nudging
expired-lease (and long-`queued`) jobs** (PLAN §2.2). Until CP2, the next upload's nudge
is the only other wake.

### 2. [P2] A stale health observation stopped a container a wake had just re-armed

New `src/render/lifecycle.ts` (`RenderLifecycle`); `src/render/render-container.ts`
delegates to it.

- `wake()` bumps a **generation** and counts itself **in flight** until it returns.
- `onActivityExpired` snapshots both before asking `/healthz`. Any overlap discards the
  answer as stale (`keep`; the timer renews and asks again next expiry): a wake running
  before, a wake running after, or a changed generation.
- From that check to the signal there is **no `await`**. `Container.stop()` and
  `destroy()` send the signal synchronously (read in `@cloudflare/containers` 0.3.7), so
  nothing can interleave with the decision.
- The logic lives outside the Durable Object because a Container DO cannot be
  constructed without the Containers runtime. `RenderContainer` is now a thin adapter
  (`startAndWaitForPorts`, `containerFetch`, `stop`, `destroy`).

Tests use a **fake container whose `/healthz` answer is observed when asked but delivered
only after a wake has re-armed it**:
- the result is `keep`, with 0 stops and the container still armed;
- a wake still in flight when the answer arrives → `keep`;
- the control case (no wake) → `stop`;
- busy → `keep`; two unanswered checks → `stop`, then `destroy`.

### 3. [P2] `/wake` answering `polling: false` was reported as woken

`src/render/lifecycle.ts`.

Only `200` with `polling: true` is a wake. Anything else throws a `RenderWakeError`:
- `polling: false`, from a container draining after SIGTERM → `render_wake_not_polling`;
- a non-200 → `render_wake_status_*`;
- an unreadable body → `render_wake_bad_body`.

`wakeRenderContainer` therefore throws, and the consumer **retries the nudges** after 30 s
instead of acking them. By then the draining instance has exited, and the retry starts a
replacement.

Tests:
- the draining case, plus 3 other failure shapes;
- **end to end**: the consumer with a fake namespace backed by `RenderLifecycle` and a
  draining fake container → both nudges retried with 30 s delay, none acked.

### 4. [P2] Report retries ignored Retry-After and gave up after ~7 s

`render/src/api.ts`.

`report(jobId, action, body, deadlineMs)`:
- **Always one attempt.** Then it retries on no answer, 429 or 5xx.
- **A 429 waits its Retry-After**, capped at 60 s (the API's window).
- **Otherwise it waits** 2 s, 5 s, then 10 s repeatedly.
- **It keeps going while each wait still ends before the deadline.** The deadline is the
  lease end minus `REPORT_DEADLINE_MARGIN_MS` (10 s), which the worker passes in. This
  replaces three fixed attempts.
- 200, 400, 404, 409 and 422 return at once.
- An exhausted report returns its last unsettled status. The worker then holds the lease
  (fix 1).

Tests (fake clock, `api.test.ts`):
- two 429s with Retry-After 40 s and 25 s, then 200 → exactly those waits;
- Retry-After 3600 → 60 s;
- a 429 without Retry-After → the back-off;
- five no-answer and 5xx failures, then 200 → past three attempts;
- 5xx until the deadline → stops with the last wait still inside the deadline, and
  returns 503;
- an expired deadline → exactly one attempt;
- settled statuses → no retry.

### Files touched in this round

| Package | Files |
|---|---|
| Container | `render/src/{api,worker,control,contract}.ts`; `render/test/{api (new),worker,config-control}.test.ts` |
| Worker | `src/render/lifecycle.ts` (new); `src/render/{render-container,wake}.ts`; `src/pod/render-jobs-queue.ts` (doc comment only); `test/render-container.test.ts` |
| Docs | this section |

Nothing else changed:
- No dependency changed.
- `worker-configuration.d.ts` is unchanged (types:check green).
- The forbidden-string scan over every touched file is clean.
