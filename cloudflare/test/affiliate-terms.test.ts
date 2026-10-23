import { describe, expect, it } from "vitest";

import {
  AFFILIATE_TERMS_TEMPLATE,
  affiliateTermsSha256,
  renderAffiliateTerms,
} from "../src/affiliate/terms";

/**
 * CP13 A4 round 1: the accepted terms name no figure. An affiliate may be
 * approved at other rates and the shop may change them later, so the
 * numbered clauses refer to "the rates the shop sets, shown in the portal";
 * the rates appear only in the closing informational line. The MFL sentence
 * stays word for word (design §8).
 */

const clauses = AFFILIATE_TERMS_TEMPLATE.split("\n\n").filter((paragraph) => /^\d+\. /.test(paragraph));

describe("the affiliate terms text", () => {
  it("has eleven numbered clauses and none names a rate or a merge field for one", () => {
    expect(clauses).toHaveLength(11);
    for (const clause of clauses) {
      expect(clause, clause.slice(0, 20)).not.toMatch(/%|\{\{(commission|discount)_percent\}\}/);
    }
    expect(clauses[2]).toContain("den rabatt på varorna som butiken anger för dig och som visas i affiliateportalen");
    expect(clauses[3]).toContain("en ändring gäller köp som görs efter ändringen");
    expect(clauses[10]).toBe("11. Ändringar. Villkoren kan ändras. Nya villkor gäller för dig först när du har godkänt dem i affiliateportalen.");
  });

  it("keeps the marketing-law sentence verbatim (design §8)", () => {
    expect(AFFILIATE_TERMS_TEMPLATE).toContain(
      "Du måste tydligt märka inlägg, videor och länkar som reklam/annons (t.ex. 'Reklam' eller 'Annons') enligt marknadsföringslagen; vilseledande påståenden om produkterna är inte tillåtna",
    );
  });

  it("shows the affiliate's own rates only in the informational line", () => {
    const text = renderAffiliateTerms({ commissionBp: 1_250, discountBp: 2_000, shopName: "Kents Kaffe", supportEmail: null });
    const paragraphs = text.split("\n\n");
    const info = paragraphs.at(-1) ?? "";
    expect(info).toBe(
      "Information (inte en del av villkoren): just nu gäller 20 % rabatt till köparen och 12,5 % provision till dig. Aktuella nivåer visas alltid i affiliateportalen.",
    );
    expect(paragraphs.filter((paragraph) => paragraph.includes("%"))).toEqual([info]);
    expect(text).toContain("Frågor om villkoren: kontakta butiken");
    expect(text).not.toContain("{{");
  });

  it("hashes the template, so no rate moves the accepted version's sha", async () => {
    expect(await affiliateTermsSha256()).toBe("bff6a1379f0ee0ddfb10d8d14879ae8ca5c0b801c8a10fe475a4b435550fc2b3");
  });
});
