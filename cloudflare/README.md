# MeteorShop Cloudflare runtime

This package contains the Cloudflare replacement runtime. It is isolated from the existing Firebase application while migration work is in progress.

The checked-in Wrangler configuration targets the personal Cloudflare account as **staging/non-production only**. It must not contain secrets or production resource identifiers.

The Better Auth/D1 schema is installed, but auth HTTP routes are intentionally not mounted yet. Do not expose sign-up, sign-in, verification, or reset endpoints until tenant provisioning, live authorization guards, outbox email delivery, and a staging-only `BETTER_AUTH_SECRET` are in place.

The staging auth-email Queue is bound, but its consumer is deliberately disabled and retries every message without reading its body. Do not add a producer route or enqueue a real capability until a reviewed email provider binding and consumer replace that fail-closed handler.

## Local validation

```sh
npm ci
npm run types
npm run check
npm run deploy:dry-run
```

## Safety rules

- Never run a production deployment from this staging configuration.
- Never add secret values to `wrangler.jsonc`, source files, or `.dev.vars.example`.
- Bind Cloudflare resources directly through Wrangler; Workers must not call Cloudflare's REST API for bound services.
- Run `npm run types` after every binding change.
- Production receives its own account, resource identifiers, credentials, and reviewed configuration before cutover.
