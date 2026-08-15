import { describe, expect, it } from "vitest";

import { isSameOriginRequest } from "../src/lib/same-origin";

function requestWithOrigin(url: string, origin: string | null): Request {
  return new Request(url, {
    headers: origin === null ? {} : { origin },
    method: "POST",
  });
}

describe("isSameOriginRequest", () => {
  it("accepts an Origin that matches the request origin exactly", () => {
    expect(
      isSameOriginRequest(
        requestWithOrigin(
          "https://admin.same-origin.test/v1/admin/products",
          "https://admin.same-origin.test",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["missing", null],
    ["opaque", "null"],
    ["empty", ""],
    ["cross-site", "https://evil.test"],
    ["scheme mismatch", "http://admin.same-origin.test"],
    ["port mismatch", "https://admin.same-origin.test:8443"],
    ["subdomain mismatch", "https://other.same-origin.test"],
    ["origin with trailing slash", "https://admin.same-origin.test/"],
  ])("rejects a %s Origin", (_label, origin) => {
    expect(
      isSameOriginRequest(
        requestWithOrigin("https://admin.same-origin.test/v1/admin/products", origin),
      ),
    ).toBe(false);
  });
});
