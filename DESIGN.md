# DESIGN.md — "NORD" storefront design system

**Status:** Direction approved 2026-06-13 (v5, after rejecting v1 heritage, v2 deli, v3 slick, v4 plakat).
**Living preview:** [docs/design-explorations/v5-bento-nord.html](docs/design-explorations/v5-bento-nord.html) — open in a browser; the brand switcher demos one template skinned as three businesses.
**Scope:** the generic B2C storefront template sold to small seasonal businesses (fish shops, print shops, restaurants, POD). One codebase, per-shop identity via config.

---

## 1. Design principles

1. **One focal point per screen.** The hero photo module dominates; everything else supports. Never two elements fighting for attention.
2. **Hierarchy through scale, weight and color — not borders.** Separation comes from whitespace and soft shadows on white modules. No hairline grids, no boxes-in-boxes.
3. **Three-tier color discipline.**
   - Tier 1 — **ink**: primary content (titles, prices, key values).
   - Tier 2 — **grey**: supporting text (descriptions, labels, hints).
   - Tier 3 — **accent**: *actions and live signals only* (buttons, countdown digits, cart badge, focus rings, progress). The accent never decorates.
4. **Bento modularity.** Pages compose from self-contained white modules on a warm canvas. Modules are scannable, reorderable per shop config, and stack 1-column on mobile.
5. **Micro-interactions everywhere, nothing screaming.** Motion confirms and guides; it never performs. All transitions ≲ 350ms with a soft ease; `prefers-reduced-motion` always respected.
6. **Built for seasonal commerce.** Deadlines, pickup windows and the designed "closed season" state are first-class design components, not afterthoughts. This is the anti-Shopify differentiator.
7. **Buyers of all ages.** Body ≥ 16.5px, inputs ≥ 16px text with generous padding, tap targets ≥ 44px, high contrast on all reading text.

## 2. Design tokens (CSS custom properties)

```css
:root {
  /* surfaces */
  --canvas:  #F3F1EC;   /* warm greige page background */
  --surface: #FFFFFF;   /* module/card background */

  /* text tiers */
  --ink:   #1A1C1E;     /* tier 1 */
  --muted: #71757C;     /* tier 2 */
  --faint: #A8ABB0;     /* section labels, footer */
  --line:  #1A1C1E0F;   /* rare hairlines (inputs, swatch borders) */

  /* per-shop accent — THE configurable identity token */
  --accent:      <from shop config>;
  --accent-ink:  #FFFFFF;
  --accent-soft: color-mix(in srgb, var(--accent) 8%, #FFFFFF);

  /* type */
  --display: 'Familjen Grotesk', sans-serif;   /* Swedish typeface, Google Fonts */
  --body:    'Instrument Sans', -apple-system, sans-serif;

  /* shape */
  --r-tile: 22px;       /* modules, cards */
  --r-el:   14px;       /* inputs, inner chips */
  /* buttons & pills: border-radius 999px */

  /* elevation — soft, layered, never harsh */
  --shadow-1: 0 1px 2px #1A1C1E08, 0 8px 24px -12px #1A1C1E1F;  /* resting */
  --shadow-2: 0 2px 4px #1A1C1E0A, 0 20px 44px -16px #1A1C1E2E; /* hover/lift */

  /* motion */
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
```

**Demo accent palette** (each shop sets its own in config):
fiskhandel *Djuphav* `#0E5E63` · tryckeri *Kobolt* `#2B50E2` · restaurang *Tegel* `#B0492B`.
Accent rule of thumb: muted-premium, must pass AA as button background with white text.

## 3. Typography

| Role | Font / weight | Size | Notes |
|---|---|---|---|
| Hero headline | Familjen Grotesk 700 | clamp(38px, 4.6vw, 62px) | letter-spacing −0.022em, line-height 1.04 |
| Section heading | Familjen Grotesk 700 | 28–40px | −0.02em |
| Card/tile title | Familjen Grotesk 700 | 17–24px | −0.01em |
| Price | Familjen Grotesk 700 | 21px | `font-variant-numeric: tabular-nums` |
| Body | Instrument Sans 400–500 | 16.5–17.5px | line-height 1.6 |
| Supporting/desc | Instrument Sans 400 | 13.5–15.5px | color `--muted` |
| Label (eyebrow) | Instrument Sans 600 | 12px | uppercase, letter-spacing 0.13em, color `--muted`/`--faint` |

Max weight anywhere is 700 — no 800/900. The scale jump between adjacent levels is deliberately large (≈1.4–3.5×); when in doubt, increase contrast between levels rather than adding a divider.

## 4. Components

### Shop nav
Logo (display 700, 21px) · pill nav links (hover: ink text on translucent white) · cart = ink pill button with accent count badge. No border under nav; the canvas gap separates it.

### Bento hero (the signature)
Grid `1.55fr / 1fr`, 16px gaps:
- **Hero module** (spans 2 rows): photo with dark scrim bottom-left, glassy live-status badge (pulsing green dot), headline, one-line sub, white pill CTA + underlined secondary link. **No-photo fallback:** accent radial-gradient field on ink — must look intentional, since many small shops lack pro photography.
- **Deadline module**: eyebrow label, date in display type, live countdown chips (accent digits on `--accent-soft`), pickup meta line. Drives urgency for seasonal windows.
- **Mini-tile: bestseller** (thumb + name + price) and **mini-tile: trust** (stars in accent, rating, payment chips: Swish · Klarna · Apple Pay · Kort).

### Product card
White module, image 4/3.4 with glassy tag pill top-left. Hover: card lifts (−4px, shadow-2) while image zooms 1.045 over 600ms. Body: title → muted desc → footer row with price left and accent pill **"Lägg till"** right, which morphs in place into a − qty + stepper on `--accent-soft`. One tap to buy, zero page navigations.

### Storytelling band
White module with a 5px accent top edge. Three numbered steps (accent number, display title, muted text) telling the shop's process story ("Beredd vid kusten → Packad färsk → Hämtas i hamnen"). Copy comes from shop config.

### Checkout (3 steps, one visible summary)
- Thin accent **progress bar** with step labels (done = grey ✓, current = accent, upcoming = faint).
- **Segmented control** (pickup vs delivery) styled as a soft pill slider.
- Big inputs: 16px+ text, `--r-el` radius, focus = accent border + 4px `--accent-soft` ring.
- Full-width accent pill **"Fortsätt till betalning"**; trust row beneath (🔒 Säker betalning · Swish · Klarna · Kort · Apple Pay).
- **Sticky summary module**: product thumbs, qty, prices; total in display type; accent-soft note box with pickup instructions ("Du får ett SMS…").

### Season-closed module (unique selling point)
Ink-dark module with a soft accent radial glow, eyebrow "Säsongsstängt · öppnar automatiskt", display headline, reassuring copy, email-capture pill form ("Meddela mig"). The storefront switches open/closed automatically by configured dates — the closed state is *designed*, never a dead page.

## 5. Motion

- Page load: modules stagger in with `rise` (fade + 16px translate-up, 0.7s `--ease`, 60–80ms delay steps). One orchestrated entrance; no scattered ambient animation.
- Hover: buttons translate −1 to −2px with colored glow shadow; cards lift + image zoom; nav links get a soft background.
- State changes (add-to-cart morph, segmented slide): 250–350ms `--ease`.
- `@media (prefers-reduced-motion: reduce)` kills all of it.

## 6. Mobile (design mobile-first, demo is responsive)

Single column; bento stacks hero → deadline → minis (minis stay 2-up). Hero min-height 480px. Nav links collapse (hamburger or bottom sheet in implementation). Checkout summary stacks below the form; implementation should add a sticky bottom pay bar with the total. All tap targets ≥ 44px.

## 7. Per-shop configuration (data-driven blocks)

Everything brand-specific is **data, not code** — proven by the preview's brand switcher. A shop's storefront = tokens + content blocks from config (Firestore `settings/app` doc + STORE config + env accent token, per the productization layer):

```
shop config
├─ identity: name, logo text/asset, accent hex
├─ season: { opensAt, closesAt, closedHeadline, closedCopy }   → auto open/closed
├─ hero: { headline, sub, ctaLabel, badgeText, photoUrl? }
├─ deadline: { label, date, pickupMeta }                        → countdown module
├─ bestseller: productRef                                       → mini-tile
├─ trust: { rating, blurb }                                     → mini-tile
├─ story: [ { title, text } × 3 ]                               → storytelling band
├─ fulfillment: { mode labels (hämta/leverans), note }          → checkout
└─ products: catalog (existing)
```

Block order is a list in config so shops can omit/reorder modules (e.g. no trust tile yet → deadline module grows).

## 8. Implementation notes

- Target: replace the three competing visual dialects in `src/pages/shop` + `src/components/shop` with this single system (see CODE_REVIEW_2026-06-12.md §5 — current product-page layout and mobile patterns are worth carrying over, restyled).
- Fonts via Google Fonts (`Familjen Grotesk` 400–700 + `Instrument Sans` 400–700), `display=swap`, preconnect.
- Keep it light: no animation libraries — CSS only; no UI framework beyond existing Tailwind (map tokens into the Tailwind theme).
- Affiliate system is unaffected and stays.
- Pricing stays server-side; nothing in this design implies client-side price math.

## Port contract (2026-09-26)

For the Cloudflare port, the pixel-parity reference for all three surfaces (the NORD storefront, the Admin-Neutral admin and the dark platform console) is **[docs/cf-port/DESIGN_CONTRACT.md](docs/cf-port/DESIGN_CONTRACT.md)**. It holds the token inventory with `file:line` sources, the component vocabulary, the recorded drift, the impeccable audit and the diff protocol. Where this document and the rendered code differ (for example the type scale, or the product grid rendering 2 columns at desktop), the contract records what actually renders. Drift is fixed only after cutover, with a re-baseline.
