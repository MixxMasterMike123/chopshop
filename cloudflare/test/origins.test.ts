import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  CanonicalOriginsError,
  canonicalOrigin,
  parseCanonicalOrigins,
  readCanonicalOrigins,
} from "../src/lib/origins";

const VALID = {
  api: "https://api.test.invalid",
  web: "https://web.test.invalid",
};

function withOrigins(value: unknown): Env {
  return { ...env, CANONICAL_ORIGINS: value } as Env;
}

describe("canonical origin allowlist", () => {
  it("reads both surfaces from the test binding (an object var)", () => {
    expect(canonicalOrigin(env, "api")).toBe("https://api.test.invalid");
    expect(canonicalOrigin(env, "web")).toBe("https://web.test.invalid");
  });

  it("accepts the same value delivered as a JSON string", () => {
    expect(parseCanonicalOrigins(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("accepts an explicit non-default port", () => {
    expect(
      parseCanonicalOrigins({ ...VALID, web: "https://web.test.invalid:8443" })
        .web,
    ).toBe("https://web.test.invalid:8443");
  });

  it("returns a frozen value", () => {
    expect(Object.isFrozen(parseCanonicalOrigins(VALID))).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a number", 42],
    ["an array", [VALID.api, VALID.web]],
    ["unparseable JSON", "{api:"],
    ["a JSON string of a string", JSON.stringify("https://api.test.invalid")],
    ["missing web", { api: VALID.api }],
    ["missing api", { web: VALID.web }],
    ["an unknown key", { ...VALID, admin: "https://admin.test.invalid" }],
    ["an empty origin", { ...VALID, web: "" }],
    ["a non-string origin", { ...VALID, web: 443 }],
    ["http", { ...VALID, web: "http://web.test.invalid" }],
    ["a path", { ...VALID, web: "https://web.test.invalid/shop" }],
    ["a trailing slash", { ...VALID, web: "https://web.test.invalid/" }],
    ["a query", { ...VALID, web: "https://web.test.invalid?x=1" }],
    ["a fragment", { ...VALID, web: "https://web.test.invalid#top" }],
    ["credentials", { ...VALID, web: "https://user:pw@web.test.invalid" }],
    ["an explicit default port", { ...VALID, api: "https://api.test.invalid:443" }],
    ["uppercase host", { ...VALID, api: "https://API.test.invalid" }],
    ["not a URL", { ...VALID, api: "api.test.invalid" }],
    ["a javascript: URL", { ...VALID, web: "javascript:alert(1)" }],
  ])("fails closed for %s", (_label, value) => {
    expect(() => parseCanonicalOrigins(value)).toThrow(CanonicalOriginsError);
    expect(() => canonicalOrigin(withOrigins(value), "web")).toThrow(
      CanonicalOriginsError,
    );
    expect(readCanonicalOrigins(withOrigins(value))).toBeNull();
  });

  it("never echoes the offending value in its error", () => {
    try {
      parseCanonicalOrigins({ ...VALID, web: "https://attacker.example/x" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalOriginsError);
      expect(String(error)).not.toContain("attacker.example");
    }
  });
});
