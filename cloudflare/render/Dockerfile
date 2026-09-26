# The render container (DECISIONS D6). Built by `wrangler deploy` from this file
# (wrangler.jsonc → containers[].image = "./render/Dockerfile"); Cloudflare
# Containers run linux/amd64 images, so both stages pin that platform — a build
# on an arm64 laptop then produces the image that will actually run.
#
# No compile stage: Node 22 runs the TypeScript sources directly with type
# stripping (tsconfig.json keeps every construct erasable). No secrets here —
# RENDER_API_URL and RENDER_FARM_TOKEN arrive at start as envVars from the
# Worker's RenderContainer Durable Object.

# ── deps: production dependencies only (sharp + its prebuilt linux-x64 libvips) ──
FROM --platform=linux/amd64 node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ── runtime ──
FROM --platform=linux/amd64 node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Root-owned and read-only to the process: the non-root user can run the code but
# not change it. Job files go to the per-job temp dir under /tmp.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/main.ts"]
