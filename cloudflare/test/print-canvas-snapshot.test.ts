import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { createCheckout, type CreateCheckoutInput } from "../src/commerce/checkout";
import { createMapping } from "../src/pod/pod-mappings";
import { replacePrinters } from "../src/pod/printers";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import {
  adminOf,
  PLATFORM,
  seedArtwork,
  seedPrinter,
  seedProduct,
  seedProfile,
  seedTenant,
  TEE_S,
  testCapabilities,
  testPrinter,
} from "./pod-fixtures";

/**
 * CP6-PS2, the money path: the three fields the snapshot gained per print
 * slot (frameMm, frameProvisional, sourcePx) are production facts only. With
 * and without their inputs (the artwork's measured pixels, the model's
 * stand-in flag, the frame's offset), every amount the checkout writes is the
 * same to the byte: the checkout row's money columns, each line's cost and
 * withholding, the totals.
 */

const TENANT = "tenant-canvas-snap";
const HOST = "canvas-snap.podtest.test";
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };
const NEW_KEYS = ["frameMm", "frameProvisional", "sourcePx"];

function input(): CreateCheckoutInput {
  return {
    deliveryMethod: "shipping",
    discountCode: null,
    email: "buyer@podtest.test",
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    items: [
      { productId: "plain-mug", quantity: 1 },
      { productId: "canvas-tee", quantity: 3 },
    ],
    shippingCountry: "SE",
  };
}

interface Frozen {
  money: Record<string, unknown>;
  snapshotJson: string;
}

async function checkoutOnce(): Promise<Frozen> {
  const result = await createCheckout(env.DB, CONTEXT, input(), Date.now(), {
    dispatchTarget: "fake-printer",
  });
  expect(result.status).toBe("ok");
  const checkoutId = result.status === "ok" ? result.checkout.checkoutId : "";
  const row = await env.DB.prepare(
    `SELECT currency, subtotal_minor, shipping_minor, vat_minor, vat_rate_bp,
            discount_minor, total_minor, production_snapshot_json
     FROM checkouts WHERE checkout_id = ?`,
  )
    .bind(checkoutId)
    .first<Record<string, unknown> & { production_snapshot_json: string }>();
  if (row === null) {
    throw new Error("no checkout");
  }
  const { production_snapshot_json: snapshotJson, ...money } = row;
  return { money, snapshotJson };
}

/** The snapshot without the CP6-PS2 keys, serialised in its own key order. */
function withoutNewKeys(snapshotJson: string): string {
  const snapshot = JSON.parse(snapshotJson) as {
    lines: Array<{ printFiles: Array<Record<string, unknown>> }>;
  };
  for (const line of snapshot.lines) {
    line.printFiles = line.printFiles.map((file) =>
      Object.fromEntries(Object.entries(file).filter(([key]) => !NEW_KEYS.includes(key))),
    );
  }
  return JSON.stringify(snapshot);
}

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await seedProfile();
  await seedPrinter();
  await seedArtwork(TENANT, { artworkId: "canvas-front" });
  await seedArtwork(TENANT, { artworkId: "canvas-back", fileName: "back.png" });
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "live-1", published: true });
  await seedProduct(TENANT, { productId: "live-2", published: true });
  await seedProduct(TENANT, { productId: "plain-mug", priceMinor: 12_900, published: true });
  await seedProduct(TENANT, { productId: "canvas-tee", priceMinor: 39_900 });
  for (const [artworkId, slot] of [["canvas-front", "front"], ["canvas-back", "back"]] as const) {
    const mapped = await createMapping(env.DB, ADMIN, {
      artworkId,
      printerId: "fake-printer",
      productId: "canvas-tee",
      sku: TEE_S,
      slots: [slot],
      variantId: null,
    }, Date.now());
    expect(mapped.status).toBe("ok");
  }
  expect((await publishAdminProduct(env.DB, ADMIN, "canvas-tee", Date.now())).status).toBe("ok");
});

describe("the snapshot's new print-slot fields change no amount (CP6-PS2)", () => {
  it("freezes the frame, the stand-in flag and the pixels, and the money is byte-identical without their inputs", async () => {
    const withInputs = await checkoutOnce();
    const files = (JSON.parse(withInputs.snapshotJson) as {
      lines: Array<{ printFiles: Array<Record<string, unknown>> }>;
    }).lines[0]?.printFiles;
    expect(files?.map((file) => [file.slot, file.frameMm, file.frameProvisional, file.sourcePx])).toEqual([
      ["front", { h: 400, offsetTopMm: 30, w: 300 }, false, { h: 4_724, w: 3_543 }],
      ["back", { h: 450, offsetTopMm: 40, w: 300 }, false, { h: 4_724, w: 3_543 }],
    ]);

    // Change every input of the new fields: other measured pixels (a 'ready'
    // artwork always has them, 0012's CHECK), a stand-in model, no offsets.
    // Frames keep their size (eligibility).
    await env.DB.prepare(
      "UPDATE pod_artwork SET width_px = 5000, height_px = 6000 WHERE tenant_id = ?",
    )
      .bind(TENANT)
      .run();
    const capabilities = testCapabilities();
    const tee = capabilities.models["2000"];
    if (tee === undefined) {
      throw new Error("fixture model missing");
    }
    capabilities.models["2000"] = {
      ...tee,
      printAreasMm: { back: { h: 450, w: 300 }, front: { h: 400, w: 300 } },
      provisional: true,
    };
    expect(await replacePrinters(env.DB, PLATFORM, [testPrinter({ capabilities })], Date.now())).not.toBeNull();

    const withoutInputs = await checkoutOnce();
    const changedFiles = (JSON.parse(withoutInputs.snapshotJson) as {
      lines: Array<{ printFiles: Array<Record<string, unknown>> }>;
    }).lines[0]?.printFiles;
    expect(changedFiles?.map((file) => [file.frameMm, file.frameProvisional, file.sourcePx])).toEqual([
      [{ h: 400, w: 300 }, true, { h: 6_000, w: 5_000 }],
      [{ h: 450, w: 300 }, true, { h: 6_000, w: 5_000 }],
    ]);

    // Every amount, to the byte.
    expect(JSON.stringify(withoutInputs.money)).toBe(JSON.stringify(withInputs.money));
    expect(withoutNewKeys(withoutInputs.snapshotJson)).toBe(withoutNewKeys(withInputs.snapshotJson));
    const money = (json: string) => {
      const snapshot = JSON.parse(json) as {
        lines: Array<{ productionCostMinor: number; withholdMinor: number }>;
        totals: unknown;
      };
      return JSON.stringify({
        lines: snapshot.lines.map((line) => [line.productionCostMinor, line.withholdMinor]),
        totals: snapshot.totals,
      });
    };
    expect(money(withoutInputs.snapshotJson)).toBe(money(withInputs.snapshotJson));
    // (60 + 40 + 40 + 40) × 3 = 540 kr ex; + 49 kr printer shipping once.
    expect(JSON.parse(money(withInputs.snapshotJson))).toEqual({
      lines: [[54_000, 67_500]],
      totals: { productionCostMinor: 58_900, withholdMinor: 73_625 },
    });
  });
});
