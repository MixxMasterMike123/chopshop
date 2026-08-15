import { betterAuth } from "better-auth";

const MINIMUM_SECRET_LENGTH = 32;

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
  if (env.BETTER_AUTH_SECRET.length < MINIMUM_SECRET_LENGTH) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  return betterAuth({
    appName: "MeteorShop",
    baseURL: env.AUTH_BASE_URL,
    database: env.DB,
    emailAndPassword: {
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
