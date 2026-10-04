import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { createCheckout, type CheckoutOptions, type CreateCheckoutInput } from "../src/commerce/checkout";
import { createMapping, resolveProductionLine } from "../src/pod/pod-mappings";
import { replacePrinters } from "../src/pod/printers";
import type { TenantContext } from "../src/tenancy/resolve-tenant";
import { buyerRecipientShipping } from "./legal-fixtures";
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
 * CP6-PS3 part 1 — with the print canvas on (PRINT_CANVAS_ENABLED), dispatch
 * refuses to print a stand-in frame (src/dispatch/print-canvas.ts canvasFrame:
 * terminal `print_canvas_frame_provisional`), so checkout refuses such a line
 * BEFORE payment, exactly as it refuses any POD line that cannot be produced.
 * With the switch off or unset (production today) nothing changes, to the
 * byte: the same cart is accepted with the same money and the same snapshot.
 */

const TENANT = "tenant-stand-in";
const HOST = "stand-in.podtest.test";
const ORIGIN = `https://${HOST}`;
const ADMIN = adminOf(TENANT);
const CONTEXT: TenantContext = { domainKind: "storefront", hostname: HOST, tenantId: TENANT };

function input(items: CreateCheckoutInput["items"] = [
  { productId: "plain-mug", quantity: 1 },
  { productId: "stand-in-tee", quantity: 2 },
]): CreateCheckoutInput {
  return {
    deliveryMethod: "shipping",
    discountCode: null,
    email: "buyer@podtest.test",
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    items,
    shippingCountry: "SE",
  };
}

/** The tee's model (2000) as a stand-in, or with its real frames; the frames keep their size. */
async function setStandIn(standIn: boolean): Promise<void> {
  const capabilities = testCapabilities();
  const tee = capabilities.models["2000"];
  if (tee === undefined) {
    throw new Error("fixture model missing");
  }
  capabilities.models["2000"] = standIn ? { ...tee, provisional: true } : tee;
  expect(await replacePrinters(env.DB, PLATFORM, [testPrinter({ capabilities })], Date.now())).not.toBeNull();
}

interface Frozen {
  money: string;
  snapshotJson: string;
}

async function checkoutOnce(options: CheckoutOptions): Promise<Frozen> {
  const result = await createCheckout(env.DB, CONTEXT, input(), Date.now(), options);
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
  return { money: JSON.stringify(money), snapshotJson };
}

async function written(): Promise<{ audits: number; checkouts: number; items: number }> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM checkouts WHERE tenant_id = ?1) AS checkouts,
            (SELECT COUNT(*) FROM checkout_items WHERE tenant_id = ?1) AS items,
            (SELECT COUNT(*) FROM audit_events WHERE tenant_id = ?1 AND action = 'checkout.create') AS audits`,
  )
    .bind(TENANT)
    .first<{ audits: number; checkouts: number; items: number }>();
  return row ?? { audits: -1, checkouts: -1, items: -1 };
}

function standInFlags(snapshotJson: string): boolean[] {
  const snapshot = JSON.parse(snapshotJson) as {
    lines: Array<{ printFiles: Array<{ frameProvisional: boolean }> }>;
  };
  return snapshot.lines.flatMap((line) => line.printFiles.map((file) => file.frameProvisional));
}

function httpCheckout(canvas: string | undefined): Promise<Response> {
  const body = {
    consent: { terms: true },
    deliveryMethod: "shipping",
    email: "http@podtest.test",
    idempotencyKey: `idem-http-${crypto.randomUUID()}`,
    items: [{ productId: "stand-in-tee", quantity: 1 }],
    recipient: buyerRecipientShipping("SE"),
    shippingCountry: "SE",
  };
  const targetEnv = { ...env, PRINT_CANVAS_ENABLED: canvas } as unknown as Env;
  return worker.fetch(
    new Request(`${ORIGIN}/v1/checkout`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    targetEnv,
  );
}

beforeAll(async () => {
  await seedTenant(TENANT, HOST);
  await seedProfile();
  await seedPrinter();
  await seedArtwork(TENANT, { artworkId: "stand-in-front" });
  await seedArtwork(TENANT, { artworkId: "stand-in-back", fileName: "back.png" });
  // Past D8's first-N (test/screening.test.ts owns that rule).
  await seedProduct(TENANT, { productId: "live-1", published: true });
  await seedProduct(TENANT, { productId: "live-2", published: true });
  await seedProduct(TENANT, { productId: "plain-mug", priceMinor: 12_900, published: true });
  await seedProduct(TENANT, { productId: "stand-in-tee", priceMinor: 39_900 });
  for (const [artworkId, slot] of [["stand-in-front", "front"], ["stand-in-back", "back"]] as const) {
    const mapped = await createMapping(env.DB, ADMIN, {
      artworkId,
      printerId: "fake-printer",
      productId: "stand-in-tee",
      sku: TEE_S,
      slots: [slot],
      variantId: null,
    }, Date.now());
    expect(mapped.status).toBe("ok");
  }
  expect((await publishAdminProduct(env.DB, ADMIN, "stand-in-tee", Date.now())).status).toBe("ok");
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit_windows").run();
});

describe("checkout and a stand-in frame (CP6-PS3)", () => {
  it("switch off or unset: a cart on a stand-in frame is accepted, money and snapshot byte-identical", async () => {
    await setStandIn(true);
    const unset = await checkoutOnce({ dispatchTarget: "fake-printer" });
    const off = await checkoutOnce({ dispatchTarget: "fake-printer", refuseStandInFrames: false });

    expect(standInFlags(unset.snapshotJson)).toEqual([true, true]);
    expect(off.money).toBe(unset.money);
    expect(off.snapshotJson).toBe(unset.snapshotJson);
    // (60 + 40 + 40 + 40) × 2 = 360 kr ex; + 49 kr printer shipping once.
    const snapshot = JSON.parse(unset.snapshotJson) as {
      lines: Array<{ productionCostMinor: number; withholdMinor: number }>;
      totals: unknown;
    };
    expect(snapshot.lines.map((line) => [line.productionCostMinor, line.withholdMinor])).toEqual([[36_000, 45_000]]);
    expect(snapshot.totals).toEqual({ productionCostMinor: 40_900, withholdMinor: 51_125 });
  });

  it("switch on: the same cart is refused before anything is written, as an unproducible line is", async () => {
    await setStandIn(true);
    const before = await written();

    const result = await createCheckout(env.DB, CONTEXT, input(), Date.now(), {
      dispatchTarget: "fake-printer",
      refuseStandInFrames: true,
    });

    expect(result).toEqual({ status: "invalid_items" });
    expect(await written()).toEqual(before);
    // The plain line alone is still sold: only the stand-in line is refused.
    expect(
      (await createCheckout(env.DB, CONTEXT, input([{ productId: "plain-mug", quantity: 1 }]), Date.now(), {
        dispatchTarget: "fake-printer",
        refuseStandInFrames: true,
      })).status,
    ).toBe("ok");
  });

  it("switch on: a cart on real frames is accepted, byte-identical to the switch off", async () => {
    await setStandIn(false);
    const off = await checkoutOnce({ dispatchTarget: "fake-printer" });
    const on = await checkoutOnce({ dispatchTarget: "fake-printer", refuseStandInFrames: true });

    expect(standInFlags(on.snapshotJson)).toEqual([false, false]);
    expect(on.money).toBe(off.money);
    expect(on.snapshotJson).toBe(off.snapshotJson);
  });

  it("the route reads the switch exactly ('true' only): 422 with it, 201 without", async () => {
    await setStandIn(true);
    for (const value of [undefined, "false", "TRUE", " true", "1"]) {
      const response = await httpCheckout(value);
      expect(response.status, String(value)).toBe(201);
    }

    const before = await written();
    const refused = await httpCheckout("true");
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toEqual({
      error: { code: "unprocessable", message: "Request could not be processed" },
    });
    expect(await written()).toEqual(before);

    await setStandIn(false);
    expect((await httpCheckout("true")).status).toBe(201);
  });

  it("the one-line reader keeps its behaviour: a stand-in frame is frozen, never refused", async () => {
    await setStandIn(true);
    const line = await resolveProductionLine(
      env.DB,
      TENANT,
      { productId: "stand-in-tee", quantity: 1, variantId: null },
      "fake-printer",
    );
    expect(line?.printFiles.map((file) => file.frameProvisional)).toEqual([true, true]);
  });
});
