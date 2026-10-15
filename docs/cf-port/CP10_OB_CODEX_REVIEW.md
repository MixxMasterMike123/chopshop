# CP10-OB — Codex's own interpretation of the onboarding, and its judgement of both candidates

Date: 2026-10-15 · Model: gpt-6-astra (reasoning high) via `codex exec`, read-only, with 26 images attached: the platform's mocks of 2026-10-14 (`docs/design-explorations/onboarding-2026-10-14/`, renders in `~/chopshop-export/onboarding-mocks-2026-10-14/`) and Gemini's rework of 2026-10-15 (`…/gemini-2026-10-15/`). gpt-6.1-sol was tried and refused by the ChatGPT account. The prompt is at the end.

**Fable's two corrections to the review, before anyone acts on it:** (1) "Inköp 149 kr" per garment is NOT a leak: the hard rule (2026-09-25) is that the seller sees ONE purchase price per product (Inköp) and ONE deduction per order; what must never show is the split behind it (cut, supplier, print, shipping). (2) An enskild firma's organisationsnummer is the personnummer by law and must appear on the legal pages as the seller's identity; the no-personnummer rule is about KYC and bank data, which only Stripe collects. Everything else in the review stands and is worth reading whole.

---

I would build **a resumable setup workspace that gets the owner to a real product quickly, then makes the requirements for selling explicit**. Product creation, product approval, shop publication and checkout readiness must remain separate states.

**1. The onboarding I would build**

Before setup: the invitation identifies the shop and its intended sales type. **“Välj lösenord”** activates the owner’s access. Keep any required acceptance of the platform’s service terms separate from adopting the shop’s customer-facing legal pages.

1. **“Din butik”** — Confirm the shop’s name and preset sales type; show its assigned web address, with optional logo and colour.
2. **“Välj utseende”** — Offer Nord or Sport, a headline and a short introduction; show changes in a private storefront preview.
3. **“Din första produkt”** — Branch into **“Ladda upp din första produkt”**, **“Ladda upp din första tjänst”**, or **“Designa din första t-shirt”**; show the actual item and customer price. The digital branch remains unavailable at launch.
4. **“Uppgifter och villkor”** — Collect the required seller identity and tax information, then show the generated legal pages for explicit adoption.
5. **“Ta betalt med Stripe”** — Explain the handoff, link to Stripe’s hosted onboarding and show verified status after return; illustrate the proceeds using the owner’s product.
6. **“Granska och begär publicering”** — Show the shop, unresolved requirements and who handles each; let the owner request publication, with the platform performing the final action.

On desktop, the form occupies the left side and a useful, readable preview the right. On mobile, use **“Redigera” / “Förhandsvisa”** views that preserve the same draft. During legal setup, the preview becomes the actual legal documents; during Stripe setup, it becomes the sales example and connection status.

Owners can leave, resume or work on another available task. Logo, custom copy and extensive styling are optional. Show **“Sparar…”**, **“Sparat”** or **“Kunde inte spara”** from actual save results.

Surface the gates from the beginning with one sentence:

> “Du kan skapa produkter direkt. Innan butiken öppnar behöver du godkänna villkoren och ansluta Stripe. Vi granskar också din första POD-produkt.”

“Gå live” must mean that customers can actually buy. For launch, the seller’s action should therefore be **“Begär publicering”**. After submission, say **“Vi förbereder publiceringen”**, with specific outstanding items. Show **“Butiken är öppen för köp”** only after publication, checkout readiness and at least one eligible product are confirmed.

**2. Judging the candidates**

**Candidate 1 has the stronger visual explanation of progress, but its workflow promises are unreliable.**

The growing storefront in `A1-guidad-start-steg1.png`, `A2-guidad-start-steg2.png` and `A5-guidad-start-steg5.png` makes abstract configuration tangible. The contextual legal preview in `A3-guidad-start-steg3.png` is particularly useful. The B screens offer a sensible place to resume unfinished work, and `99-live.png` gives publication a practical next action.

The consequential problems are:

| Screens | Assessment |
|---|---|
| `A1`–`A6`, `B1`–`B6` | No sales-type branching. These are POD onboarding screens presented as platform-wide onboarding. |
| `A4-guidad-start-steg4.png`, `B4-startguide-steg4.png`, `b-guide.png` | The inline personnummer/bank forms and promise of completing setup without leaving the page contradict the required hosted Stripe flow. |
| `A3-guidad-start-steg3.png`, `B3-startguide-steg3.png` | Missing VAT status, conditional VAT number and return-address handling. The editable support email conflicts with its current platform ownership. Accepting platform terms is not a substitute for explicitly adopting the generated customer-facing pages. |
| `A1-guidad-start-steg1.png`, `B1-startguide-steg1.png` | An editable-looking address and “Ledig” imply seller-controlled address selection that does not exist today. |
| `A5-guidad-start-steg5.png`, `B5-startguide-steg5.png`, `a-wizard.png` | “Inköp 149 kr” exposes a component of the deduction. Remove garment purchase-cost labels; show only the combined deduction and seller proceeds. |
| `A6-guidad-start-steg6.png`, `B6-startguide-steg6.png` | “Allt är klart” and “Gå live” conflict with the accompanying notice that the first product still needs approval. Saving a product does not make it buyable. |
| `99-live.png`, `c-live.png` | Good destination, but reachable only after real publication. The three products must come from actual inventory; QR and Instagram export are additional features, not established capabilities. |

The B previews are also too small for meaningful design decisions. They work as status thumbnails, provided **“Förhandsvisa butiken”** opens a usable view.

**Candidate 2 makes the better sequencing decision and recognises the essential branching requirement. It is still not build-ready.**

`G1-steg1-namn-butikstyp.jpg` acknowledges the three businesses. Moving product creation to step 3 gives the owner something concrete before administrative work. `G3a-steg3-fysisk-produkt.jpg` introduces relevant physical-product inputs, and `G3c-steg3-pod-tshirt.jpg` improves garment recognition over the identical shirt silhouettes in candidate 1.

Its main failures are:

| Screen | Assessment |
|---|---|
| `G1-steg1-namn-butikstyp.jpg` | Offers digital as available and treats shop type as an ordinary editable field after the shop already exists. It needs provisioning and type-change rules. |
| `G2-steg2-utseende.jpg` | The preview headline looks disabled despite containing entered text. Real content should be readable; draft status belongs in an explicit label. |
| `G3a-steg3-fysisk-produkt.jpg` | The product changes to a mug, but navigation and hero copy still describe clothing and printing. The branch has not propagated through the shop. “Pris (inkl. moms)” is premature before VAT status is known. |
| `G3b-steg3-digital-tjanst.jpg` | Presents an unsupported product model as working. “Bokningslänk / Leveransfil” also merges two distinct fulfilment mechanisms into one field. |
| `G3c-steg3-pod-tshirt.jpg` | Retains the prohibited “Inköp” prices. “Skarpt nog för tryck” must depend on the chosen print dimensions, not merely uploaded pixel dimensions. |
| `G4-steg4-foretag-villkor.jpg` | Contains unusable legal filler, inconsistent seller identification and the same missing VAT/return requirements. It cannot be treated as a legal-content specification. |
| `G5-steg5-utbetalningar.png` | Repeats the prohibited bank/personnummer collection. Duplicate step numbers and mixed ChopShop/flippin’Stuff branding show that this is an unfinished edit. |
| `G6-steg6-ga-live.jpg` | Assumes seller publication and lacks explicit waiting states. The mug image changes from `G3a`, while POD-specific hero copy remains. |

Both candidates omit important recovery states: invitation failure, interrupted uploads, save failure, Stripe cancellation or review, product rejection, and waiting for platform action. Neither establishes a mobile onboarding design simply by including a mobile-preview toggle.

**3. Put the product before legal identity and payouts**

For these invited artists, seeing their motif on a garment is the clearest demonstration of value. Candidate 1 places identity paperwork and financial verification before that moment. That creates an avoidable abandonment point: the owner must invest trust and effort before seeing the result.

Product-first also starts the first-product review earlier. The platform can review while the owner completes legal and Stripe tasks.

This is a conversion hypothesis, not measured evidence. For the initial 10–20 artists, track time to first saved product, where owners stop, Stripe return outcomes, review waiting time and support interventions.

The legal boundary is **opening checkout**, not saving a private product. Keep drafts private, prevent preview checkout and enforce legal/payment requirements on the server. Explain the remaining requirements early so product-first does not become a surprise compliance wall later.

The existing `ordersOpen` work already supports that separation: it combines legal readiness and the ability to take destination charges. See [CP9_OB_REPORT.md](/Users/mikaelohlen/Cursor%20Apps/chopshop/docs/cf-port/CP9_OB_REPORT.md).

**4. Branch the whole experience**

| Area | Physical goods | POD | Digital, after launch |
|---|---|---|---|
| First item | Images, name, description, customer price, stock and delivery configuration. | Motif, supported garment, colour/size variants, print configuration, customer price and generated mockup. | Separate download and bookable-service forms, storage/delivery or booking configuration. |
| Preview | Actual merchandise; appropriate navigation and delivery copy. | Actual garment mockups and production-on-order wording. | Download or service imagery, relevant purchase/booking action, no clothing or shipping defaults. |
| Legal pages | Seller identity, tax treatment, delivery, returns and withdrawal information. | Add production lead time and relevant printer/data-recipient wording; preserve the distinction between standard merchandise and buyer-personalised goods. | Separate delivery, withdrawal/consent and service-performance rules; booking terms where applicable. |
| Money example | Use the actual product and combined platform deduction. Seller proceeds are not profit after their own stock and fulfilment expenses. | Use the actual garment configuration and combined deduction. | Later, use the actual download/service price and applicable combined deduction. |
| Publication checks | An eligible item, stock/availability and usable delivery settings. | An approved first product, valid artwork/mockups and supported production mappings. | Working delivery or booking fulfilment, correct checkout consent and legal pages. Unavailable at launch. |

**POD does not automatically remove withdrawal rights.** An artist uploading a motif is not the same as the buyer ordering a personally customised product. The exception concerns manufacture to the consumer’s specifications or clear personalisation. Standard artist merchandise should not lose withdrawal rights merely because it is printed after purchase. The current template already makes this distinction; preserve it. [Konsumentverket’s guidance](https://www.konsumentverket.se/marknadsratt-foretag/informationskrav-vid-distansavtal-regler-for-foretag/)

Likewise, future downloads and services cannot share a blanket “ingen ångerrätt” checkbox. Digital-content delivery and completed services have different conditions; consumer consent cannot simply be inferred from purchase. [Konsumentverket on digital content and services](https://www.konsumentverket.se/varor-och-tjanster/digitala-tjanster-och-digitalt-innehall/)

At launch, show a non-selectable card:

> **“Digitala produkter och tjänster”**  
> “Kommer senare. Kan inte väljas ännu.”

Do not let an owner enter an unsupported onboarding track or disguise a download as a physical product.

For every supported track, the seller-facing sales example has only:

- **“Kunden betalar”**
- **“Avgift (plattform och produktion)”**
- **“Till dig”**

Use calculated amounts, not the mocks’ invented 349/177/172 figures. A physical shop’s **“Frakt till kund”** setting is a customer delivery charge; it must not become an itemised seller-deduction breakdown.

**5. Recommendations on the four decisions**

| Decision | Recommendation | Reason |
|---|---|---|
| Who chooses shop type? | **The owner chooses before creation; the platform records that choice when preparing the invitation. Step 1 confirms it.** | Fits invitation-only provisioning and avoids provisioning the wrong capabilities. Offer “Fel butikstyp? Kontakta oss”, rather than silently converting an existing shop. |
| Digital at launch? | **A “Kommer senare” card, outside launch scope.** | It requires a product model, fulfilment and legal/checkout work. It is not another form variant. |
| Who publishes? | **The owner requests; the platform publishes.** | Matches current authority and the first-POD-product review. Record the owner’s request so completing forms alone never authorises publication. |
| Who chooses the address? | **The platform assigns it, ideally agreeing it with the owner before invitation.** | Show “Din webbadress”, read-only. Remove availability checks and accidental expectations of rename support. |

**6. Risks and mitigations**

| Risk | Mitigation |
|---|---|
| Owners finish their work but remain stuck on Stripe or platform review. | Separate **“Behöver göras av dig”**, **“Granskas av Stripe”**, **“Granskas av ChopShop”** and **“Klart”**. Give operators a queue; communicate a review target only when the team can meet it. |
| A Stripe return is mistaken for successful activation. | Refresh server-held status after return; provide **“Fortsätt hos Stripe”** when incomplete. Stripe explicitly says a return can follow “save for later”. [Stripe hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding) |
| Payment readiness is mistaken for payout readiness. | Display both facts correctly. The API exposes `payoutsEnabled`, but the current frontend adapter drops it and success copy relies on `chargesEnabled`. For initial publication, I recommend requiring both; that is a proposed stricter publication rule, not today’s checkout predicate. |
| Drafts leak, or preview content implies an item is approved. | Keep draft preview authenticated and non-purchasable. Label held items **“Förhandsvisning · inväntar granskning”**. Remove illustrative empty product cards from the actual live shop. |
| A generic feature flag is mistaken for an exclusive shop type. | Add an authoritative, creation-time sales type and enforce allowed product types server-side. Today’s POD preset enables a feature and even describes mixed physical/POD selling, which conflicts with the brief. |
| Legal pages become outdated after identity changes. | Preserve versioned adoption, show which changes require review, and re-check readiness when publishing. The templates are explicitly marked as awaiting legal review. |
| Sole-trader identity conflicts with the no-personnummer rule. | Resolve this explicitly before implementing that branch: `A3`/`B3` identify the organisation number as a personnummer. Renaming the field does not resolve the prohibition. Do not add a hidden KYC exception to the design. |
| Support depends on “successful” operations that were only queued or partially completed. | Verify invitation delivery and operator prerequisites. Also fix provisioning to create an unpublished shop atomically: the current client creates it and then separately unpublishes it. |
| Resuming becomes confusing after a failed status request. | Show a retryable status error. The current checklist can disappear when a read fails; absence must not imply completion. |

**7. Build-ready flow and reuse**

“Existing” below means found in the reports or current code, not newly verified in a running environment.

| Step | Fields and preview | Gate | Existing versus new |
|---|---|---|---|
| **Before invitation** | Operator records owner’s chosen type, shop name, assigned address and support email; prepares Connect access. | Supported type; correctly provisioned unpublished shop; invitation can be delivered. | **Existing:** provisioning, physical/POD feature presets, slug generation, support-email editor, invites and Connect enablement. **New:** exclusive sales-type model, coherent invitation preparation, atomic unpublished creation. |
| **“Välj lösenord”** | Invited email and shop identity, password with reveal control; no store-configuration fields. | Valid invitation and successful authentication; retain required platform-service acceptance. | **Existing:** invitation/password infrastructure and platform-terms acceptance. **New:** contextual welcome treatment, clear expired/used-link recovery, route into resumable setup. |
| **1. “Din butik”** | Name; read-only sales type and address; optional logo and accent. Preview header and shop identity. | Valid saved name/type. Logo and colour never block progress. | **Existing:** identity settings and storefront editing. **New:** focused form, confirmed-type presentation and preview binding. |
| **2. “Välj utseende”** | Nord/Sport; optional headline and short introduction. Full storefront preview. | A valid template; sensible defaults allow immediate continuation. | **Existing:** templates and storefront configuration. **New:** simplified chooser, draft preview, device switch and save/resume behaviour. |
| **3. “Din första produkt”** | Physical: images, name, description, price, stock, delivery settings. POD: motif, garment, supported variants, print settings, name and price. Show the actual product. | Valid save/submission. POD approval is a waiting state, not a barrier to continuing setup. | **Existing:** physical product editor, POD studio, rendering, publishing/screening and pending/blocked feedback. **New:** streamlined entry point, preserved return to setup, owner-only preview of draft/held items, unified fee presentation and exclusive-type enforcement. |
| **4. “Uppgifter och villkor”** | Explicit seller category; legal name, postal address, company registration number, VAT status and conditional VAT number, return address. Show platform-managed support email. Preview all three generated pages; explicit adoption. | Required identity complete; applicable platform terms accepted; generated pages adopted. Keep the sole-trader identifier issue unresolved rather than inventing permission to collect it. | **Existing:** settings, generated POD/non-POD wording, snapshots, identity validation and server-side adoption refusal. **New:** consolidated form, explicit category requirement, any missing validation needed by the brief, clearer separate acceptance actions. |
| **5. “Ta betalt med Stripe”** | No bank/personnummer inputs. **“Fortsätt till Stripe”**, status, retry/continue action and product-based money example. | Server-confirmed capabilities. Owners may continue reviewing the shop while Stripe checks information. | **Existing:** hosted onboarding links, return refresh, requirement/status handling and API payout flag. **New:** onboarding integration, truthful payout status in the adapter/UI, saved return destination and calculated example. |
| **6. “Granska och begär publicering”** | Summary with **“Ändra”** links; actual shop preview; explicit publication request. | Request once seller-owned requirements are complete and a product is submitted; approval may still be pending. Platform publication requires fresh legal/payment checks and an eligible, fulfilable product. | **Existing:** platform publish/unpublish, screening and legal/payment predicates. **New:** persisted request, consolidated readiness assessment, operator queue integration and publication-time enforcement. |
| **After publication: “Butiken är öppen för köp”** | Actual shop link, **“Kopiera länk”**, **“Öppna butiken”**, **“Till adminen”**. | Confirmed publication, open checkout and at least one eligible product. | **Existing:** shop/publication facts and storefront address. **New:** success surface. QR and Instagram export can follow after the core journey works. |

Two implementation boundaries matter especially:

- The existing [storefront preview](/Users/mikaelohlen/Cursor%20Apps/chopshop/cloudflare/src/storefront/preview.ts) bypasses shop publication only. It retains product eligibility checks, so it cannot supply the mocks’ immediate view of a pending first POD product. Build the owner’s draft preview separately while reusing storefront components.
- Reuse the facts behind the current [onboarding checklist](/Users/mikaelohlen/Cursor%20Apps/chopshop/src/admin-app/adapters/onboarding.js), but derive progress from saved data and real statuses. A visited step, a Stripe redirect or a saved product must never become a synthetic “done”.

This was a read-only review of the supplied screens, requested documents and relevant code. No files were changed.
---

## The prompt

## Onboarding for a new shop on ChopShop — give your own interpretation, then judge two candidates

You are reviewing the onboarding of a NEW SHOP OWNER on ChopShop, a Swedish multi-tenant web-shop platform being ported to Cloudflare (branch `cf-port`; read `docs/cf-port/CP9_OB_REPORT.md` for what exists today, `docs/design-explorations/onboarding-2026-10-14/README.md` for the mocks, and `docs/cf-port/HANDOVER.md` top entry if you need the wider state). Read only; change nothing.

### The platform, in facts you must respect
- A shop sells ONE of three things, chosen at creation: physical goods, digital products/services, or print-on-demand merch (POD). The owner's words (2026-10-15): "onboarding must be product-independent — the person picks what they will sell, and the steps after that differ. Physical → 'Ladda upp din första produkt'. Digital → 'Ladda upp din första tjänst'. POD → 'Designa din första t-shirt'."
- POD is the primary business: 10–20 artists are waiting to be onboarded. One printer (SnapWear, Poland). The seller uploads a motif, picks a garment, the platform prints on order. The platform reviews a new shop's first POD product before it is visible.
- The digital track (downloads, bookable services) does NOT exist in the product model yet; it is parked for after launch.
- Signup is invitation-only: the platform creates the shop and mails an invite; the owner sets a password. Today the shop id (web address) is assigned by the platform.
- Legal: the seller must give legal identity (name, address, org number for a company, VAT number if VAT-registered) and adopt generated legal pages (köpvillkor, integritetspolicy, ångerrätt) BEFORE checkout opens. A product may exist before that.
- Payouts: Stripe Connect Express. Stripe's HOSTED onboarding collects personnummer, bank account etc. The platform must never collect or store those itself. Our page may only explain and link, and show status.
- Money rule (hard): the seller sees ONE deduction per order ("Avgift (plattform och produktion)"), never a breakdown of production, print, shipping or platform fee.
- Today, publishing a shop is the platform's act. Whether the seller may press "Gå live" themselves is an open decision.
- Templates today: Nord and Sport. Live storefront preview inside the admin does not exist today (new work).
- Language: product copy and UI are Swedish. Write your answer in English, UI copy in Swedish.

### Candidate 1 — the platform's own mocks (impeccable run 2026-10-14)
Images `00-start-*`, `A1`–`A6`, `B1`–`B6`, `99-live`, plus the three direction mocks `a-wizard`, `b-guide`, `c-live`.
- A = guided full-screen six-step wizard on first login with the live storefront growing beside the form (steps: namn/logga/färg → utseende → företag och villkor → utbetalningar → första produkten → gå live).
- B = the same six steps as a start guide inside the normal admin, any order, Stripe inline, "Gå live" greyed until done.
- C = the shared ending: live, copy link, QR, Instagram image.
Candidate 1 has NO shop-type branching: it only knows the POD track.

### Candidate 2 — Gemini's rework (2026-10-15)
Images `G1`–`G6`. Flow A reworked: the first product moved to step 3 (before legal and payouts); a three-way shop type in step 1; three variants of step 3 (G3a physical product, G3b digital service, G3c POD t-shirt). Note G5 shows the platform collecting personnummer and bank account itself, which violates the Stripe fact above.

### What we want from you
1. **Your own interpretation first.** Before judging the candidates, describe the onboarding YOU would build for this platform: the steps, their order, what branches on shop type, where the preview sits, how the legal and payout gates are surfaced without killing momentum, and what "Gå live" means. Be concrete: a numbered step list with Swedish titles and one line of what each step asks and shows. Don't pick A or B — design.
2. **Then judge both candidates** against your interpretation and the facts: what each gets right, what is wrong or impossible (name the screen), what is missing.
3. **Sequencing:** product before legal/payouts (Gemini) vs legal/payouts before product (candidate 1). Argue it with drop-off and legal exposure in mind.
4. **The three tracks:** how step 1's choice should reshape the later steps beyond step 3 (preview content, legal texts such as ångerrätt for personalised print, payouts example, go-live checks). What to show for the digital track while it does not exist.
5. **Recommend on the four open decisions:** (a) seller picks the shop type in step 1 vs the platform presets it at invitation; (b) digital track in launch scope or a "kommer" card; (c) seller presses "Gå live" vs the platform publishes; (d) seller picks the web address vs platform assigns.
6. **Risks and traps** you see (legal, money, abandonment, support load), each with a mitigation.
7. **A build-ready step list**: the final flow you recommend, with for each step the fields, the preview, the gate, and what already exists in the code vs is new.

Be direct. Prefer fewer, better-argued points. Name screens by file name when you refer to them.
