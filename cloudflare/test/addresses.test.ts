import { describe, expect, it } from "vitest";

import { addressSlug, productPath as catalogProductPath } from "../src/catalog/admin-catalog";
import { PAGE_SLUG_PATTERN, pagePath as contentPagePath } from "../src/content/pages";
import {
  ALL_PRODUCTS_PATH,
  categoryPath,
  collectionPath,
  encodePathSegment,
  HOME_PATH,
  pagePath,
  productPath,
  slugify,
  tagPath,
} from "../src/storefront/addresses";

/**
 * CP4-K — THE address grammar lives in one module (src/storefront/addresses.ts).
 *
 * Before the merge each duplicate was run against its twin over the inputs
 * below (docs/cf-port/CP4_K_REPORT.md, step 1): builder A's slug rule
 * (`addressSlug`, `categoryKey`, `productTagKey`) and builder D's `slugify`
 * gave the same answer for every one, and so did A's and D's `productPath`.
 * Builder C's `pagePath` and D's did not (C's does not encode), so those two
 * stay apart and are pinned against each other here.
 */

const LONG_LATIN = "x".repeat(10_000);
const LONG_SWEDISH = `${"Å ".repeat(3_000)}🎉`;

/** [input, its slug] — the inputs of the comparison before the merge. */
const SLUGS: ReadonlyArray<readonly [string, string]> = [
  ["Rökt & Gött", "rokt-and-gott"],
  ["Ärlig Åsa ÖL", "arlig-asa-ol"],
  ["åäö ÅÄÖ", "aao-aao"],
  ["UPPER CASE", "upper-case"],
  ["Tee & Co", "tee-and-co"],
  ["&", "-and-"],
  ["a  b\tc\nd", "a-b-c-d"],
  ["  kant  ", "kant"],
  ["🎉 fest 🎉", "-fest-"],
  ["👍", ""],
  ["", ""],
  ["!!!", ""],
  ["-_-", "-_-"],
  ["?#/%", ""],
  ["---", "-"],
  ["a/b", "ab"],
  ["tee_A B(1)", "tee_a-b1"],
  [LONG_LATIN, LONG_LATIN],
  [LONG_SWEDISH, "a-".repeat(3_000)],
];

describe("the slug rule", () => {
  it.each(SLUGS.map(([input, slug], index) => [index, input, slug] as const))(
    "input #%i",
    (_index, input, slug) => {
      expect(slugify(input)).toBe(slug);
    },
  );

  it("is the one A's module re-exports, not a copy", () => {
    expect(addressSlug).toBe(slugify);
    expect(catalogProductPath).toBe(productPath);
  });
});

describe("the paths", () => {
  it("encode one segment: encodeURIComponent plus !'()*", () => {
    expect(encodePathSegment("!'()*")).toBe("%21%27%28%29%2A");
    expect(encodePathSegment("🎉")).toBe("%F0%9F%8E%89");
    expect(encodePathSegment("a/b?c#d")).toBe("a%2Fb%3Fc%23d");
    expect(encodePathSegment("-._~")).toBe("-._~");
  });

  it("build the grammar's addresses", () => {
    expect(HOME_PATH).toBe("/");
    expect(ALL_PRODUCTS_PATH).toBe("/produkter");
    expect(productPath("tee_A B(1)")).toBe("/product/tee_A%20B%281%29");
    expect(productPath("Rökt & Gött")).toBe("/product/R%C3%B6kt%20%26%20G%C3%B6tt");
    expect(productPath("a/b")).toBe("/product/a%2Fb");
    expect(collectionPath("nytt")).toBe("/samling/nytt");
    expect(collectionPath("år")).toBe("/samling/%C3%A5r");
    expect(pagePath("om-oss")).toBe("/om-oss");
    expect(pagePath("Tee & Co")).toBe("/Tee%20%26%20Co");
  });

  it("name a category or a tag by its slug, and nothing that slugifies to nothing", () => {
    expect(categoryPath("Rökt & Gött")).toBe("/kategori/rokt-and-gott");
    expect(categoryPath("🎉 fest 🎉")).toBe("/kategori/-fest-");
    expect(tagPath("Nyhet")).toBe("/tagg/nyhet");
    expect(tagPath("Sommar 2026")).toBe("/tagg/sommar-2026");
    for (const [input, slug] of SLUGS) {
      expect(categoryPath(input)).toBe(slug === "" ? null : `/kategori/${encodePathSegment(slug)}`);
      expect(tagPath(input)).toBe(slug === "" ? null : `/tagg/${encodePathSegment(slug)}`);
    }
  });
});

describe("the two page paths kept apart", () => {
  it("agree on every slug the pages table admits", () => {
    const admitted = ["a", "om-oss", "forsta-inlagget", "a1-b2", "9", "x".repeat(100)];
    for (const slug of admitted) {
      expect(PAGE_SLUG_PATTERN.test(slug), slug).toBe(true);
      expect(contentPagePath(slug)).toBe(pagePath(slug));
    }
  });

  it("differ on text the pages table refuses: the content module does not encode", () => {
    const differing = SLUGS.map(([input]) => input).filter(
      (input) => contentPagePath(input) !== pagePath(input),
    );
    // 15 of the 19 inputs; the four that agree hold nothing to encode.
    expect(differing).toHaveLength(15);
    for (const input of ["", "-_-", "---", LONG_LATIN]) {
      expect(contentPagePath(input)).toBe(pagePath(input));
    }
    expect(contentPagePath("Rökt & Gött")).toBe("/Rökt & Gött");
    expect(pagePath("Rökt & Gött")).toBe("/R%C3%B6kt%20%26%20G%C3%B6tt");
    for (const input of differing) {
      expect(PAGE_SLUG_PATTERN.test(input), input).toBe(false);
    }
  });
});
