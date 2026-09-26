# Design contract: Cloudflare port (CP0, 2026-09-26)

The port swaps the data layer and keeps the frontend's pixels. This file defines "the pixels" precisely enough for later checkpoints to diff against. It is a contract, not a redesign.

- The token and component inventory (§1, §2) is the reference state. A later diff that changes any value listed here is a delta. Every delta needs an explanation in `HANDOVER.md`.
- Drift (§2.4, §3) is recorded and not fixed before cutover (PLAN §7). A drift fix changes pixels, so it ships after cutover with a re-baseline. The one exception is a decision Mikael takes explicitly.
- Pages outside launch scope (PLAN §3.2 PORT-LATER, §3.3 DELETE) are not shot. Their drift is counted only to show its size.

**Parity reference.** Source tree `557c63d` (= `cf-port` HEAD for everything executable under `src/`, `index.html` and the package files; the only later `src/` changes are four deleted READMEs in `ea74f4e`). The served files are `assets/index-EybuBb5L.js` + `assets/index-BqkTMzty.css`, the same bundle on `shop-meteorpr.web.app` and `meteorpr.web.app`. Evidence: the live bundle contains the UI strings added in `557c63d` ("Återbetalat till kund", "Låst tills produkten har en tryckkoppling …") and `59da67a` ("Utbetalning till butiken"). The live CSS was fetched and grepped for the dark-mode facts in §1.2.

**Method.** Every value below was read from source at the cited `file:line`. Where it matters, it was also checked against the live bundle or the computed styles of the live melodie-mc storefront (gstack `browse`, HeadlessChrome 151.0.7922.34, read-only). The raw-colour counts come from a regex scan: Tailwind palette utilities `bg|text|border|ring|from|to|via|divide|fill|stroke|placeholder|shadow|outline|decoration|accent|caret-<palette>-<50..950>`, plus arbitrary hex values `[#…]` and quoted hex literals, with comment lines skipped. `bg-white` / `text-white` / `black` are counted separately as "b/w", because on the platform console and the footer they are the de facto system.

---

## 1. Token inventory

### 1.0 Shared foundation (all three surfaces)

| What | Value | Source |
|---|---|---|
| Tailwind config | **Tailwind v4 CSS-first**: there is no `tailwind.config.js`; every token lives in `@theme` blocks in `src/index.css`. Version pinned by the lockfile at `tailwindcss 4.3.1` / `@tailwindcss/vite ^4.3.1`, `vite ^8.0.16` | `package.json:50,54,56`; `package-lock.json` |
| Dark variant | `@custom-variant dark (&:is(.dark *))` (class-bound, not media) | `src/index.css:3` |
| Default sans | `--font-sans: Figtree, ui-sans-serif, system-ui, …` | `src/index.css:6-8` |
| `body` | `bg-gray-50`; `font-family: 'Figtree', -apple-system, …`; antialiased | `src/index.css:310-328` |
| Mono | `source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace` | `src/index.css:330-333` |
| Implicit border colour | `*, ::before, ::after, ::backdrop { border-color: var(--color-gray-200, currentcolor) }`: a bare `border` is gray-200 on every surface | `src/index.css:216-224` |
| Reduced motion | global `animation-duration/transition-duration: 0.01ms !important`, `iteration-count: 1`, `scroll-behavior: auto` (end states still land) | `src/index.css:199-206` |
| Webfonts | Google Fonts, one `<link>`: Figtree 300–900 + italics, Familjen Grotesk 400–700 (+ital), Instrument Sans 400–700 (+ital), `display=swap`, preconnect | `index.html:22-27` |
| `<html lang>` | `en` (drift: content is Swedish, see A11Y-1) | `index.html:2` |
| App wrapper | `<div className="min-h-screen bg-gray-50">` around every route | `src/App.jsx:257` |
| Toasts (all surfaces) | react-hot-toast `top-right`, 4000 ms, `background:#363636`, `color:#fff` | `src/App.jsx:258-266` |
| Legacy palette | `--color-primary-50…900` (Tailwind *sky* values `#f0f9ff … #0c4a6e`): 10 tokens, used only by `LoginPage.jsx` and `ForgotPasswordPage.jsx` (9 uses) | `src/index.css:10-19` |

### 1.1 Storefront: NORD

**Runtime model.** The storefront reads every themable value through Tailwind utilities that compile to `var(--…)`. `StoreSettingsContext` resolves NORD defaults ← template tokens ← the shop's inline `theme` ← the shop's `accent`, then writes the result as inline custom properties on `<html>` (`src/contexts/StoreSettingsContext.jsx:87-110`; `resolveTheme` in `src/config/nordTokens.js:201-246`). Structural picks (`__heroStyle`, `__cardStyle`) go through context (`StoreSettingsContext.jsx:152-154`). **The theme is data**, so the data layer must carry `templateId`, `theme`, `accent` byte-identical (§4.1).

**melodie-mc effective values (live, computed on `<html>`, 2026-09-26):** pure NORD defaults. `--color-accent:#0E5E63` … `--nord-gap:1rem`, identical to the table below. No template, no inline theme.

#### Colours (9)

| Token (CSS var → utility) | Value | Source | Role |
|---|---|---|---|
| `--color-canvas` → `bg-canvas` | `#F3F1EC` | `index.css:28`; `nordTokens.js:46` | page background |
| `--color-surface` → `bg-surface` | `#FFFFFF` | `index.css:29`; `nordTokens.js:47` | module / card |
| `--color-ink` → `text-ink` | `#1A1C1E` | `index.css:30`; `nordTokens.js:48` | tier-1 text; also footer background (`bg-ink`) |
| `--color-ink-muted` → `text-ink-muted` | `#71757C` | `index.css:31`; `nordTokens.js:49` | tier-2 text |
| `--color-ink-faint` → `text-ink-faint` | `#A8ABB0` | `index.css:32`; `nordTokens.js:50` | tier-3 (eyebrows, meta), 23 uses |
| `--color-line` → `border-line` | `#1A1C1E0F` | `index.css:33`; `nordTokens.js:51` | hairlines, 6 uses |
| `--color-accent` → `bg-/text-accent` | `#0E5E63` (per shop) | `index.css:34`; `nordTokens.js:42` | actions + live signals |
| `--color-accent-ink` → `text-accent-ink` | `#FFFFFF` | `index.css:35`; `nordTokens.js:43` | text on accent (3 uses; 28 places use `text-white` instead, see TH-1) |
| `--color-accent-soft` | `color-mix(in srgb, #0E5E63 8%, #FFFFFF)`; re-derived from accent + surface at runtime | `index.css:39`; `nordTokens.js:226-229` | **0 uses in JSX** (dead token, TH-4) |

De facto (not tokens, but used everywhere on the storefront): `ink/NN` alpha steps (`text-ink/70` icons, `border-ink/15` inputs, `border-ink/10` dividers, `placeholder:text-ink/35`), `white/NN` on the ink footer (`/70` links, `/50` address, `/40` fine print, `/10` dividers, `/20` badge borders; `ShopFooter.jsx:101-332`), `bg-canvas/85 backdrop-blur-md` sticky nav (`ShopNavigation.jsx:112`), `bg-white/95 backdrop-blur-md` mobile add-to-cart bar (`PublicProductPage.jsx:896`), `bg-green-400 animate-pulse` hero live dot (`PublicStorefront.jsx:402`).

#### Type (2 families plus the scale in use)

| Token | Value | Source |
|---|---|---|
| `--font-display` → `font-display` | `'Familjen Grotesk', ui-sans-serif, system-ui, sans-serif` | `index.css:41`; `nordTokens.js:59` |
| `--font-body` → `font-body` | `'Instrument Sans', -apple-system, ui-sans-serif, system-ui, sans-serif` | `index.css:42`; `nordTokens.js:60` |

The scale actually rendered is Tailwind steps, not DESIGN.md §3's clamp values. That is spec drift, recorded here and not a port concern.

| Role | Classes | Source |
|---|---|---|
| Hero H1 (bento) | `font-display font-bold text-4xl sm:text-5xl lg:text-6xl leading-[1.05] tracking-tight` | `PublicStorefront.jsx:406` |
| Hero H1 (editorial / Sport) | `text-4xl sm:text-5xl lg:text-6xl leading-[0.94] tracking-tight uppercase` | `PublicStorefront.jsx:341` |
| Page H1 (legal, ångra, intrång) | `font-display text-4xl font-bold tracking-tight` | `DynamicPage.jsx:294`, `WithdrawalPage.jsx:96`, `InfringementReportPage.jsx:145` |
| Page H1 (listing) | `font-display font-bold text-3xl lg:text-4xl tracking-tight` | `AllProductsPage.jsx:76`, `CollectionPage.jsx:87` |
| Cart H1 | `text-3xl sm:text-4xl font-bold tracking-tight` | `ShoppingCart.jsx:107` |
| PDP H1 | mobile `text-2xl`, desktop `text-4xl` (two H1s; one is always `display:none`) | `PublicProductPage.jsx:540,732` |
| Checkout H1 | `font-display text-2xl font-bold` | `Checkout.jsx:574,601,629` |
| Section H2 | `font-display font-bold text-2xl lg:text-3xl` / `text-3xl lg:text-4xl` | `PublicStorefront.jsx:595,805` |
| Card title | `font-display font-bold text-lg leading-snug tracking-tight` | `NordProductCard.jsx:137` |
| Card desc / meta | `text-sm text-ink-muted` / `text-xs text-ink-faint` | `NordProductCard.jsx:141,145` |
| Eyebrow | `text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-muted` | `PublicStorefront.jsx:449,500` |
| Price (SmartPrice) | small `text-sm font-medium`, normal `text-lg font-semibold`, large `text-2xl font-bold`, colour **`text-gray-900`** (TH-2) | `SmartPrice.jsx:80-97,152` |
| Nav links | `text-sm font-medium`, pill `px-3 py-1.5 rounded-full` | `ShopNavigation.jsx:135-171` |
| Footer | H3 `font-display text-lg font-bold`; links `text-sm` | `ShopFooter.jsx:107,123` |
| Legal body (`legal-doc`) | 15px / 1.65; h2 display 1.25rem/700/−0.01em; h3 display 1.05rem/600; `h1{display:none}`; tables `width:100%` | `index.css:231-249` |
| Form input | `text-[15px] px-4 py-3 rounded-el border-ink/15 bg-white` | `WithdrawalPage.jsx:82-84`, `InfringementReportPage.jsx:130-132` |

#### Radii (2 plus a convention)

| Token | Value | Source | Uses |
|---|---|---|---|
| `--radius-tile` → `rounded-tile` | `22px` | `index.css:44`; `nordTokens.js:65` | 46 |
| `--radius-el` → `rounded-el` | `14px` | `index.css:45`; `nordTokens.js:66` | 46 |
| pill | `rounded-full` (999px) for buttons, chips, badges, nav links | convention (`nordTokens.js:66` comment) | n/a |

#### Spacing and structure (3 tokens plus container conventions)

| Token | Value | Source | Status |
|---|---|---|---|
| `--nord-grid-cols` (`layout.gridCols` 3\|4) | `4` | `index.css:51`; `nordTokens.js:81` | **no effect** (TH-3): the `nord-grid` utility (`index.css:272-276`) is emitted before `sm:grid-cols-2`, which wins, so every product grid renders **2 columns at 1440** (verified computed: `grid-template-columns: 600px 600px`) |
| `--nord-section-y` (density) | `4.5rem` (compact 3rem / airy 6.5rem) | `index.css:52`; `nordTokens.js:145-149` | **never consumed** by any component (TH-4) |
| `--nord-gap` (density) | `1rem` (0.75 / 1.5) | `index.css:53` | **never consumed** (TH-4) |
| Container | `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8` | `ShopNavigation.jsx:113`, `ShopFooter.jsx:102` | convention |
| Nav height | `h-16`, sticky `top-0 z-50` | `ShopNavigation.jsx:112-114` | convention |
| Grid | `grid grid-cols-1 sm:grid-cols-2 nord-grid gap-4` | `PublicStorefront.jsx:717`, `AllProductsPage.jsx:86`, `CollectionPage.jsx:97` | convention |
| Card padding | elevated `p-5`, flat/bordered `p-4` | `NordProductCard.jsx:36-65` | convention |

#### Shadows (2)

| Token | Value | Source | Uses |
|---|---|---|---|
| `--shadow-tile` → `shadow-tile` | `0 1px 2px #1A1C1E08, 0 8px 24px -12px #1A1C1E1F` | `index.css:55` | 29 |
| `--shadow-lift` → `shadow-lift` | `0 2px 4px #1A1C1E0A, 0 20px 44px -16px #1A1C1E2E` | `index.css:56` | 8 |

Off-token: `shadow-xs`/`sm`/… used 22× in storefront pages (e.g. legal header `DynamicPage.jsx:291`).

#### Motion (1 ease, 7 animations)

| Token | Value | Source | Uses |
|---|---|---|---|
| `--ease-nord` → `ease-nord` | `cubic-bezier(0.22, 1, 0.36, 1)` | `index.css:58`; `nordTokens.js:71` | 20 |
| `--animate-rise` | `rise 0.7s var(--ease-nord) both` (fade + 16px up) | `index.css:60,73-76` | 6 |
| `--animate-sheet-up` | `0.35s` translateY(100%) → 0 | `index.css:66,77-80` | 1 |
| `--animate-pop-in` | `0.25s` 8px + scale .96 | `index.css:67,81-84` | 1 |
| `--animate-fade-up` | `0.3s` 8px | `index.css:68,85-88` | 3 |
| `--animate-fade-down` | `0.25s` −6px | `index.css:69,89-92` | 1 |
| `--animate-fade-in` | `0.3s ease-out` | `index.css:70,93-96` | 1 |
| `--animate-badge-pop` | `0.35s` scale .6 → 1.15 → 1 | `index.css:71,97-101` | 3 |

Durations in use: card lift `duration-300`, image zoom `duration-700 group-hover:scale-105` (`NordProductCard.jsx:38,96,131`); sticky bar `transition-all duration-300` (`PublicProductPage.jsx:893`).

#### Template contract (what a template may change)

`NORD_TOKENS` (`nordTokens.js:35-96`) maps 15 leaf tokens to CSS vars (`TOKEN_CSS_VAR`, `nordTokens.js:119-138`). There are 3 more structural picks: density (→ 2 vars), `heroStyle` ∈ {bento, full, split, editorial} and `cardStyle` ∈ {elevated, flat, bordered, overlay} (`TOKEN_ENUMS`, `nordTokens.js:105-110`). Of the hero styles, only `editorial` is implemented (`PublicStorefront.jsx:320`); `full` and `split` render as bento.

Templates on this tree: **2**. `NORD` (no overrides, `templates.js:23-31`) and `SPORT` (`templates.js:45-90`: accent `#E8112D`, canvas `#EEF0F3`, ink `#0D1013`, inkMuted `#4A5058`, inkFaint `#8A9099`, line `#D7DBE0`, Archivo Black/Archivo, rTile 8px, rEl 6px, ease `cubic-bezier(0.16,0.84,0.44,1)`, gridCols 4, density compact, heroStyle editorial, cardStyle bordered). Molten and Modehus exist only on the unmerged branch `feat/storefront-molten-template` (see §6).

### 1.2 Admin: Admin-Neutral (Polaris values)

Deliberately separate from NORD, never themed per shop (`index.css:104-117`).

| Token → utility | Light | Dark (`.dark`, `index.css:180-193`) | Source (light) |
|---|---|---|---|
| `--color-admin-bg` → `bg-admin-bg` | `#f1f1f1` | `#0F1115` | `:119` |
| `--color-admin-surface` | `#ffffff` | `#181B20` | `:120` |
| `--color-admin-surface-2` | `#f7f7f7` | `#1F2329` | `:121` |
| `--color-admin-surface-3` | `#f1f1f1` | `#242A31` | `:122` |
| `--color-admin-border` | `#e3e3e3` | `#2C313A` | `:123` |
| `--color-admin-border-soft` | `#ebebeb` | `#262B33` | `:124` |
| `--color-admin-text` | `#303030` | `#F2F3F5` | `:125` |
| `--color-admin-text-muted` | `#616161` | `#A4ABB6` | `:126` |
| `--color-admin-text-faint` | `#8a8a8a` | `#6F7783` | `:127` |
| `--color-admin-primary` | `#303030` | `#E3E3E3` | `:128` |
| `--color-admin-primary-hover` | `#1a1a1a` | `#ffffff` | `:129` |
| `--color-admin-topbar` | `#1a1a1a` | *(none, always dark by design)* | `:130` |
| `--color-admin-success-bg / -text / -dot` | `#e0f0e9` / `#1c5c41` / `#2a845a` | **none** | `:135-137` |
| `--color-admin-caution-bg / -text / -dot` | `#fbeed3` / `#69500e` / `#b98900` | **none** | `:138-140` |
| `--color-admin-info-bg / -text / -dot` | `#e4ecf6` / `#2c4b6e` / `#3f6fb0` | **none** | `:141-143` |
| `--color-admin-critical-bg / -text / -dot` | `#fde2d8` / `#8a3214` / `#c4351c` | **none** | `:144-146` |
| `--color-admin-neutral-bg / -text / -dot` | `#e3e3e3` / `#5a5a5a` / `#8a8a8a` | **none** | `:147-149` |
| `--color-admin-pos-delta` / `neg-delta` | `#2a845a` / `#c4351c` | **none** | `:150-151` |
| `--radius-admin` | `8px` (cards, tables, metrics) | n/a | `:155` |
| `--radius-admin-el` | `6px` (buttons, inputs, pills, nav items) | n/a | `:156` |
| `--text-admin-body` / `--leading-admin-body` | `13px` / `20px`: **0 uses**; the shell hardcodes `[font-size:13px] [line-height:20px]` (`AppLayout.jsx:326`) | n/a | `:159-160` |
| `--shadow-admin` | `0 1px 0 #0000000D, 0 1px 2px -1px #0000001A` | `0 1px 0 #00000040, 0 1px 3px -1px #00000066` | `:162` / `:192` |

**Dark-mode facts (corrects earlier records).** The `.dark` block overrides **12** tokens: 11 colours + the shadow. **None of the 15 status tokens and neither delta token has a dark override**, on `cf-port` or in the live CSS (`index-BqkTMzty.css` `.dark{…}` checked). The commit that added them, `144f312` (2026-07-10, "15 status-token dark overrides", including `--color-admin-caution-text:#E0B95C`), exists only on the unmerged branches `feat/storefront-molten-template` and `feat/custom-domains-cf-saas`. It is not in `main` or `cf-port`, so the "known gap: caution-text has no dark override" is really **all 15**. `StatusPill.jsx:8-11` calls pills "mode-agnostic" on purpose: pale chips with dark text stay legible. The defect is status **text** tokens used *outside* pills on dark surfaces (TH-5). The parity reference is the live state: no overrides.

**Dark-mode mechanism.** `useDarkMode` toggles `.dark` on `<html>` and persists it in `localStorage['b8shield_dark_mode']` (`src/hooks/useDarkMode.js:11,28`); the toggle is mounted only in the admin topbar (`AppLayout.jsx:365`). The `.dark` override block must stay in `@layer base`, or Tailwind v4 tree-shakes it (`index.css:172-174`).

**Admin type scale:** page title 20px/28px semibold (`Page.jsx:57`); card-section title 14px semibold (`Card.jsx:35`); body/controls/buttons 13px/20px (`AppLayout.jsx:326`, `Button.jsx:22`, `Field.jsx:13`); label 13px medium (`Field.jsx:21`); help/error 12px (`Field.jsx:28-30`); pill 12px/16px medium (`StatusPill.jsx:56`); table 13px/20px, th 12px medium muted (`DataTable.jsx:44,64`); KPI 22px/28px semibold (`KpiStrip.jsx:31`); metric 16px/20px semibold, label 12px (`MetricsBar.jsx:51,54`); topbar shop name 15px semibold, sub 10px mono (`AppLayout.jsx:343,380`). Family: Figtree (inherits `--font-sans`).

**Admin spacing:** topbar `h-14` fixed (`AppLayout.jsx:328`); left nav `w-[232px]` fixed, `top-14` (`top-24` during impersonation) (`:424`); main `md:pl-[232px]`, container `max-w-[1200px] px-4 py-4 sm:px-6` (`:659-660`); nav item `h-8` desktop / `h-10` drawer (`:280,547`); Card `p-4` (`Card.jsx:15`); CardSection header `px-4 py-3`, body `px-4 py-4` (`Card.jsx:34,42`); Page header `mb-4` (`Page.jsx:36`); RightRail `lg:grid-cols-[minmax(0,1fr)_320px] gap-5` (`RightRail.jsx:18`); DataTable row `py-2`, th `py-1.5` (`DataTable.jsx:64,120`); Button heights 24/28/32 (`Button.jsx:27-31`).

**Admin motion:** `transition-colors` (Tailwind default 150 ms) on buttons and nav (`Button.jsx:22`, `AppLayout.jsx:280`); skeleton `animate-pulse` (`DataTable.jsx:151`); spinners `animate-spin border-b-2 border-current` (e.g. `AdminOrders.jsx:548`); Design Studio `pod-step-enter` 240 ms / `pod-pop` 160 ms / `pod-thumb` 200 ms, all `cubic-bezier(0.16,1,0.3,1)`, gated on `prefers-reduced-motion: no-preference` (`index.css:817-832`); 3D slider thumb 0.15 s `cubic-bezier(0.2,0.8,0.2,1)` (`index.css:782,809`).

**Admin shell non-token values (de facto):** topbar overlays `text-white/80`, `/55`, `bg-white/10` (`AppLayout.jsx:334-406`); logo `brightness-0 invert` (`:341`); shop avatar `bg-[var(--color-admin-success-dot)] text-white rounded-[6px]` (`:382,395`); nav active `bg-black/[0.08] dark:bg-white/10`, hover `black/[0.06]` / `white/5` (`:282-283`); drawer scrim `bg-black/40` (`:517`). Quill editor dark skin: raw hex (`index.css:438-735`).

### 1.3 Platform console: always dark, **no tokens**

The platform surface uses raw Tailwind by construction (0 token utilities across 20 files). Its de facto vocabulary is therefore the contract:

| Role | Classes | Source |
|---|---|---|
| Canvas | `min-h-screen bg-gray-950 text-gray-100` | `PlatformLayout.jsx:90` |
| Sidebar | `md:fixed md:w-64 bg-gray-900 border-r border-white/10` (hidden below `md`, no mobile nav) | `PlatformLayout.jsx:92` |
| Brand | icon `ShieldCheckIcon h-7 text-indigo-400`; wordmark `text-sm font-bold` "meteorpr"; sub `text-[11px] uppercase tracking-widest text-indigo-300/70` "Platform" | `PlatformLayout.jsx:94-97` |
| Nav item | `rounded-lg px-3 py-2 text-sm font-medium`; active `bg-indigo-500/15 text-white` + icon `text-indigo-300`; idle `text-gray-300 hover:bg-white/5 hover:text-white`; placeholder `text-gray-600` + "snart" `text-[10px]` | `PlatformLayout.jsx:110-130` |
| Nav badge | `rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300` | `PlatformLayout.jsx:123` |
| Page frame | `px-6 lg:px-10 py-8 max-w-[1600px]`; header `mb-8`; H1 `text-2xl font-bold text-white`; sub `text-gray-400 mt-1` | `PlatformShops.jsx:89-93` |
| Primary button | `rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50` (`btnPrimary`) | `PrinterRow.jsx:23`; `PlatformShops.jsx:97` |
| Secondary button | `rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-white/10` | `PlatformShops.jsx:187` |
| Icon button | `rounded-lg p-1.5 text-gray-300 hover:bg-white/10 hover:text-white` (caution: `hover:bg-amber-500/15 hover:text-amber-300`) | `PlatformShops.jsx:167,175-181` |
| Input | `rounded-lg border border-white/10 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-indigo-500` (`inputCls`); checkbox `rounded border-white/20 bg-gray-950 text-indigo-500`; mm field `w-11 rounded-md … text-xs` | `PrinterRow.jsx:22,24,26` |
| Table card | `overflow-x-auto rounded-xl border border-white/10 bg-gray-900`; `divide-y divide-white/10 text-sm`; th `text-xs font-semibold uppercase tracking-wider text-gray-500 px-4 py-3`; tbody `divide-white/5`; row `hover:bg-white/5`; primary cell `font-medium text-white`; meta `text-xs text-gray-500`; numbers `tabular-nums text-gray-300` | `PlatformShops.jsx:112-161` |
| Status pill | `rounded-full px-2.5 py-0.5 text-xs font-medium` + tone: success `bg-green-500/15 text-green-300`, caution `bg-amber-500/15 text-amber-300`, danger `bg-red-500/15 text-red-300`, info `bg-sky-500/15 text-sky-300`, indigo `bg-indigo-500/15 text-indigo-300`, neutral `bg-white/5 text-gray-400/500`; small tags `rounded px-1.5 py-0.5 text-xs` (emerald / gray-500/20) | `PlatformShops.jsx:141-156`; `shopCells.jsx:17-20`; `PlatformReports.jsx:43-48`; `PrinterRow.jsx:68-73` |
| Modal | scrim `bg-black/60`, panel `bg-gray-900` | e.g. `ProvisionShopModal.jsx:148-150`, `AddShopUserModal.jsx:45-47` |
| Empty/loading, footnote | `py-16 text-center text-gray-500`; `mt-6 text-xs text-gray-600` | `PlatformShops.jsx:105-108,201` |
| Radii | `rounded-lg` 8px (controls), `rounded-xl` 12px (table cards), `rounded-md` 6px, `rounded` 4px, `rounded-full` | as above |
| Type | `text-2xl` bold titles, `text-sm` body, `text-xs` meta/th, `text-[11px]`/`[10px]` labels; Figtree | as above |
| Shadows / motion | none / `transition-colors` only | n/a |

Frequency (top roles, 20 files): `border-white/10` 90, `text-gray-500` 84, `text-gray-400` 83, `text-white` 81, `text-gray-300` 46, `bg-white/5` 46, `text-gray-200` 39, `bg-gray-900` 33, `text-gray-600` 30, `text-amber-300` 28, `bg-gray-800` 27, `border-indigo-400` 22.

### 1.4 Token counts

| Surface | Tokens | Detail |
|---|---|---|
| Storefront (NORD) | **26 CSS tokens** | 9 colours, 2 fonts, 2 radii, 3 structural spacing, 2 shadows, 1 ease, 7 animations. Template contract: 15 CSS-mapped leaves + density + heroStyle + cardStyle = 18 knobs. 3 of the 26 are dead (`accent-soft`, `nord-section-y`, `nord-gap`) and 1 is a no-op (`nord-grid-cols`) |
| Admin (Admin-Neutral) | **34 light tokens** | 29 colours (12 base + 15 status + 2 delta), 2 radii, 2 type (unused), 1 shadow. **12 dark overrides.** Plus 10 legacy `primary-*` (login pages only) |
| Platform console | **0 tokens** | about 20 recurring class roles (§1.3) are the de facto contract |

---

## 2. Component vocabulary

### 2.1 Storefront

| Component | Variants / states | Used by (launch scope) |
|---|---|---|
| `ShopNavigation` (`components/shop/ShopNavigation.jsx`) | tag-nav (home) / nav-links / breadcrumb mode (`:135-196`); mobile menu `animate-fade-down` (`:345`); account dropdown `bg-white rounded-el shadow-lift` (`:269`); cart pill `bg-ink text-white rounded-full` + `bg-accent` count badge `animate-badge-pop` (`:323-332`) | every storefront page |
| `ShopFooter` | ink block, 4 columns (`md:2 lg:4`); optional social row (`:266-289`); bottom bar © + "Drivs av ChopShop · Plattformsvillkor" + 3 badges (`:293-332`) | every page except empty checkout |
| `NordProductCard` | `cardStyle` elevated / flat / bordered / overlay (`:36-65`); sale "Rea!" and tag pills (`:82-84`); colourway thumbs + "+N" (`:173-189`); accent "Välj" pill (`:167`) | home, produkter, kategori, samling, tagg |
| `SmartPrice` | sizes small / normal / large (`:80-97`); states loading / sale / original | cards, PDP, cart, checkout |
| Hero (in `PublicStorefront`) | `heroStyle` bento (`:406` region) / editorial (`:320`); trust mini-tile is **conditional on `heroReview`** and switches the grid 2→1 columns (`:484-496`); "Betala tryggt" tile hardcodes Klarna / Kort / Apple Pay / Google Pay (`:504`) | home |
| `AddedToCartModal` | modal, raw grays | home, PDP |
| PDP layouts | mobile (info above images) / desktop split; fixed mobile add-to-cart bar via IntersectionObserver (`PublicProductPage.jsx:149-157,890-900`); made-to-order amber notice (`:765`) | product |
| `StripePaymentForm` | Stripe Elements wrapper (raw grays) | checkout (with items) |
| `DynamicPage` (legal + CMS) | legal: white header strip + `legal-doc` body (`:285-330`); platform terms: white module (`:202-235`); loading: **blue/indigo gradient + blue spinner** (`:244-247`); CMS page: **pre-NORD blue gradient + inert `prose` + hex vars** (`:441-489`) | 4 legal pages; CMS pages |
| `WithdrawalPage`, `InfringementReportPage` | white module form, local `inputCls` (identical in both), accent pill submit `disabled:opacity-40`, success box `bg-green-50` | angra, rapportera-intrång |
| `ShopGate` | loading spinner `border-gray-900` (`:75`); disabled-shop page with **hardcoded NORD hex** `#F3F1EC/#1A1C1E/#71757C` (`:89-92`); unknown → `LandingPage` | all `/:shopId` routes |
| `ReviewsSection`, `ProductReviews`, `ProductSocialShare` | reviews: dormant when empty (`ReviewsSection.jsx:87-90`) | home, PDP |
| `CookiebotCMP` | script only; banner blocked on unauthorised domains | shop mode (`App.jsx:250`) |

Recurring patterns (not components): primary CTA `bg-accent text-white px-6 py-3 rounded-full font-bold hover:opacity-90` (`WithdrawalPage.jsx:217`); module `bg-white rounded-tile shadow-tile`; chip `bg-canvas text-ink-muted text-xs font-semibold px-3 py-1.5 rounded-full`; notice `rounded-el border-l-4 border-amber-400 bg-amber-50` (`Checkout.jsx:1096`, `PublicProductPage.jsx:765`).

### 2.2 Admin

`src/components/admin/ui/index.js` exports:

| Primitive | Variants / API | Source |
|---|---|---|
| `Page` | title, subtitle, titleAdornment, actions, back (`{to,label,onClick}`) | `Page.jsx:24-70` |
| `Card`, `CardSection` | `padded`; `title`, `actions`, `bare`, `bodyClassName` | `Card.jsx:11-47` |
| `Button` | variant primary / secondary (default) / plain / destructive; size sm / md / lg; polymorphic `as` | `Button.jsx:20-66` |
| `StatusPill` + tone maps | tone success / positive / info / warning / attention / danger / neutral; marker dot / ring / none; `ORDER_STATUS_TONE`, `PAYMENT_STATUS_TONE`, `FULFILLMENT_STATUS_TONE`, `toneForOrderStatus` | `StatusPill.jsx:16-66` |
| `Field`, `Input`, `Textarea`, `Select` | label, help, error, required | `Field.jsx:11-52` |
| `DataTable` | columns, selection, toolbar, footer, skeleton rows | `DataTable.jsx` |
| `FilterBar`, `SegmentedTabs`, `SearchInput`, `ViewTabs`, `InlineSearch`, `Pagination` | n/a | `FilterBar.jsx` |
| `KpiStrip`, `MetricsBar` (sparkline, delta) | n/a | `KpiStrip.jsx`, `MetricsBar.jsx` |
| `RightRail`, `Toolbar` | n/a | `RightRail.jsx`, `Toolbar.jsx` |
| Shell `AppLayout` | fixed dark topbar (logo, fake search, dark toggle, language, shop identity / "Byt butik", logout), 232px left nav + add-on section, mobile drawer, `PlatformTermsGate`, `ImpersonationBanner`, no-shop state (`:306-316`) | `components/layout/AppLayout.jsx` |

Primitive use on launch-scope admin pages (count of `<X` occurrences):

| Page | AppLayout | Page | Card* | Button | StatusPill | DataTable | Field/Input/Select |
|---|---|---|---|---|---|---|---|
| AdminDashboard | 3 | 2 | 1 | 0 | 1 | 1 | 0 |
| AdminProducts | 5 | 6 | 0 | 6 | 3 | 1 | 0 |
| AdminCollections / AdminCollectionEdit | 3 / 2 | 3 / 2 | 0 / 5 | 4 / 4 | 2 / 1 | 1 / 0 | 0 / 9 |
| AdminMenu | 1 | 1 | 3 | 2 | 0 | 0 | 0 |
| AdminPages / AdminPageEdit | 1 / 2 | 1 / 2 | 0 / 8 | 1 / 6 | 3 / 2 | 1 / 0 | 0 / 0 |
| AdminStorefront | 2 | 2 | 9 | 7 | 0 | 0 | 0 |
| AdminSettings | 2 | 2 | 6 | 7 | 0 | 0 | 0 |
| AdminOrders / AdminOrderDetail | 1 / 4 | 1 / 4 | 0 / 11 | 5 / 9 | 3 / 11 | 1 / 0 | 0 / 0 |
| AdminPayments | 2 | 2 | 3 | 10 | 1 | 0 | 0 |
| AdminUsers / UserCreate / UserEdit | 1 / 2 / 3 | 1 / 1 / 3 | 0 / 6 / 11 | 4 / 2 / 14 | 4 / 0 / 3 | 1 / 0 / 0 | 0 / 0 / 0 |
| AdminPlatformTerms | 1 | 1 | 3 | 0 | 1 | 0 | 0 |
| PodAdminPage (`/admin/pod`) | 3 | 2 | 1 | 0 | 0 | 0 | 0 |

Every launch-scope admin page wraps `AppLayout`. `Field`/`Input` are barely used. Pages carry a local `inputCls` that is **byte-identical to `Field.jsx` `CONTROL`** minus the `disabled:` variants: `AdminSettings.jsx:415`, `AdminStorefront.jsx:228`, `AdminPageEdit.jsx:332`, `AdminUserEdit.jsx:538`, `AdminUserCreate.jsx:218`, `ProductForm.jsx:1025`, `PickupLocationsEditor.jsx:53`, `PublishPanel.jsx:253` (the last with `placeholder:text-admin-text-muted`). This duplication is tokenized, not colour drift.

### 2.3 Platform

`PlatformLayout` is the only shared component (every page mounts it itself; nav badge count via `getCountFromServer` on `infringementReports`, `PlatformLayout.jsx:53-68`). Shared class constants: `inputCls`, `btnPrimary` (exported), `checkboxCls`, `mmCls` (`PrinterRow.jsx:22-26`); `PlatformDac7.jsx:21-23` redefines `inputCls`/`btnPrimary` byte-identically instead of importing them. Label helpers: `connectLabel` and friends (`shopCells.jsx`), `REPORT_STATUSES` (`PlatformReports.jsx:43-48`). Modals: Provision, AddShopUser, Impersonate, MigrateShopify, MigrateWoo (same scrim/panel pattern). `PrintShopLayout` (print portal, PORT-LATER) copies the platform canvas (`PrintShopLayout.jsx:31`).

### 2.4 Raw-colour drift (recorded, not fixed)

| Surface | Files scanned | Files with raw palette/hex | Raw palette | Hex | b/w | Token uses |
|---|---|---|---|---|---|---|
| Storefront (`components/shop`, `pages/shop`, `ReviewsSection`, `ProductSocialShare`) | 56 | **43** | 1108 | 30 | 327 | 835 |
| Admin (`pages/admin`, `components/admin`, `layout`, `auth`, `wagons/*`, toggle, language) | 158 | **60** | 3598 | 65 | 316 | 2296 |
| Platform (`pages/platform`, `components/platform`) | 20 | **19** | 675 | 1 | 258 | 0 |

Most admin raw colour sits in DELETE-scope wagons (dining, ambassador, campaign, writers: 3,435 of the 3,598).

**Launch-scope storefront files with raw colour** (line lists are exhaustive for palette/hex):

| File | Lines |
|---|---|
| `pages/shop/PublicStorefront.jsx` | 402 (`bg-green-400` live dot), 440, 474 (`bg-[#F7F5F2]` image well) |
| `pages/shop/PublicProductPage.jsx` | 765 (amber notice) |
| `pages/shop/ShoppingCart.jsx` | 193, 284 |
| `pages/shop/Checkout.jsx` | 1096, 1232, 1280, 1281 |
| `pages/shop/DynamicPage.jsx` | 244, 247 (loading), 345–404 (affiliate-payout / not-found branches), 441–489 (CMS page incl. prose hex), 567–594 |
| `pages/shop/WithdrawalPage.jsx` | 111, 112, 115, 118, 122, 128, 129, 210 |
| `pages/shop/InfringementReportPage.jsx` | 158, 159, 162, 169, 311 |
| `pages/shop/OrderConfirmation.jsx` | 65 lines, 91–432 (entire page pre-NORD; not yet baselined) |
| `pages/shop/OrderReturn.jsx` | 107–158 (15 lines; not yet baselined) |
| `components/shop/ShopNavigation.jsx` | 237, 247, 289, 297 |
| `components/shop/ShopFooter.jsx` | 19–25 (social hovers), 206 |
| `components/shop/ShopGate.jsx` | 75, 89, 91, 92 |
| `components/shop/DynamicRouteHandler.jsx` | 99 |
| `components/shop/AddedToCartModal.jsx` | 62–221 (19 lines) |
| `components/shop/SmartPrice.jsx` | 104–407 (22 lines; rendered price colour at 152) |
| `components/shop/StripePaymentForm.jsx` | 124–483 (24 lines) |
| `components/ReviewsSection.jsx` | 67–264 (22 lines) |
| Clean | `NordProductCard.jsx`, `AllProductsPage.jsx`, `CollectionPage.jsx`, `ProductCollectionPage.jsx`, `TagPage.jsx`, `ProductSocialShare.jsx`, `ProductReviews.jsx` |

Also on the storefront: `bg-accent text-white` ×28 vs `text-accent-ink` ×3 (11 files), and `bg-white` in place of `bg-surface` (PublicStorefront 9, PublicProductPage 11, ShoppingCart 8, Checkout 21, DynamicPage 9, Withdrawal 5, Infringement 4, Navigation 1). Neither is visible with today's templates (both have white accent-ink and surface).

Deferred storefront pages (not shot): CustomerAccount 119, AffiliatePortal 108, AffiliateRegistration 72, CustomerRegister 62, AffiliateAnalyticsTab 56 + 7 hex, ResetPassword 46, ForgotPassword 31, B2B pages 8–29 each, plus the country/language switchers (unused).

**Launch-scope admin files with raw colour:**

| File | Lines | Note |
|---|---|---|
| `pages/admin/AdminOrderDetail.jsx` | 240–264, 772 | 240–264 is a **dead** bright-badge map (only `.text` is used; pills go through `StatusPill`, `:584,791-793`); 772 `text-red-600` |
| `pages/admin/AdminPayments.jsx` | 217, 222, 223, 367, 375, 383 | raw red/emerald/sky `border-l-4` alert banners, no dark variants (light islands in dark mode) |
| `pages/admin/AdminProducts.jsx` | 79, 309 | `text-amber-400` featured star |
| `pages/admin/AdminCollections.jsx` | 64, 220 | same star |
| `pages/admin/AdminStorefront.jsx` | 329 | `'#000000'` colour-input fallback |
| `components/admin/ui/Button.jsx` | 41 | destructive `bg-[#d72c0d] hover:bg-[#b81d00] active:bg-[#a01a00]`: no token |
| `components/admin/ui/Field.jsx` | 23, 28 | required/error `text-red-600` (not `admin-critical-text`) |
| `components/admin/FileManager.jsx` | 88–90, 217–229 | n/a |
| `components/admin/FileUpload.jsx` | 114–121 | n/a |
| `components/auth/ImpersonationBanner.jsx` | 68, 86 | amber banner |
| `components/DarkModeToggle.jsx` | 19–42 | blue/gray/yellow switch inside the admin topbar |
| `components/LanguageSwitcher.jsx` | 25–47 | light dropdown in the topbar |
| `components/auth/AdminRoute.jsx`, `PrivateRoute.jsx`, `PlatformRoute.jsx` | 12–13, 12, 18–19 | spinners `border-blue-600` / `border-gray-900` |
| `pages/LoginPage.jsx`, `ForgotPasswordPage.jsx` | 16 / 15 raw + legacy `primary-*` | auth pages use neither Admin-Neutral nor platform tokens |
| `wagons/pod-wagon/studio/garments/*Flat.jsx` (10 files) | 5–6 hex each (`'#9aa0a6'` …) | garment line art, intentional |
| `index.css` Quill dark skin | 438–735 | raw hex for the rich-text editor |

**Platform:** all 19 of 20 files use raw colour by design. Only `printerTierForm.js` has none.

---

## 3. Impeccable audit (report only, nothing fixed)

Run: `impeccable` skill in audit mode. Context loader reported `NO_PRODUCT_MD` + `EXISTING_VISUAL_SYSTEM`, so the incumbent code is the authority. The static detector ran over all three surfaces, and a rendered probe ran on the live storefront at 375 px. The detector's URL mode needs puppeteer, which is not installed, so the rendered checks used gstack `browse` instead. Admin and platform are code-only: there is no logged-in session yet.

### 3.1 Health scores

| Dimension | Storefront | Admin | Platform |
|---|---|---|---|
| Accessibility | 2 | 2 | 2 |
| Performance | 2 | 3 | 3 |
| Responsive | 3 | 3 | 2 |
| Theming | 2 | 3 | 1 |
| Implementation integrity | 2 | 3 | 3 |
| **Total** | **11/20 Acceptable** | **14/20 Good** | **11/20 Acceptable** |

**Integrity verdict.** Pass for the core flows. NORD and Admin-Neutral are coherent, product-specific systems. Launch-scope admin pages are close to fully tokenized, and the storefront's main pages are token-driven. Failures cluster at the edges: pre-NORD branches (DynamicPage loading/CMS, OrderConfirmation), status-text-in-dark, and a few misleading affordances (IN-1..3). The platform is intentionally untokenized. That is coherent as a single-theme console, but it cannot be themed.

### 3.2 Findings

Class **D** = pre-existing drift: record, fix after cutover with a re-baseline. Class **BP** = blocks parity (§3.4).

| ID | Sev | Surface | Finding | Location | Class |
|---|---|---|---|---|---|
| IN-1 | P1 | SF | Hero trust tile shows **★★★★★ “” — Trustpilot User** with no review behind it. `/x_trustpilot_scrape.csv` is not in `public/`; the SPA rewrite returns `index.html` (200, text/html, verified), Papa-parse turns HTML lines into rows with empty text, and the author falls back to "Trustpilot User". A fabricated-looking 5-star claim shown to buyers | `csvReviews.js:4,16-48`, `trustpilotAPI.js:111-131`, `PublicStorefront.jsx:61-75,484-496` | D, plus hosting dependency H-5 |
| A11Y-1 | P2 | SF | `<html lang="en">` on Swedish pages | `index.html:2` | D |
| A11Y-2 | P1 | SF | PDP quantity −/+ buttons have no accessible name; the "Antal" label is not associated | `PublicProductPage.jsx:614-632,802-820` | D |
| A11Y-3 | P1 | SF | Token contrast: `ink-muted` on `canvas` **4.10:1** (body text, e.g. PDP description on mobile); `ink-faint` on canvas/surface **2.04/2.30:1** (23 text uses); footer `white/40` on ink **3.81:1** | tokens `index.css:31-32`; `ShopFooter.jsx:300-302` | D |
| A11Y-4 | P2 | SF | No `<main>` landmark on home, produkter, kategori, product, cart, checkout, legal (only angra and rapportera-intrång have one) | page roots | D |
| A11Y-5 | P2 | SF | Tap targets under the 44px that DESIGN.md §1.7 promises: nav icons 40×40, size chips 48×34, footer links 18px tall, "Se sortimentet" 24px | `ShopNavigation.jsx:121,204,220`; PDP size chips; `ShopFooter.jsx:123-259` | D |
| A11Y-6 | P3 | SF | Heading levels skip: PDP H1→H3 "Välj"; footer H3 without H2 on every page; grids H1→H3 | n/a | D |
| A11Y-7 | P1 | AD | Dark mode: status **text** tokens have no override. Used outside pills on dark surfaces they measure 1.92 (info) / 2.26 (caution) / 2.09 (critical) / 2.18 (success) / 2.50 (neutral):1 on `#181B20`. A line-level scan finds 92 such lines, about 64 of them in launch-scope files; some may pair with a status background on an adjacent line. Examples: `ProductForm.jsx:1209,1293,1544,1547,1631`, `AdminStorefront.jsx` (9), `AdminUserEdit.jsx` (7), `OrderPaymentCard.jsx` (2), `PlatformTermsGate.jsx:59,148,181`, `PublishPanel.jsx:326,331,373,510,587`, `ProductMapping.jsx:220-241`, `ArtworkUploadModal.jsx:231-343`, `AdminPlatformTerms.jsx:96`, `AdminCollectionEdit.jsx:403` | `index.css:180-193` | D (fix is stranded in `144f312`, see §6) |
| A11Y-8 | P2 | AD | `text-admin-text-faint` 3.45:1 on surface / 3.06:1 on bg (light); 3.82:1 on dark surface | `index.css:127,189` | D |
| A11Y-9 | P2 | PL | `text-gray-500` on gray-900 ≈ 3.7:1 (th, ids); `text-gray-600` ≈ 2.4–2.7:1 (placeholder nav, footnote); icon buttons named only by `title` | `PlatformShops.jsx:115,136,164-183,201`; `PlatformLayout.jsx:115,130` | D |
| RS-1 | P2 | SF | Plattformsvillkor at 375: document 437px wide; the `legal-doc` table has no overflow wrapper | `index.css:247-248` | D |
| RS-2 | P2 | PL | No navigation below 768px (the sidebar is `hidden md:flex`, no hamburger) | `PlatformLayout.jsx:92` | D |
| TH-1 | P3 | SF | `bg-accent text-white` ×28 instead of `text-accent-ink` (×3); `bg-white` instead of `bg-surface` (68 in core pages). Invisible with the current templates | §2.4 | D |
| TH-2 | P2 | SF | `SmartPrice` hardcodes `text-gray-900` on the inner price div. It ignores `ink`, the sale `text-accent`, and the overlay card's `text-white`, so prices go dark-on-scrim under `cardStyle: overlay` (latent; no live template uses it) | `SmartPrice.jsx:152`; `NordProductCard.jsx:110,165` | D |
| TH-3 | P2 | SF | `nord-grid` is a no-op: the `lg` rule loses to `sm:grid-cols-2` in source order, so every grid is **2 columns at 1440**; `gridCols` 3\|4 does nothing | `index.css:272-276` | D, **do not fix during the port** (§4.1 H-3) |
| TH-4 | P3 | SF | Dead tokens `--color-accent-soft` (0 uses), `--nord-section-y`, `--nord-gap` (density does nothing); `heroStyle` `full`/`split` unimplemented | `index.css:39,52-53`; `PublicStorefront.jsx:320` | D |
| TH-5 | P2 | AD | Destructive button raw hex; `AdminPayments` raw alert banners; topbar `DarkModeToggle` / `LanguageSwitcher` off-system; `Field` error `text-red-600`; `text-admin-body` token unused (shell hardcodes 13/20) | §2.4 | D |
| TH-6 | P2 | SF | Pre-NORD branches: DynamicPage loading (blue gradient + blue spinner) and the CMS page render (blue gradient, `prose` classes are inert because there is no typography plugin, hex `--tw-prose-*`); OrderConfirmation/OrderReturn fully raw | `DynamicPage.jsx:244-247,441-489` | D (CMS page and order pages not baselined yet) |
| TH-7 | P3 | AD | Login / forgot-password use legacy gray + `primary-*` (sky); `LandingPage` uses 35 inline hex (a fourth look) | `LoginPage.jsx`, `ForgotPasswordPage.jsx`, `LandingPage.jsx` | D |
| TH-8 | — | PL | No tokens at all (by design); class constants duplicated (`PlatformDac7.jsx:21-23`) | §1.3 | D |
| LY-1 | P3 | SF | Footer: the last link row sits on the divider when no social links are configured (bottom bar lacks `mt-8`; visible in every baseline shot, e.g. `cart-desktop` "Kontakt" y≈673 vs divider y≈684) | `ShopFooter.jsx:293` | D |
| IN-2 | P2 | SF | Hardcoded trust claims: "Betala tryggt: Klarna / Kort / Apple Pay / Google Pay" regardless of enabled methods; footer "✓ 14 dagar ångerrätt" also shown for personalised POD products, which are exempt | `PublicStorefront.jsx:504`; `ShopFooter.jsx:318-324` | D |
| IN-3 | P2 | AD | Topbar "Sök" looks like a search field but is a static `div` with no input | `AppLayout.jsx:349-356` | D |
| IN-4 | P3 | AD/PL | Dead or placeholder UI: `AdminOrderDetail` raw status map (240–264, unused colours); platform nav "Betalningar"/"Inställningar" marked "snart"; platform brand still reads **meteorpr** (display brand is ChopShop) | `PlatformLayout.jsx:39-40,96` | D |
| PF-1 | P2 | all | One 2.88 MB entry chunk (`index-EybuBb5L.js`) serves storefront, admin and platform; storefront buyers download admin/POD code | build | D (chunking may change in the port as long as pixels do not) |
| PF-2 | P2 | SF | Product grid images are not lazy (`NordProductCard.jsx:128-133`); Figtree loads 18 weight/italic files; Cookiebot config 404 on every page | `index.html:27` | D |
| MO-1 | P3 | all | Reduced motion is a global 0.01 ms kill. End states are kept (acceptable), but it is not a designed alternative | `index.css:199-206` | D |

**Detector results (deterministic scan).** 86 findings in total; all were checked in context.

- `border-accent-on-rounded` (46): all are `animate-spin rounded-full border-b-2` loading spinners, so the rule is a false positive. The spinners' raw colours (`border-blue-600`, `border-gray-900`) are real drift and are counted in §2.4.
- `side-tab` (`border-l-4`, 13): true pattern. The amber notices (`Checkout.jsx:1096`, `PublicProductPage.jsx:765`), `AdminPayments.jsx:217,220,375`, and deferred pages (ContentStudio, MyTaxData, `PlatformDac7.jsx:417`). Recorded as P3 drift.
- `gray-on-color` (26): all false positives. They are hover-only tints (`hover:bg-red-500/15`), ternary branches, or `bg-*-500/15` tints mis-read as `bg-*-50` (e.g. `PrinterRow.jsx:73`, `PlatformShops.jsx:179`, `shopCells.jsx:17`, `PlatformReports.jsx:44`).
- `ai-color-palette` (1): `AffiliateAnalyticsTab.jsx:255`, PORT-LATER.
- The admin UI primitives and `AppLayout` scanned clean.

### 3.3 Corrections to earlier records

1. **Dark status tokens:** there are none, on `cf-port` or live (§1.2). Memory `darkmode_admin.md` says `144f312` was deployed; it was not merged, and any later main deploy dropped it.
2. **"Two H1s" (baseline README):** on PDP and legal pages the second H1 is `display:none` (`lg:hidden` duplicate / `.legal-doc h1{display:none}`). It is a DOM duplicate, not visible and not in the accessibility tree. It is a P3 tidy-up, not a user-facing defect.
3. **Templates:** only NORD and Sport are on `main`/`cf-port`. The "4 templates LIVE" in memory refers to an unmerged branch.
4. **`home-*` noise of 0.001–0.003 %** in the determinism check is most likely the hero's `animate-pulse` live dot (`PublicStorefront.jsx:402`, 8×8 px, infinite).

### 3.4 Blocks parity

The storefront list is **empty**: no current drift makes a storefront diff meaningless, provided the inputs in §4.1 are held equal. The candidates below were considered and rejected as blockers:

- Legal dates and the footer year are small (estimated <0.1 % per shot) and are masked (§4.3).
- The mobile sticky bar is deterministic.
- The empty testimonials and trust tile are deterministic under H-5.
- The pulsing dot is below the 0.5 % threshold.
- The two-column grid is deterministic under H-3.

Two admin/platform items do block:

| ID | Why a diff would be meaningless | Resolution (before the admin/platform gate, CP3/CP5) |
|---|---|---|
| **BP-1** | No admin/platform baseline exists, so there is nothing to diff CP3/CP5 against. (Procedural, not a UI defect.) | Mikael hands off a logged-in session; capture per §4.6 on the parity-reference bundle **before** any admin/platform code changes. |
| **BP-2** | Dark mode is read from `localStorage['b8shield_dark_mode']` (`useDarkMode.js:11,28`), a b8shield-named key in PLAN §8's rename path. If it is renamed without reading the old key, every dark capture on CF comes out light (and every user silently loses the setting), so the dark set would compare light against dark. | Freeze the key until after cutover, or rename with a one-time read-old-key migration. The capture harness seeds whichever key the build under test reads, and the name is recorded in the manifest. |

---

## 4. Diff protocol

### 4.1 Parity inputs: hold these equal or the diff measures the wrong thing

| ID | Input | Requirement |
|---|---|---|
| H-1 | Source tree | Port builds start from the `557c63d` frontend tree. Any frontend commit on `main` after that needs a Firebase re-baseline before it counts. |
| H-2 | Data | Staging is seeded from the same Firestore snapshot as the baseline, or Firebase is re-baselined immediately before diffing. Pixel-driving fields: shop config `templateId`, `theme{}`, `accent`, `logoUrl`, `faviconUrl`, `shopName`, `tagline`, hero fields/image, `storeIdentity.menu`, `frontpageCategory`, `reviewsTitle/Subtitle`, `legalName`, address, `supportEmail`, opening hours, `social{}`, legal data (return address, VAT); products (name, descriptions, image order, variants/colourway thumbs, `sortOrder`, `featured`, tags, category, price / compare-at / from-price); collections. |
| H-2b | Product order | `sortProductsForDisplay` (`utils/productSorting.js`) breaks ties by name only. Equal names with no `sortOrder` (the two "Down With The Dragons" on `produkter`) keep **input order**, which is Firestore's default document-id order. The D1 list query must end with `ORDER BY <legacy Firestore doc id>`. |
| H-3 | Toolchain | Keep `tailwindcss 4.3.1` / `@tailwindcss/vite` / `vite` exactly as locked. TH-3's two-column grid depends on utility emission order; a Tailwind bump can flip every grid to 4 columns. |
| H-4 | Fonts | Same Google Fonts `<link>` (`index.html:27`); no self-hosting or subsetting during the port; CSP must allow `fonts.googleapis.com` / `fonts.gstatic.com`. Recommended capture change: `await document.fonts.ready` before the shot. |
| H-5 | Hosting fallback | Unknown paths return `index.html` with **200**, like Firebase's `** → /index.html` (`firebase.json:27-31`). With Workers static assets that is `not_found_handling: "single-page-application"`; `cloudflare/wrangler.jsonc` has no assets config yet. Without it, `/x_trustpilot_scrape.csv` 404s, `heroReview` becomes null and the home hero grid reflows at all three widths (IN-1). |
| H-6 | Cookiebot | The capture host must not be authorised in the Cookiebot domain group (today no banner renders). If Cookiebot is removed or authorised before CP7, re-baseline first. |
| H-7 | Browser | Same gstack `browse` Chromium (HeadlessChrome 151.0.7922.34 at CP0). Record the UA in each manifest (the capture script does not yet). |
| H-8 | Viewports | 375×812, 768×1024, 1440×900, DSF 1. Short pages equal one viewport (`cart-desktop` 1440×900). |
| H-9 | URL grammar | Captures assume `/{shopId}/…`. If the port serves melodie-mc on a hostname without the prefix, change `PAGES` in `capture-storefront.sh` only and note it in the baseline README. Rendered pixels do not include the URL. |

### 4.2 Storefront set (exists)

12 pages × 3 widths = 36 PNGs in `docs/cf-port/baseline/storefront/`: home, produkter, kategori, product, cart (empty), checkout (empty), legal-kopvillkor, legal-angerratt, legal-integritetspolicy, legal-plattformsvillkor, rapportera-intrang, angra. Capture recipe: `capture-storefront.sh` (fresh navigation, 3 s settle, 500 px scroll pass, back to top, `screenshot --selector html`). Diff: `diff-storefront.sh`, statuses `ok` / `RED` / `SIZE` / `MISSING` / `ERROR`, **`LIMIT=0.5` % differing pixels at `FUZZ=2%`**. A size change is red. There is no dark mode on the storefront.

Extra rule: compare manifests too. `layoutWarnings` (plattformsvillkor mobile, document width 437) and `h1All` must match. The 375 PNG is clipped, so a changed overflow width would not show in pixels.

### 4.3 Known unstable or conditional regions

| Page(s) | Region | Cause | Handling |
|---|---|---|---|
| `product-mobile` | fixed "Lägg i kundvagnen" bar at y≈720–812 in the PNG | `position:fixed` + IntersectionObserver (`PublicProductPage.jsx:149-157,890-900`) | Deterministic today; **mask** the bar's rect (selector: the `lg:hidden fixed bottom-0` wrapper). If only that rect differs, the result is explained. |
| `legal-kopvillkor`, `legal-angerratt`, `legal-integritetspolicy` (all widths) | two "Senast uppdaterad: <today>" lines | `new Date()` in the header (`DynamicPage.jsx:298`) and `formatToday()` in the body (`legalPageRenderer.js:66,80` → `legalTemplates.js:73,215,295`) | **mask** both text lines (selectors: the `p` under the legal H1; the `.legal-doc` paragraph starting "Senast uppdaterad") |
| all pages with a footer | "© <year>" | `ShopFooter.jsx:39,296` | **mask** the © line; only matters across New Year (CP7 may fall in 2027) |
| `legal-plattformsvillkor-mobile` | table overflow outside the 375 clip | RS-1 | no mask; enforced through the manifest `layoutWarnings` rule (§4.2) |
| `home-*` | empty "Vad våra kunder säger" section; trust tile ★★★★★ “” — Trustpilot User | IN-1 | no mask; deterministic **only under H-5**. A diff there points to a hosting config gap, not a UI regression. |
| `home-*` | 8×8 pulsing live dot | `animate-pulse` (`PublicStorefront.jsx:402`) | no mask; below threshold (0.001–0.003 %) |
| all | Cookiebot banner | H-6 | none expected; a banner means H-6 was violated |

**Mask mechanism (to add to the scripts before the first CP2 diff; not implemented yet).** The capture step measures each mask selector's rect (`getBoundingClientRect` + `scrollY`, at the shot's scroll position) in the *re-shoot* and writes it to `capture.jsonl` as `masks:[{sel,x,y,w,h}]`. The diff paints the same rects `#000` on **both** PNGs (`magick … -fill black -draw "rectangle x0,y0 x1,y1"`) before `compare`, and prints the masked area per shot. Masks are allowed only for the regions in the table above. The masked area must stay under 2 % of the shot, otherwise the result is RED. Until this lands, a delta confined to those regions is reported as an **explained delta** (§4.5).

### 4.4 Checkpoint cadence

CP2: slice pages (product, cart, checkout, angra, legal) plus home and produkter as smoke. CP4: the full storefront set. CP5: the admin set. CP3: the platform set. CP6: the POD studio set. Every CP after its first shot re-runs the full set of its surfaces. Deferred pages are never shot (PLAN §7).

### 4.5 Explained delta

A RED result passes only with an entry in `HANDOVER.md` for that checkpoint. The entry names the shot(s), percentage and region, the cause (a §4.3 row, a §4.1 input, or a sanctioned change such as a removed deferred feature per PLAN §5), and links the diff PNG. Anything else blocks.

### 4.6 Admin + platform capture protocol (after BP-1)

- **Session:** Mikael hands off a logged-in browser session (for example `browse cookie-import-browser`). Capture is read-only: no saves, no toggles, no uploads. Two identities:
  - (a) a melodie-mc **shop admin**, not a platform user, so the topbar shows the plain shop label rather than "Byt butik", with platform terms **accepted** so `PlatformTermsGate` is closed;
  - (b) a **platform super-admin** for the console.
  
  The same identities, emails and display names must exist on staging (the platform sidebar prints the email, `PlatformLayout.jsx:138`).
- **Widths:** 375×812, 768×1024 (the admin nav shows from `md`=768), 1440×900.
- **Themes:** admin light **and** dark. Seed `localStorage['b8shield_dark_mode']` = `false`/`true` on the admin origin before navigating; the hook reads it at mount (see BP-2). Platform: one theme (always dark, no toggle).
- **States:** fixed record ids (one product, one order, one collection, one page, one user) chosen from the snapshot and written into the capture script. POD tabs are URL-addressable (`/admin/pod?tab=library|studio|mapping`). ProductForm is local state on `/admin/products`, so the capture must click the first product row. PrinterRow is shot collapsed and with the first row expanded.
- **Predicted unstable regions (confirm at first capture):** relative timestamps; dashboard live KPIs/sparklines (`AdminDashboard`); presence indicators; the platform "Anmälningar" badge count (`PlatformLayout.jsx:121-127`); live counts on `PlatformShops` (products/orders/customers); toasts; the impersonation banner (never capture while impersonating); `PlatformTermsGate` (must be closed). Mask by selector as in §4.3, or hold data equal (H-2).
- **Threshold:** the same 0.5 % / 2 % fuzz. Size change = red.

### 4.7 Launch-scope storefront pages not yet in the baseline

Add these before their checkpoint:

- `/order-confirmation/:id` and `/order-return`: need an order fixture.
- Cart and checkout **with items**: seed `localStorage` via `cartStorageKey`, no order placed.
- A CMS page `/:shopId/:slug` (TH-6).
- `/samling/:handle`, `/tagg/:tag`.
- Unknown, disabled and 404 shop pages.
- A POD PDP with `isPersonalized` (the amber notice).
- Mobile menu open.

---

## 5. Launch-scope admin and platform pages (to capture after BP-1)

### 5.1 Admin (shop-admin host, `AppLayout` shell)

| Route | Page / state | Design system | CP |
|---|---|---|---|
| `/login` | `LoginPage.jsx` | **legacy auth look** (gray + `primary-*`), shared with the platform host | CP1 |
| `/forgot-password` | `ForgotPasswordPage.jsx` | legacy auth look | CP1 |
| `/admin` | `AdminDashboard` | Admin-Neutral | CP5 |
| `/admin/products` | `AdminProducts` list | Admin-Neutral | CP5 |
| `/admin/products` → first row | `ProductForm` (local state; POD gate, image rail, variants) | Admin-Neutral | CP5 |
| `/admin/collections`, `/admin/collections/:id` | `AdminCollections`, `AdminCollectionEdit` | Admin-Neutral | CP4 |
| `/admin/menu` | `AdminMenu` | Admin-Neutral | CP4 |
| `/admin/pages`, `/admin/pages/:id` | `AdminPages`, `AdminPageEdit` (Quill dark skin) | Admin-Neutral | CP4 |
| `/admin/storefront` | `AdminStorefront` (branding, template picker, homepage blocks) | Admin-Neutral | CP4 |
| `/admin/settings` | `AdminSettings` (store, delivery, pickup, legal data) | Admin-Neutral | CP5 |
| `/admin/orders`, `/admin/orders/:orderId` | `AdminOrders`, `AdminOrderDetail` (+ `OrderPaymentCard`) | Admin-Neutral | CP5 |
| `/admin/payments` | `AdminPayments` (Connect onboarding, balance) | Admin-Neutral + raw alerts | CP2/CP5 |
| `/admin/users`, `/admin/users/create`, `/admin/users/:userId/edit` | user list / create / edit (deactivate) | Admin-Neutral | CP5 |
| `/admin/plattformsvillkor` | `AdminPlatformTerms` | Admin-Neutral | CP2 |
| any `/admin/*` while terms are unaccepted | `PlatformTermsGate` overlay (needs a second, unaccepted shop fixture) | Admin-Neutral | CP2 |
| `/admin/pod?tab=library` / `studio` / `mapping` | `PodAdminPage`: Original / Studio (Design Studio wizard, 3D read-only) / Avancerat (mappings) | Admin-Neutral | CP2 slice, CP6 |

Not shot:

- **PORT-LATER:** `/admin/b2c-customers(/:id)`, `/admin/b2b-customers`, `/admin/marketing(/…)`, `/admin/customers/:id/marketing(/…)`, `/admin/affiliates(/…)` (6 routes), `/admin/discount-codes`, `/admin/reviews`, `/admin/content-studio`, `/handoff/:postId`, `/admin/skatteuppgifter` (DAC7).
- **DELETE:** wagons `/admin/dining*`, `/admin/ambassadors*`, `/admin/campaigns*`, `/admin/writers-wagon*`.
- **Not routed:** `/admin/translations` (commented out).

### 5.2 Platform console (platform host, `PlatformLayout`, always dark)

| Route | Page / state | Design system | CP |
|---|---|---|---|
| `/login` | `LoginPage.jsx` | legacy auth look | CP1 |
| `/`, `/shops` | `PlatformShops` (**reference page**) | platform-dark | CP3 |
| `/shops/:shopId` | `PlatformShopDetail` (features, live gate, legal readiness, Connect status, users) | platform-dark | CP3 |
| `/addons` | `PlatformAddons` (features) | platform-dark | CP3 |
| `/users` | `PlatformUsers` (+ `AddShopUserModal`) | platform-dark | CP3 |
| `/printers` | `PlatformPrinters` + `PrinterRow` (tiers, areas, routing) | platform-dark | CP3 |
| `/reports` | `PlatformReports` (reports queue, takedown) | platform-dark | CP3 |
| modal on `/shops` | `ImpersonateShopModal` (acting-as) | platform-dark | CP3 |

Not shot:

- **PORT-LATER:** `/models` (3D model tooling), `/dac7`, `MigrateShopifyModal`, `MigrateWooModal`, and `ProvisionShopModal` beyond CP3.
- **Unscheduled:** `/leads` is in neither PLAN §3.1 nor §3.2 and needs a decision.
- **Not routes:** the nav placeholders "Betalningar" and "Inställningar".
- **PORT-LATER:** the print portal (`print.*`: `/`, `/orders/:orderId`, `/artwork`).
- **Undecided:** the logged-out `/` on the admin host renders `LandingPage` (inline-hex marketing look). Include it if it is launch scope.

---

## 6. Open points and uncertainty

1. **Stranded work on unmerged branches.** `feat/storefront-molten-template` carries `144f312` (dark status tokens), the Molten and Modehus templates, and `AdminTemplates.jsx`. None of it is on `main`/`cf-port` or live. **Rule: do not merge it before cutover.** It would turn every dark pill page and any Molten/Modehus shop red. Open question: a shop saved with `templateId: 'molten'` (memory: ninetone) now falls back to NORD plus its inline `theme`. That shop is outside the launch-scope diff; confirm what its storefront renders today before migrating its config.
2. **Parity-reference SHA** (`557c63d`) rests on string evidence in the live bundle plus an empty `src` diff to `cf-port`. A local rebuild was not compared by hash, because the hash depends on the `VITE_*` env baked into the build.
3. **Admin/platform findings are code-level only.** Rendered issues (overflow, dark islands, actual contrast) will show at the first capture after BP-1.
4. **Contrast figures** for Tailwind palette colours use the v3 hex equivalents. Tailwind v4 uses oklch; values are within about ±0.1.
5. **PLAN §7** is one paragraph, while the baseline README cites §7.1–§7.3. This contract serves as §7.2, the design contract. The pointer lives in `DESIGN.md`.
6. **Masking** (§4.3) is specified but not implemented in `capture-storefront.sh` / `diff-storefront.sh`. That is a small script change, due before the first CP2 diff.
7. **IN-1 (fake-looking 5-star tile)** is recorded as drift under PLAN §7. Because it is a buyer-facing trust claim, Mikael may choose to fix it on Firebase before the port. It would then need a same-day storefront re-baseline.
