# Per-shop legal pages — auto-generation spec

Templates for the consumer-facing legal pages every shop must publish, so a "5-minute" seller
doesn't have to write their own legal text. The platform renders them per shop from seller data.

**Language note.** The page *content* is in Swedish — the buyers are Swedish consumers, so it has
to be. This spec and everything around it is in English.

**Status.** First draft. Like the contracts, these need a **lawyer's review** before they go live
on real shops. The substance is sound and current; the lawyer confirms wording and edge cases.

## The pages
1. `01-kopvillkor.md` — Köpvillkor (terms of sale). The comprehensive document.
2. `02-angerratt-och-returer.md` — Ångerrätt & returer (right of withdrawal + returns + complaints),
   the practical, consumer-facing how-to. Overlaps with §7–9 of the köpvillkor by design — they
   must stay in sync (or render both from the same shared fragments).
3. `03-integritetspolicy.md` — Integritetspolicy (privacy / GDPR).

(A cookie policy + per-shop cookie-consent config is a separate item — the inventory flagged the
CMP as hardcoded to one domain. Not covered here.)

## Core legal framing (read before wiring)

**Every seller is a trader (näringsidkare) toward the consumer — including individuals.** Someone
running a merch shop commercially is conducting business in substance, registered company or not.
So full consumer law (konsumentköplagen, distansavtalslagen, prisinformationslagen,
marknadsföringslagen) applies to **every** shop. Practical consequence: the consumer-facing terms
are **largely identical** for individual and company sellers. What actually differs is only:
- **Identity disclosure** (company shows org.nr; an individual shows name + address + contact, and
  **never** a personnummer publicly), and
- **VAT** (registered sellers charge and show 25% VAT; non-registered sellers charge no VAT).

**VAT branches on VAT-registration status, not strictly on seller type.** A company can be under
the threshold; an individual can be over it. So the platform needs a `vat_registered` boolean —
`seller_type` is only a reasonable default, not the determinant. (This is the same VAT branching
gap flagged in the capability inventory.)

**The seller is the counterparty to the consumer; the platform is the technical provider.** The
pages name the seller as the merchant. The platform appears only as the technical provider, and
(in the privacy policy) as a personuppgiftsbiträde/processor.

**Dispute resolution = ARN, not the EU ODR platform.** The EU ODR platform was discontinued on
20 July 2025 and references to it must be removed. The pages point to ARN (Allmänna
reklamationsnämnden, arn.se) and, for cross-border, the EU list of national ADR bodies
(consumer-redress.ec.europa.eu/dispute-resolution-bodies). **Never link to the ODR platform.**

## Merge fields

| Field | Meaning | Source |
|---|---|---|
| `{{shop_name}}` | Shop display name | shop config |
| `{{seller_legal_name}}` | Company name OR individual's full name | storeIdentity |
| `{{seller_address}}` | Geographic/postal address (required by distansavtalslagen) | storeIdentity |
| `{{contact_email}}` | Support/contact email | shop config |
| `{{contact_phone}}` | Optional | shop config |
| `{{org_number}}` | Org.nr — company only | storeIdentity |
| `{{vat_number}}` | Momsreg.nr — VAT-registered only | storeIdentity |
| `{{return_address}}` | Return address — **must be collected (currently MISSING)** | shop config |
| `{{platform_legal_name}}` | Platform operator legal name (technical provider / processor) | platform config |
| `{{platform_org_number}}` | Platform operator org.nr | platform config |
| `{{last_updated}}` | Version date | render time |

## Conditionals (used in the templates)

- `[[IF company]] … [[ELSE]] … [[END]]` — seller is a company vs an individual.
- `[[IF vat_registered]] … [[ELSE]] … [[END]]` — seller charges VAT vs not.
- `[[IF pod]] … [[ELSE]] … [[END]]` — shop has the print-on-demand add-on (`shops/{id}.features.pod`)
  vs a things shop. Keeps print vocabulary ("Print on Demand", "sprucket tryck", the tryckeri as a
  GDPR data recipient) out of a non-POD shop's pages. Both branches are legally EQUIVALENT — same
  rights, deadlines and contact routes; neutral wording only. `scripts/check-legal-pod-gating.mjs`
  enforces this.

## Decisions to confirm (marked ► in the templates)

1. **Controller for buyer data (privacy policy).** Recommended model: the **seller is controller**
   for end-customer data (they're the merchant); the **platform is processor**; Stripe is its own
   controller for payment data; the printer is a processor/sub-processor for fulfilment. The
   template is written this way — confirm with the lawyer. (If instead the platform is joint/sole
   controller, the privacy policy changes substantially.)
2. **VAT field.** Confirm the platform branches VAT on a `vat_registered` flag (not just
   `seller_type`), and confirm the seller-side VAT calculation in code matches (still pending the
   VAT code export). The page's VAT wording must match what the checkout actually charges.
3. **Return address.** These pages require `{{return_address}}`. It must be added to shop
   onboarding (the inventory has it MISSING). Until collected, the pages can't render correctly.
4. **Withdrawal vs product type.** The withdrawal text distinguishes standard products (14-day
   withdrawal) from personalized/made-to-order products (no withdrawal). Whether a given product is
   personalized is a per-product flag (`isPersonalized`), not per-shop — the page explains both and
   each product page states which applies. Keep this consistent with the checkout gate already
   built.

## How to wire it (suggested)
- Render each page per shop at publish time (or on the fly), filling merge fields and evaluating
  conditionals.
- Let the seller preview the generated pages before going live; allow them to *add* extra info but
  not remove the mandatory legal content.
- Stamp `{{last_updated}}` and keep a version so changes are traceable.
- Link all three from the shop footer (the footer already renders seller identity).
