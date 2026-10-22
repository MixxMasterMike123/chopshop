# Prodigi: the money decision (for Mikael)

Written 2026-10-19 (CP11, unit U6). Source numbers: `CP11_U4_REPORT.md`, `prodigi-pricing-2026-10-19.json` (sandbox quotes, destination SE, Standard shipping, EUR ex VAT, one front print included, back print free). Nothing here is deployed. Quotes move with stock: a price today is not a promise.

## 1. Facts that shape the money

- Prodigi chooses the lab (Poland `pl1` or the Netherlands `nl2`, by colour and stock). It cannot be pinned. Both labs ship tracked.
- Shipping is per Prodigi order, and we send one Prodigi order per OUR order: first item EUR 11.85 from PL, EUR 5.35 from NL, EUR 1.00 for each extra item.
- Unit prices (highest EU-lab quote per model, which is what the importer prices with): 64000 EUR 11.00 (PL 8.00 for 144 SKUs, NL 10.68-11.00 for 10), 5000 12.00 (PL 8.00, NL 10-12), 2000 13.00, 64V00 11.00, STTU169 14.00, 18500 20.00, JH001 21.00, JH030 20.00 (NL 17.00 for 25 SKUs), BC3001 25.00 (most colours 10-12).
- Swedish VAT is added by Prodigi on top and is reclaimable. Payment is by card at production.
- Tees carry no packing slip (only the 18500 hoodie gets a free black-and-white slip). Parcels are white-label with the lab's return address: the shop's name appears only in our mails and storefront.
- 213 of 1,322 SKUs quote today from a non-EU lab (UK or Australia): other shipping, possible customs. They are in the catalogue with `lab` named.

## 2. Decisions to take

### 2.1 Shipping figure: withhold the PL figure per order (recommended)

**DECIDED 2026-10-20 (Mikael): superseded by a LIVE quote at checkout — the quoted shipping (all shipments) + buffer is passed through to the buyer and withheld; the flat PL figure stays only as the fallback when the quote is unavailable. Brief: `CP11_BRIEFS.md` §U9 (D9, D12).**

Set the Prodigi printer's `shippingCostMinor` to the PL first-item price, converted to SEK and buffered (section 2.3). One flat amount per order, withheld once, as for SnapWear. Reason: PL is the dearer lab, so a NL-routed order over-collects (about EUR 6.50) and that covers the cases below. The seller still sees one number only.

### 2.2 Accept the mixed-lab under-collection (recommended, but it is a loss you choose)

**Moot once §U9 is built: the quote prices every shipment, so a split order collects both fees. Applies to the fallback path only.**

An order whose items are made in both labs is charged both shipping fees: 11.85 + 5.35 = EUR 17.20 against the EUR 11.85 withheld, so we are short about EUR 5.35 (roughly 60 SEK). Every extra item also costs EUR 1.00 that the flat figure does not cover. The over-collection on NL-only orders offsets some of it; no figure is known for how often each happens. The alternative (withhold the sum for the worst case) over-charges every single-lab order and makes the seller's price look worse than it is. Suggestion: accept, then read the real charges on the first 20 live orders and adjust.

### 2.3 EUR to SEK rate and buffer: NOT YET CHOSEN

**DECIDED 2026-10-20 (Mikael): buffer = max(EUR 0.50, 5 %) on unit cost and on shipping separately, in EUR before conversion; rate default 11.20; all three are platform settings (migration 0058) reviewed monthly. §U9 D10.**

The importer deliberately does not fix them: `applyPricingEur` carries only `baseEurCents`; `eurSek` and `bufferBp` are given when the catalogue is applied. **What must be chosen:** (a) the rate, (b) the buffer in basis points, (c) when the rate is reviewed.

Suggested default (a suggestion, not a decision): rate 11.20 and buffer 500 bp (5 %), re-checked monthly. Reasoning: 11.20 with a 3 % buffer is what was used for SnapWear on 2026-09-26, so the first figure is consistent with the previous one; the buffer goes up to 5 % because the bill is a card payment in EUR (card FX margin on top of the rate) and a move of a few percent between the quote and the card charge would otherwise come out of the platform's margin. Check the actual rate on the day you apply it.

Example at those numbers (SEK, ex VAT, rounded): 64000 EUR 11.00 gives about 129; 18500 EUR 20.00 gives about 235; shipping EUR 11.85 gives about 139. A tee made in PL at EUR 8.00 is priced as 11.00, so about EUR 3 stays as margin per such tee; that is a consequence of one price per model, which is how `applyCatalog` works.

### 2.4 BC3001 priced at EUR 25.00 (decide)

The 25.00 is a few colours; most are 10-12. Pricing the whole model at the highest makes every BC3001 tee expensive. Options: a per-model override at apply time (suggestion: 12.00 and leave the few dearest colours out of the offer), or drop BC3001 at launch. Not decided here.

### 2.5 Non-EU labs (decide)

**DECIDED 2026-10-20 (Mikael): a line whose quote names a non-EU lab is refused at checkout ("Produkten kan inte levereras just nu"); no customs pricing. §U9 D11.**

213 SKUs may be made in the UK or Australia. Suggestion: leave them out of the offer at launch (no customs data, different shipping), or accept them knowing the flat shipping figure is wrong for them (lab uk9: EUR 21.78 first item; AU: EUR 21.46 + 7.46 per extra). The importer keeps them with `lab` named; filtering is not built.

### 2.6 Print area: RESOLVED 2026-10-21 (the EU variant)

Prodigi support, 2026-10-21: "For orders shipping to Sweden, please use the EU product variant and its corresponding print-area dimensions when preparing your artwork. We recommend referring to the EU variant's printAreaSizes values returned by the API."

Decision: the importer uses the EU variant's `printAreaSizes` (the variant whose `shipsTo` has no `US` and is the smallest set, the 30-country European list); a model without one falls back to the smallest SE-shipping area and is flagged `frameRule: "smallest-fallback"` in the catalogue (64V00, JH001F, STAU773 and the four BFP posters, all unchanged by the rule).

Consequence: a Gildan 64000 printed via Prodigi EU has a 210x297 mm front (2480x3507 px), far smaller than the 300x400 / 390x490 mm SnapWear frames. Every artist's design is placed in an A4-class area. The studio uses the routed printer's area, so it shows this automatically. No catalogue frame changed with this answer (the earlier "smallest" rule gave the same numbers for every model).

Two more facts from the same support mail:
- Prodigi has no hex/RGB colour codes for its colours. The studio's colour swatches need our own mapping.
- Prodigi's blank product photos may be used only if presented as Prodigi products, so we use our own mockup templates, not theirs.

## 3. Standing facts recorded

- Their error = reprint or refund at their cost. A wrong address is ours.
- A cancellation is refused once the order is in production (about 2 minutes on the sandbox): it becomes a human alert, not an automatic refund.
- DPA: prodigi.com/dpa; listed as a sub-processor in `docs/SnapWearDocs/LAUNCH_TODO.md` row B6c. The SnapWear DPA draft is untouched.
- The live API key was pasted in chat on 2026-10-19: it must be rotated before any live use.
