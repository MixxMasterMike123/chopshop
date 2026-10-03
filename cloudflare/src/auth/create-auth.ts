import { betterAuth } from "better-auth";

import { PLATFORM_DISPLAY_NAME } from "../email/auth-email-job";
import { readCanonicalOrigins } from "../lib/origins";
import {
  enqueuePasswordResetEmail,
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
  resetPageOrigins,
} from "./password-reset";

const MINIMUM_SECRET_LENGTH = 32;

export function isAuthConfigured(env: Env): boolean {
  return (
    typeof env.BETTER_AUTH_SECRET === "string" &&
    env.BETTER_AUTH_SECRET.length >= MINIMUM_SECRET_LENGTH
  );
}

function trustedOrigins(env: Env): string[] {
  const origins = env.AUTH_TRUSTED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error("AUTH_TRUSTED_ORIGINS must contain at least one origin");
  }

  // The canonical reset pages are trusted by definition: the reset link's
  // redirect lands on one of them (CP5: the ADMIN page for an ordinary reset
  // and a tenant admin's invite, the platform page for a platform user's;
  // while the allowlist does not list `admin` they resolve to the web origin),
  // and Better Auth
  // validates that redirect against this list. Adding them here rather than
  // relying on AUTH_TRUSTED_ORIGINS to repeat them keeps one source of truth for
  // "the web app's origins". A missing or malformed allowlist adds nothing —
  // and the reset routes are dark anyway.
  const canonical = readCanonicalOrigins(env);
  for (const origin of canonical === null ? [] : resetPageOrigins(canonical)) {
    if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }

  return origins;
}

export function createAuth(env: Env) {
  if (!isAuthConfigured(env)) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  return betterAuth({
    advanced: {
      ipAddress: {
        // The client address Better Auth's own limiter keys on. Its default is
        // X-Forwarded-For, which a caller can set to anything — every forged
        // value a fresh bucket, so its sign-in and reset limits were
        // bypassable. CF-Connecting-IP is set by Cloudflare's edge and is the
        // same header src/lib/rate-limit.ts trusts. Without it (a request that
        // did not come through the edge) Better Auth falls back to one shared
        // bucket, which is stricter, never looser.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    appName: PLATFORM_DISPLAY_NAME,
    baseURL: env.AUTH_BASE_URL,
    database: env.DB,
    emailAndPassword: {
      // Better Auth defaults autoSignIn to TRUE, which makes signUpEmail mint a
      // session row and return its token. Sign-up is not mounted as an HTTP
      // surface here, so the ONLY callers of the server-side signUpEmail are the
      // one-time platform bootstrap and platform user provisioning — and neither
      // delivers that token to anyone. The session it created was therefore a
      // pure orphan: a live credential row for a user who has never signed in,
      // counted against nobody, expiring only on its own schedule, and making
      // the session table misstate who currently holds access.
      //
      // Turning it off means signUpEmail provisions an identity and nothing
      // else. Every provisioned user reaches a session the same way any other
      // user does: through the mounted sign-in route. This governs SIGN-UP only
      // — sign-in still creates sessions normally, which is pinned by test
      // rather than taken from the documentation.
      autoSignIn: false,
      enabled: true,
      requireEmailVerification: false,
      // One hour, matching the lifetime of the email job that carries it.
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // Never sends inline: records a ledger row and enqueues the job for the
      // `-email` consumer (src/auth/password-reset.ts). The link is rebuilt
      // there from the token and the canonical origins; the `url` Better Auth
      // offers is ignored on purpose.
      sendResetPassword: async ({ token, user }) => {
        await enqueuePasswordResetEmail(env, {
          recipient: user.email,
          token,
        });
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    secret: env.BETTER_AUTH_SECRET,
    session: {
      cookieCache: {
        enabled: false,
      },
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    trustedOrigins: trustedOrigins(env),
    verification: {
      storeIdentifier: "hashed",
    },
  });
}
