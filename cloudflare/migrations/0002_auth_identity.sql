PRAGMA foreign_keys = ON;

-- Core schema compiled from Better Auth 1.6.29 using its native D1 adapter.
CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- Live authorization records are deliberately separate from session claims.
CREATE TABLE identity_access (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (
    account_type IN ('ordinary', 'tenant_admin', 'platform_admin', 'print_operator')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE tenant_memberships (
  membership_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'customer', 'b2b_customer', 'affiliate')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, user_id, role)
);

CREATE TRIGGER tenant_memberships_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_memberships
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TABLE print_memberships (
  membership_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, user_id)
);

CREATE TRIGGER print_memberships_tenant_immutable
BEFORE UPDATE OF tenant_id ON print_memberships
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX identity_access_type_status_idx ON identity_access(account_type, status);
CREATE INDEX tenant_memberships_user_status_idx ON tenant_memberships(user_id, status);
CREATE INDEX tenant_memberships_tenant_role_status_idx ON tenant_memberships(tenant_id, role, status);
CREATE INDEX print_memberships_user_status_idx ON print_memberships(user_id, status);
CREATE INDEX print_memberships_tenant_status_idx ON print_memberships(tenant_id, status);
