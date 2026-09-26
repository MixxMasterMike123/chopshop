import { betterAuth } from "better-auth";

const MINIMUM_SECRET_LENGTH = 32;

export function isAuthConfigured(env: Env): boolean {
  return (
    typeof env.BETTER_AUTH_SECRET === "string" &&
    env.BETTER_AUTH_SECRET.length >= MINIMUM_SECRET_LENGTH
  );
}

function trustedOrigins(value: string): string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error("AUTH_TRUSTED_ORIGINS must contain at least one origin");
  }

  return origins;
}

export function createAuth(env: Env) {
  if (!isAuthConfigured(env)) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  return betterAuth({
    appName: "MeteorShop",
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
      revokeSessionsOnPasswordReset: true,
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
    trustedOrigins: trustedOrigins(env.AUTH_TRUSTED_ORIGINS),
    verification: {
      storeIdentifier: "hashed",
    },
  });
}
