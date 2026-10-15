# Onboarding directions, impeccable run 2026-10-14

Made in a session on 2026-10-14 (impeccable skill) to show Kent two ways a new shop owner could be onboarded, and the shared "Gå live" ending. Content is made up (Nora Lindqvist, Nattfjäril, 349 kr tee → 172 kr to the seller). The sources here re-render; the PNG renders (15 final screens `final/`, the three direction mocks, four contact sheets) live outside git in `~/chopshop-export/onboarding-mocks-2026-10-14/`.

- `a-wizard.html` — **A, Guidad start**: full-screen six-step wizard on first login, the live storefront preview beside the form. Steps as mocked: 1 namn/logga/färg · 2 utseende · 3 företag och villkor · 4 utbetalningar · 5 första produkten · 6 gå live.
- `b-guide.html` — **B, Startguide i adminen**: the same six steps as an expandable list on the admin home, any order, Stripe inline, "Gå live" greyed until done.
- `c-live.html` — **C, Gå live**: the shared ending — link, QR code, a social image.
- `flow.html` — every screen of A and B in flow order, with captions.
- `shared.css` — the tokens the mocks share.

What exists on staging today is the CP9-OB checklist, not a wizard (`docs/cf-port/CP9_OB_REPORT.md`). On 2026-10-15 Gemini reworked flow A for Mikael: product moved to step 3 (before legal and payouts) and a three-way shop type in step 1 (fysiska varor / digitala produkter & tjänster / print on demand) with three variants of step 3. Mikael's requirement of 2026-10-15: the onboarding must branch on what the shop sells. The digital track needs a product type that does not exist on Cloudflare yet (parked, LAUNCH_TODO §E). The personnummer/bank form in Gemini's step 5 must NOT be ours: Stripe Express collects that on Stripe.
