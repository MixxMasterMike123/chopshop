# Admin URL shop scoping — make the managed shop explicit in the URL

**Status:** PLAN — Phase 1 (visible indicator) shipping now; Phase 2 (URL scoping) awaiting approval.
**Branch:** `salvage/cleanup-and-security`.
**Stakes:** routing + multi-tenant + authorization. Plan-first per [[working-method]].
**Trigger:** Mikael — "all admins have the same URL basically, it's confusing." Confirmed root-cause-adjacent: the invisible managed-shop state is exactly what let pickup locations save to the wrong shop ([[admin-config-shopid-seam]]).

---

## Problem
The admin surface is the default host (`meteorpr.web.app`) with routes `/admin/*` and **no shop segment**. Which shop you're managing is invisible state:
- Platform operator → impersonation session (`sessionStorage`, 45-min TTL).
- Shop owner → their own `users/{uid}.shopId`.
- Otherwise → `DEFAULT_SHOP_ID` ('b8shield').

Consequences: can't bookmark/share "Sillmans admin"; a refresh after impersonation expiry silently flips to the default shop; no in-URL proof of context.

## Tenancy model (Mikael, 2026-06-17)
- **Super-admins** (platform, e.g. kent@meteorpr.se): may access ANY shop (impersonate).
- **Shop owners** (when shops are live): log in as admin scoped to ONLY their own shop (`users/{uid}.shopId`, role `admin`, not `platform`).
The URL scheme + authz must serve both: an owner must NOT be able to reach another shop's admin by editing the URL; a super-admin may reach any.

## Phase 1 — Visible shop indicator (SHIPPING NOW, no routing change)
- AppLayout top-bar chip now shows **shopName + shopId** (mono subtitle) + tooltip `name (shopId)`, driven by `useShopId()`. Always-on "which shop am I editing." Impersonation already has the non-dismissible `ImpersonationBanner` with countdown; this adds the persistent identifier for the non-impersonation (owner) case too.
- Tiny, safe, reversible. Solves the immediate confusion.

## Phase 2 — shopId in the admin path (PLAN, needs approval)

### URL scheme (decision needed — see Q1)
Option A (recommended): `/admin/{shopId}/...` — e.g. `/admin/sillmans/settings`, `/admin/sillmans/orders`. Bare `/admin` redirects to `/admin/{resolvedShopId}` (impersonation/own-shop/default).
Option B: query param `/admin/settings?shop=sillmans`. Less clean, easy to drop on navigation. Not recommended.

### Resolution change
`ShopContext` (admin mode) precedence becomes: **path shopId** > impersonation > own-shop > default. The path becomes the source of truth, so a bookmark/refresh is deterministic. Impersonation session still carries the audit trail but the URL drives the shop. `resolveShopId` (tenancy.js) gains an admin-path grammar (`/admin/{shopId}/...`) distinct from the storefront grammar.

### Authorization (the load-bearing part)
URL scoping is UI; the DB rules remain the hard gate. But we must also gate the ROUTE:
- A non-platform admin visiting `/admin/{otherShop}/...` must be bounced (redirect to their own shop + toast), not shown a broken page. Add a guard component reading `users/{uid}.shopId` vs path shopId; `isPlatform` bypasses.
- Firestore rules already enforce `isAdminOfShop` per-collection; no rules change needed for reads/writes, but verify every admin write still derives shopId from `useShopId()` (now path-driven) — the [[admin-config-shopid-seam]] fix already routed config through `useShopId()`, so it follows automatically.

### Surface sweep (every admin link/route)
- App.jsx admin routes: add the `{shopId}` segment (or a nested layout route) — ~25 routes.
- Every `<Link to="/admin/...">` and `navigate('/admin/...')` across admin pages + AppLayout nav must carry the current shopId. Centralize via an `adminUrl(path)` helper so links can't drift (mirror the storefront's `getCountryAwareUrl`).
- Wagon admin routes (dynamic) — confirm they compose with the prefix.
- Impersonation intake (`ImpersonationIntake`) + banner "Avsluta" (`window.location.replace('/admin')`) must target the new scheme.
- The shopId chip / breadcrumbs reflect the path.

### Migration / back-compat
- Bare `/admin` and old `/admin/settings` (no shopId) must still work → redirect to `/admin/{resolvedShopId}/settings`. No broken bookmarks.

## Decisions needed (Phase 2)
- **Q1 — scheme:** `/admin/{shopId}/...` (recommended) vs query param.
- **Q2 — owner bounce:** redirect-with-toast (recommended) vs 403 page when an owner hits another shop's URL.
- **Q3 — scope/timing:** build Phase 2 now, or after the current Delivery/Pickup work settles? (It's a broad, ~25-route sweep touching every admin link — worth its own focused pass.)

## Cross-check (platform↔admin↔shop)
- platform→admin: a super-admin opening a shop from the Platform console should land on `/admin/{shopId}/...` directly (impersonation intake sets the path).
- admin→shop: the managed shopId (now in the URL) is the SAME id the storefront resolves — config writes already keyed by it ([[admin-config-shopid-seam]]). Verify round-trip per shop.
- Reverse audit: no admin link left pointing at bare `/admin/...` (would drop the shop); no write that derives shopId from anything but `useShopId()`.

## Non-goals
- Per-shop admin subdomains (sillmans.admin.meteorpr.se) — bigger infra; path scoping first.
- Changing the storefront URL grammar (already path-scoped).
