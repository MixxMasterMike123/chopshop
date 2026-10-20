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

### 2.6 Open question: which print area is the real one (MUST be decided)

Prodigi lists several regional variants per colour and size. The EU variant of Gildan 64000, 5000 and BC3001 reports an A4 area (2480x3507 px = 210x297 mm), the global variants 4665-4677 x 5844-5881 px (about 395x495 mm). The API does not say which variant a Swedish order is printed on, and a quote does not either. The importer chose the smallest area per model.

| Option | What the studio shows | If it is wrong |
|---|---|---|
| A. Smallest (current) | 210x297 mm for 64000, 5000, BC3001 | The real area is larger: designs are placed small, the lab's space is unused. Annoying and visible to sellers, but nothing prints wrong. |
| B. Largest | about 395x495 mm | The real area is A4: `fitPrintArea` shrinks the design, so the shirt differs from the studio preview. That is a mismatch the buyer sees, a refund or reprint claim, and Prodigi is not at fault (their error cover does not apply). |

Suggestion: keep A until checked, and check before launch: open sandbox order `ord_1186010` (64000 + 18500) in the Prodigi sandbox dashboard and read the print-ready asset size, or ask Prodigi support. If the answer is B, change the frames and re-apply the catalogue. This is a suggestion; the choice is yours.

## 3. Standing facts recorded

- Their error = reprint or refund at their cost. A wrong address is ours.
- A cancellation is refused once the order is in production (about 2 minutes on the sandbox): it becomes a human alert, not an automatic refund.
- DPA: prodigi.com/dpa; listed as a sub-processor in `docs/SnapWearDocs/LAUNCH_TODO.md` row B6c. The SnapWear DPA draft is untouched.
- The live API key was pasted in chat on 2026-10-19: it must be rotated before any live use.
