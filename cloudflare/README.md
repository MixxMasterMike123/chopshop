# ChopShop Cloudflare runtime

The `chopshop-api` Worker (Hono, Better Auth on D1, D1, R2, Queues) that replaces the Firebase backend. Plan and rules: `docs/cf-port/PLAN.md`; the CP1 resource record: `docs/cf-port/CP1_BOOTSTRAP.md`.

## Account and environments

Everything lives on Kent's Cloudflare account (`ee213082783ec86585150e876edb6107`). `wrangler.jsonc` has two environments and deliberately no top-level bindings or vars:

| env | Worker | D1 | R2 (EU jurisdiction) | Queues |
|---|---|---|---|---|
| `staging` | `chopshop-api-stg` (workers.dev) | `chopshop-stg` | `chopshop-stg-{public,private,production}` | `chopshop-stg-{outbox,email,render-jobs}` |
| `production` | `chopshop-api` (no workers.dev) | `chopshop-prod` | `chopshop-prod-{public,private,production}` | `chopshop-prod-{outbox,email,render-jobs}` |

`pinned.<env>.json` is the source of truth for every id, name and canonical origin; the preflight refuses when `wrangler.jsonc` disagrees with it.

## The only way to reach Cloudflare

```sh
scripts/cf-preflight.sh <staging|production> [--bootstrap] -- <wrangler args…>   # from the repo root
```

It injects the project token from `~/.config/chopshop/cloudflare.env`, proves the token sees exactly Kent's account, checks `wrangler.jsonc` against the pinned file (and Stripe against `~/.config/chopshop/stripe.<env>.env`), and always passes `--env`. Never run `wrangler` against the account directly; `--bootstrap` is for creating resources only.

Deploys go through `scripts/cf-deploy.sh <env>`, which refuses unless the tree is clean, HEAD is pushed and `git notes --ref=reviews` on HEAD carries `codex: PASS` and `fable: PASS` (production also `mikael: GO`).

## Secrets

Secrets never live in this repo or in `wrangler.jsonc`. They are set per environment through the preflight, **after** that environment's first gated deploy, e.g. `scripts/cf-preflight.sh staging -- secret put BETTER_AUTH_SECRET`. Run non-interactively against a Worker that does not exist yet, `secret put` silently creates a stub Worker. The values come from their owners: Stripe restricted keys and webhook secrets per env, a new Resend key, an R2 API token scoped to the EU buckets, the render-farm token, and a generated Better Auth secret. The full list is in `docs/cf-port/CP1_BOOTSTRAP.md`.

## Local validation

```sh
npm ci
npm run types        # wrangler types --env staging (bindings live under env.*)
npm run check        # types:check + tsc + vitest
```

Run `npm run types` after every binding change.
