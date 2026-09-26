/**
 * The container's environment contract. Everything is validated at start and a
 * bad value is FATAL (exit 78, EX_CONFIG): a container that cannot authenticate or
 * does not know where the API is must not start polling with a guess.
 *
 *   RENDER_API_URL       required  bare https origin of the API (no path, no slash)
 *   RENDER_FARM_TOKEN    required  ≥ 32 chars; the bearer the API checks on /v1/render
 *   IDLE_EXIT_SECONDS    optional  10–3600, default 120: stop polling after this long idle
 *   MAX_CONCURRENT_JOBS  optional  1–4, default 1
 */
export const CONTAINER_PORT = 8080;
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_IDLE_EXIT_SECONDS = 120;
export const DEFAULT_MAX_CONCURRENT_JOBS = 1;

export interface RenderConfig {
  apiUrl: string;
  idleExitMs: number;
  maxConcurrentJobs: number;
  token: string;
}

export type ConfigResult = { config: RenderConfig; ok: true } | { invalid: string[]; ok: false };

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

function bareHttpsOrigin(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    const url = new URL(raw);
    // `origin === raw` rejects any path (even "/"), query, fragment, userinfo and
    // non-canonical spelling in one comparison — the API's own origins.ts rule.
    return url.protocol === "https:" && url.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

/** Names the invalid variables, never their values. */
export function readConfig(env: Record<string, string | undefined>): ConfigResult {
  const invalid: string[] = [];

  const apiUrl = bareHttpsOrigin(env.RENDER_API_URL);
  if (apiUrl === null) invalid.push("RENDER_API_URL");

  const token = env.RENDER_FARM_TOKEN;
  const tokenOk = typeof token === "string" && token.length >= MIN_TOKEN_LENGTH && !/\s/.test(token);
  if (!tokenOk) invalid.push("RENDER_FARM_TOKEN");

  const idleSeconds = boundedInt(env.IDLE_EXIT_SECONDS, DEFAULT_IDLE_EXIT_SECONDS, 10, 3_600);
  if (idleSeconds === null) invalid.push("IDLE_EXIT_SECONDS");

  const maxJobs = boundedInt(env.MAX_CONCURRENT_JOBS, DEFAULT_MAX_CONCURRENT_JOBS, 1, 4);
  if (maxJobs === null) invalid.push("MAX_CONCURRENT_JOBS");

  if (invalid.length > 0 || apiUrl === null || !tokenOk || idleSeconds === null || maxJobs === null) {
    return { invalid, ok: false };
  }
  return {
    config: {
      apiUrl,
      idleExitMs: idleSeconds * 1_000,
      maxConcurrentJobs: maxJobs,
      token: token as string,
    },
    ok: true,
  };
}
