/**
 * quotePodCost — the seller's production cost for a design as ONE number
 * (A13, "seller sees ONE number", Mikael 2026-09-25).
 *
 * Before A13 the Design Studio computed this itself from printers/{uid}
 * (blank + per-slot print prices) — which meant every seller could read the
 * printer's price list and, by subtraction, the platform's cut. The tiers are
 * now platform-only; the studio asks here and gets back
 *
 *   { costSek: number|null, printerUid: string|null }
 *
 * costSek = routed tier cost + PLATFORM_CUT_SEK, EX moms — exactly the
 * itemCostSek stampRouting freezes at payment (printRouting.quoteRoutedCost is
 * that one expression), so the "Inköp" the seller prices against and the cost
 * later withheld in the Connect fee agree. Per ITEM, no shipping: shipping is
 * inside the order-level "Avgift".
 *
 * AUTH: requireAdminOfShop(shopId). The shopId comes from the payload, which is
 * fine HERE (unlike a mutation, where it must come from the resource): the
 * quote reads no shop data, so the check only establishes "an admin, asking
 * for their own shop" — a shop admin cannot pass another shop's id.
 * No pod-flag check (plan §2): a non-POD shop just gets null for a garment
 * nobody routes, and the studio is pod-gated client-side anyway.
 *
 * Reads go through loadPrintRoutingInputs — the SAME loader the payment-time
 * snapshot uses — so quote and freeze never read routing two different ways.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { appUrls } from '../config/app-urls';
import { requireAdminOfShop } from '../email-orchestrator/functions/authGuard';
import { loadPrintRoutingInputs } from '../print/printProjection';
import { quoteRoutedCost } from '../print/printRouting';
import { parseQuoteInput } from './quoteInput';

const OPTS = { region: 'us-central1', memory: '256MiB', cors: appUrls.CORS_ORIGINS } as const;

export const quotePodCost = onCall(OPTS, async (request) => {
  const input = parseQuoteInput(request.data);
  if (typeof input === 'string') throw new HttpsError('invalid-argument', input);
  await requireAdminOfShop(input.shopId, request.auth?.uid);

  const { routing, printersById } = await loadPrintRoutingInputs();
  // Only the finished number and WHO stands behind it leave the server —
  // never the tier, the per-slot prices or the cut.
  return quoteRoutedCost({ garment: input.garment, slots: input.slots, routing, printersById });
});
