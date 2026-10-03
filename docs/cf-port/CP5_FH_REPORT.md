Model: claude-sonnet-5-5 (Sonnet 5.5)

# CP5-FH report: AdminUsers ("Administratörer") on the members API (D100)

Working tree only; no git write, no network, no wrangler, no deploy. The older build's dev server was not started.

## (a) What leaves, and every new string (first)

**Leaves in the admin build** (the older build keeps all of them):
- Column "Roll" (the Admin/Kund pill and the role selector).
- Column "Marginal" (the trade margin, "Ändra", the inline editor).
- The "Redigera" link to `/admin/users/:id/edit` and the "Skapa Ny Admin" link to `/admin/users/create` (those pages are not in this build).
- Company, contact person and phone lines of the first column (a member has a name and an address only).

**Removed from the page for both builds** (dead code, so the admin bundle holds no source-system word): the "customers" tab (`activeTab`, `activeCustomerTab`, the "B2B Kundhantering" title, its empty text and placeholder) and the "Material" link. `activeTab` was a constant `'admins'` and the tab buttons were not rendered; the older page shows exactly what it showed.

**New strings (admin build only):**
- Button: "Bjud in administratör" (in the place of "Skapa Ny Admin").
- Column header: "Namn & e-post" (instead of "Företag & Kontakt").
- Badges: "Inbjuden" (info tone, while `invited`), "Inaktiv" (warning tone, suspended); "Aktiv" is the existing one.
- Date prefix "Tillagd:" (instead of "Skapad av admin:"/"Ansökte:").
- Row control: "Ta bort som administratör"; disabled reasons "Du kan inte ta bort dig själv som administratör." (self) and "Butiken måste ha minst en administratör kvar." (last admin): as `title` and as a 12px line under the button.
- Confirm (`window.confirm`, as the page's role change did): "Ta bort {e-post} som administratör? Personen förlorar åtkomsten till butikens admin. Kontot raderas inte."
- Toast: "{e-post} är inte längre administratör"; failure "Kunde inte ta bort administratören".
- Dialog: title "Bjud in administratör", fields "Namn", "E-post" (help "Personen får en länk för att välja lösenord."), buttons "Avbryt", "Skicka inbjudan" / "Skickar…"; local errors "Ange en giltig e-postadress.", "Ange ett namn."; success toast "Inbjudan skickad till {e-post}"; fallback "Kunde inte bjuda in administratören."
- Refusals: already_member "Personen är redan administratör i butiken."; not_addable "Adressen kan inte läggas till som administratör."; member_limit "Butiken har redan 20 administratörer. Ta bort någon först."; 429 "För många inbjudningar just nu. Försök igen om en stund."; 503 email_unavailable "Administratören lades till, men inbjudan kunde inte skickas. Försök igen om en stund." (shown as an error toast, the dialog closes and the list is re-read since the person IS added); invalid_request "Ange ett namn (högst 100 tecken) och en giltig e-postadress."; 404 "Administratören hittades inte, eller så kan butikens administratörer inte hanteras här."; `cannot_revoke_self` and `last_admin` use the two reason sentences above.

No new colour, font or spacing: the dialog uses the admin's own modal markup (the one of AdminDiscountCodes), `Field`/`Input`/`Button` from `components/admin/ui`, `StatusPill`, `text-[12px] text-admin-text-faint`.

## (b) What works against the dev API

List (name, e-mail, badge, "Tillagd" date), invite (new address, mixed case and spaces normalised, re-read), remove with confirm and re-read, own row disabled (self), the last admin disabled (shown acting as `platform-acting@example.com` after removing all others: invite and remove work while acting-as). Each refusal shown in the dialog: `already_member`, `not_addable`, `member_limit` (cookie `admin_dev_fh=full`), 429 (`ratelimit`), 503 (`noinvite`: toast, dialog closes, new row listed). Other scenario: `error` (reads 500). Dev rows behave like the Worker: cap 20, self, last admin, 409 codes, opaque 404 for an unknown id, same `not_addable` for any non-shop-admin account.

## Allowlist facts

- `src/pages/admin/AdminUsers.jsx` no longer matches a forbidden pattern (it did: the word of the resale feature in comments and a role test). Its `guard/allowlist.txt` line is now stale: the reviewer removes it. The guard lists it as stale (it is tracked).
- The older build's data module `src/pages/admin/adminUsersData.js` matches nothing (it imports `AuthContext`, not a Firebase package; no forbidden word). No allowlist entry needed.
- My new files and `cloudflare/admin/dist` hold neither forbidden name (searched both).

## Gate

```
node --test <the full line>
  # tests 516  # suites 157  # pass 516  # fail 0       (mine: 15)
npx vite build --config vite.admin.config.js      ✓ built in 6.57s
node cloudflare/admin/check-admin-build.mjs       admin build: 13 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs    storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                    ✓ built in 10.69s
node guard/guards.test.mjs                        FAIL on stale allowlist entries only (14: 13 of other units' pages + AdminUsers.jsx)
```

## What I looked at

Own dev server on 5189, own browse state, inside the real shell: list (4 members, with an invited and a suspended one) light 1440 and dark 1440/375; the invite dialog; each refusal; after-invite and after-revoke lists; acting-as with a single admin left. Screenshots in `/private/tmp/fh-shots/`. At 375 the table scrolls sideways inside its frame (the older markup does the same), so the remove button is off-screen until scrolled; the page itself has no horizontal scroll (scrollWidth 375). I did not shoot the light 375 view or a mobile dialog again after the final cleanup edit (it changed only filter logic and removed dead branches; the list was re-checked by build and tests, not re-rendered).

## Deviations and open questions

1. "Last admin" is computed in the page's adapter from the list (status `active` counts, as the Worker counts); the server still decides.
2. The 201's `invited` is always true (WC), a later list shows the truth; no resend-invite route exists (WC open question 2), so after a 503 the seller sees the person in the list as "Inbjuden" and cannot re-send.
3. The page keeps the title "Admin Användare" and breadcrumb as before.

## Files

Created: `src/api/admin/members.js`, `src/api/admin/members.test.mjs`, `src/admin-app/adapters/member.js`, `src/admin-app/adapters/member.test.mjs`, `src/admin-app/replacements/adminUsersData.js`, `src/pages/admin/adminUsersData.js`, `src/admin-app/dev/members-dev.mjs`, `src/admin-app/dev/members-fixtures.json`, `src/admin-app/dev/members-dev.test.mjs`, this report.
Modified: `src/pages/admin/AdminUsers.jsx`, `vite.admin.config.js` (one alias row), `src/admin-app/pages.jsx` (one line), `src/admin-app/dev/dev-api.mjs` (one import, one spread).
