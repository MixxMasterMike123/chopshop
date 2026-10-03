Model: claude-opus-5-5 (Opus 5.5)

# CP5-FD report: the seller's orders and the dashboard

Built on `cf-port` in the working tree. No git command that writes, no network, no wrangler, no deploy. Nothing under `cloudflare/` was touched.

## (a) What leaves, control by control

| Page | Control | Why | How it leaves |
|---|---|---|---|
| AdminOrderDetail | "Ta bort" (delete order) | An order is permanent evidence (D68). No route exists. | The admin build's `useOrder()` has no `deleteOrder`. The button renders only when the context has the function (`isPlatform && deleteOrder`). The older build still shows it. |
| AdminOrders | Source tabs "Alla källor / Återförsäljare / Kunder" | The trade channel is not ported. Every order is a web-shop order. | `SHOW_SOURCE_TABS` from the page's data module: `true` in the older build, `false` here. The search box closes up to the left. |
| AdminDashboard | Tile "B2C Kunder" and link "Hantera kunder" | No customer accounts (D81). | The data module answers `b2cCustomers: null`. The page filters out null tiles and hides the link. |
| AdminDashboard | Tiles "Affiliate Intäkt" and "Aktiva Affiliates", link "Hantera affiliates" | PORT-LATER | Same mechanism (`affiliateRevenue`/`activeAffiliates: null`). |
| AdminDashboard | `<AdminPresence />` block | Presence is dropped (PLAN §2.9). | Aliased to a component that renders nothing. The layout closes. |

**Kept, but with less data than before:**
- The search box keeps its markup but searches only what the route can (see (d)).
- The list's pickup cell loses its date line: the list route carries `pickupPlace`, not the date.
- The detail's "Betalsätt" reads "Okänd betalning": no route carries the payment method.

## (b) The badge rule (adapters/order.js `badgeStatus`)

The pages show ONE `status`. The adapter fills it from the two tracks. The first rule that holds wins:

1. `status === 'refunded'`, or refunded up to the charge (`money.refundedMinor >= chargedMinor > 0`) → **`refunded`** ("Återbetald")
2. `cancelledAt` set, or `status === 'cancelled'` → **`cancelled`** ("Avbruten")
3. `fulfilment === 'unfulfilled'` → **`confirmed`** ("Bekräftad"). This is the word the pages already use for a paid order nobody has handled yet.
4. Otherwise → the fulfilment step (`processing`, `shipped`, `ready_for_pickup`, `delivered`, `completed`)

A partial refund does not take the badge, because the order is still being delivered. The payment card shows "Återbetalat till kund".

Refunded is ranked before cancelled on purpose:
- A cancellation moves no money. A cancelled order still reads "Avbruten" and keeps its "Återbetala" button (the page shows it while `status !== 'refunded'`).
- Once that order is refunded, it reads "Återbetald" and the button goes.
- I first had the two the other way round. The rendered check showed the refund button staying on a cancelled order that was already refunded, so I swapped them.

The header's separate money pill ("Betald") is unchanged: every order of this API was paid when it was created. `moneyStatus` and `fulfilment` are kept beside `status` on the adapted order.

## (c) The status menu (`OrderStatusMenu`) and the refusals

- **New optional prop `options`.** When a caller passes it, the menu offers exactly those values with their existing labels, and is disabled when the list is empty. Without it, the menu builds its list per source as before, so the older build is unchanged.
- **Where the options come from** (`statusOptionsOf`):
  - The Worker's transition table from the current `fulfilment`.
  - Minus `shipped` for a pickup order, and minus `ready_for_pickup` for a parcel.
  - Plus `cancelled` while the order is open and not yet a return case (`unfulfilled` or `processing`). It goes through `POST …/cancel`, with the fixed reason "Avbruten av butiken i admin".
  - A closed order (cancelled, or refunded to the charge) offers nothing, and its badge is shown disabled.
- **`printer_ships` is not filtered in advance.** The table allows `shipped`; the server decides about the print lines, and the refusal is shown.
- **The tracking-number field on `shipped`** is the detail page's existing field. On the list, choosing "Skickad" sends no number. A first shipment needs none; a further parcel (`shipped → shipped`) is refused with `tracking_required`.

Refusals are shown in the page's existing error style, the toast. The provider sets the sentence as the error's `userMessage`/`message`, and the two `toast.error` calls prefer it.

| Code / reason | Sentence |
|---|---|
| `order_closed` | Ordern är avbruten eller helt återbetald och kan inte längre ändras. |
| `delivery_method` | Steget passar inte orderns leveranssätt: en upphämtning skickas inte, och en hemleverans blir inte redo att hämtas. |
| `transition` | Ordern kan inte gå till det steget från sin nuvarande status. Ladda om sidan och försök igen. |
| `tracking_required` | Ange ett spårningsnummer för att registrera ytterligare ett paket. |
| `printer_ships` | Tryckta produkter skickas av tryckeriet. Ordern kan markeras som skickad eller redo att hämtas när tryckeriet har skickat dem. |
| `return_case` (cancel) | Ordern har redan skickats eller lämnats ut och kan inte avbrytas. Hantera den som en retur. |
| `refund_not_allowed` | Ordern kan inte återbetalas med det beloppet: den är redan återbetald, en återbetalning pågår eller en tvist är öppen. |
| refund `state: failed` | Stripe nekade återbetalningen. Inget belopp har återbetalats. |
| `conflict`, `rate_limited`, `network_error` | one sentence each |

**Idempotency** (`src/api/admin/orders.js` `withIdempotencyKey`):
- Every fulfilment POST and refund POST gets ONE fresh UUID per user action (`crypto.randomUUID`).
- The action is retried with the SAME key after a network failure or a 5xx, at most 3 tries.
- A 4xx is the answer and is not retried.
- Cancel carries no key: the route is idempotent and takes none.

## (d) What works against the dev API

**List** (`GET /v1/admin/orders`):
- `getAllOrders` walks the cursor at `limit=100`, newest first, capped at 50 pages (5 000 orders; it warns when it stops). That is how the page "paged" before: it loaded everything (its `Pagination` is always disabled, "1–N").
- The status tabs, their counts and the KPI strip are computed over that set, client-side, on the badge status.
- It is read again quietly on window focus (`onOrdersStale`), instead of a live listener.

**Search** goes to the route's `q`, after a 300 ms pause:
- an e-mail address (exact, lower-cased), or
- an order-number prefix.

Any other text (a name, part of an address, the user id, a company name) matches nothing and sends no request. Before, the page searched order number, user id, e-mail, first name, last name and company name with a substring match.

**Detail** (`GET /v1/admin/orders/:id`), bridged in `adapters/order.js`:
- Minor units become kronor.
- ISO times become `toTimestamp()`.
- The recipient becomes `customerInfo`/`shippingInfo`/`pickupLocation`.
- The lines become `items[{name,label,sku,quantity,price,lineTotal,podState}]`.
- The history's two tracks are written in the page's words: a first payment row's `from: null` reads "Väntar", fulfilment `unfulfilled` reads "Bekräftad", and the actor is "System" / "Butiken" / "Plattformen" (never an id).
- The withdrawal-consent card and the withdrawal-request card are filled from `consent` and `withdrawalRequest`.
- `trackingNumber` is the last shipment's.

**Fulfilment** steps, refusals, **refund** (whole order) and **cancel** were all exercised in the browser.

**Refund:**
- `POST …/refunds` for the server's `money.refundableMinor`, with the reason "Hela ordern återbetalad från admin".
- A 202 (`reserved`) counts as accepted.
- A 201 with `state: 'failed'` is shown as the refusal, not as success.

**Payment card: THE SELLER SEES ONE NUMBER.**
- The fee is `money.feeMinor`, in the field the card already reads.
- The payout is the server's `payout.amountMinor`, carried as `serverPayoutSek`; the card shows it when present.
- `utils/shopPayout` is aliased to a module that throws if it is ever called. Nothing is recomputed.
- A fully refunded order shows the server's negative payout, e.g. "−14,90 kr" (the wording question of CP2_A:347 is still open).

**POD `podState`:** there is no per-line status element on the detail page. The line row shows only name, label·SKU, price × qty and line total. Per the brief, I added no markup: `podState` is on each adapted line but not shown.

**Dashboard** (`adminDashboardData`, from one walk of the list):

| Tile | Source |
|---|---|
| "Total Intäkt" | the route's `totalMinor` |
| "Totalt Ordrar" | `count` |
| "Väntande" | open orders not yet handled (badge `confirmed`) |
| "Bearbetas" | badge `processing` |
| "Levererade" | badge `shipped`, `delivered` or `completed` |
| recent orders | the five newest rows |

- **Label vs route:** the label says "Total Intäkt". The route gives the gross sum of every order's total, with refunds NOT deducted. The older page summed the same way, so I kept it gross.
- **Changes against the old counting:**
  - "Väntande" counted `status === 'pending'` before, which a paid order never has.
  - "Levererade" now includes `completed`.
  - The "produkter" column shows the units (`itemCount`), not the number of lines, for API rows: the list carries only the count.

**Exports** run client-side. `withExportDetails` reads each order's detail first (4 at a time), because the list rows carry no lines, address, phone or pickup date:

| Export | Details read |
|---|---|
| CSV | every order in view |
| Upphämtningar | the pickup orders only |
| Verifikationer, single and all | the order(s) concerned |
| "Skriv ut fraktetiketter" | the selected orders |

Fields the exports read that no route carries (left empty, not invented):
- the payment method (CSV, verification PDF);
- the seller's name, legal name and org. number on the verification PDF (`shopName`/`sellerLegalName`/`sellerOrgNumber`: the PDF falls back to "Webbutik");
- a note, and affiliate data.

## (e) Approach per file

| File | Approach |
|---|---|
| `src/pages/admin/AdminOrders.jsx` | Only imports and data functions changed. A new data module `adminOrdersData.js` beside the page exports `searchOrders`, `withExportDetails`, `onOrdersStale` and `SHOW_SOURCE_TABS`. The older build's version holds the old in-memory search, moved verbatim, plus identity / no-op. The admin build aliases it to `replacements/adminOrdersData.js`. `useOrder()` comes through the existing `OrderContext` alias. `orderItemCount` reads `itemCount` when a row has no `items`. The status update toast prefers `error.userMessage`. `options={order.statusOptions}` is passed to the menu. |
| `src/pages/admin/AdminOrderDetail.jsx` | The inline `getDoc users` and `httpsCallable('refundOrder')` move to `adminOrderDetailData.js`: the old code moved, aliased to `replacements/adminOrderDetailData.js` (no buyer account, so `null`; the refund route). The page imports neither Firebase nor the API client. The delete button is conditional on `deleteOrder`. `getStatusInfo` gains `refunded` / `partially_refunded` (see Deviations). The toast prefers `userMessage`. `options` is passed to the menu. |
| `src/pages/admin/AdminDashboard.jsx` | The inline Firestore block moves to `adminDashboardData.js` `loadDashboardStats(shopId)` (moved verbatim), aliased to `replacements/adminDashboardData.js`. Metrics with a null value are filtered out, and the two links are conditional. One JSX comment was reworded so the file no longer matches a guard family. |
| `src/components/admin/OrderPaymentCard.jsx` | Uses `order.serverPayoutSek` when it is a finite number, else `shopPayoutSek` as before (older build). |
| `src/components/OrderStatusMenu.jsx` | Gains the optional `options` prop (a label table for every status the menu can name). Markup unchanged; the disabled state also covers "no options". |
| `src/admin-app/providers/Orders.jsx` | Filled: `getAllOrders`, `getOrderById` (null on 404), `updateOrderStatus` (fulfilment or cancel). `deleteOrder` is absent. The functions are module-level and stable. |
| `src/api/admin/orders.js` (+ test) | `listOrders`, `listAllOrders`, `getOrder`, `changeFulfilment`, `refundOrder`, `cancelOrder`, `searchQueryOf`, `withIdempotencyKey` |
| `src/admin-app/adapters/order.js` (+ test) | `badgeStatus`, `statusOptionsOf`, `orderFromListRow`, `orderFromDetail`, `refusalMessage` |

**Replacements for shared modules:**
- `utils/shopPayout` → `replacements/shopPayout.js` (throws).
- `components/AdminPresence` → `replacements/AdminPresence.jsx` (renders nothing).
- `utils/labelPrinter`, `orderExport`, `pickupExport`, `orderVerification`, `orderUtils`, `pickupDates`, `paymentMethods`, `escapeHtml`, `hooks/useContentTranslation` and `LabelPrintInstructions` reach no Firebase code and are used as they are.

## What I looked at

The admin dev server ran on port 5185 with the dev API, inside FB's shell (it was in the build). I used my own browse daemon (`BROWSE_STATE_FILE`/`BROWSE_PORT`), because the shared one switched tabs under other agents. There are 31 screenshots in `/private/tmp/fd-shots/`.

**List:**
- Orders in every state, at 1440 light and dark, and at 375 light and dark.
- The empty state: cookie `admin_dev_orders=empty`.
- Search by e-mail (1 hit), by order-number prefix (2 hits) and by a name (no hit, the empty message).
- The menu of a shipped parcel: Skickad ✓ / Levererad / Slutförd.
- A refusal from the list: shipped → shipped without a tracking number gives the `tracking_required` toast.
- Cancel from the list: Bekräftad → Avbruten.
- The exports: Upphämtningar read 2 details, the CSV read 9.

**Detail:**
- A pickup order: place, address and date. Its menu offers Behandlas / Redo att hämtas / Avbruten. "Redo att hämtas" succeeded, and the history row "Bekräftad → Redo att hämtas · Butiken" appeared.
- A POD parcel: the withdrawal-consent card is filled. Skickad with a tracking number gave the `printer_ships` toast.
- A partially refunded, shipped order: the fee, the refunded amount and the server's payout, plus a 4-row history across both tracks.
- A cancelled order: refund via the confirm, then the badge reads Återbetald.
- A refunded order with a withdrawal request: the negative payout.
- A not-found order: the error card.
- Each at 1440 light and dark, and at 375 light and dark.

**Dashboard:** 1440 and 375, light and dark, with data and empty.

**Seen and not mine** (listed, not changed):

| What | Cause |
|---|---|
| At 375 the page scrolls sideways (scrollWidth 404) | FB's top bar (the logout button ends at 420 px) and the page's header action row (unchanged markup) |
| In dark mode, the status menu's and the old-style pills keep their light colours | Those classes have no `dark:` variants; existing |
| A pickup order's customer card reads "Leveransadress: Address information missing", and the name reads "… (B2C Customer)" | The page's own text for a web-shop order without `shippingInfo` |
| Two "Order not found" toasts on a missing order | React StrictMode in dev |
| A cancellation has no history row | The cancel route writes none to the history the detail returns |
| A closed order's badge looks dimmed | The disabled style |

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 397  # suites 116  # pass 397  # fail 0          (mine: 52 in orders.test, order.test, orders-dev.test)
npx vite build --config vite.admin.config.js     ✓ built in 7.39s
node cloudflare/admin/check-admin-build.mjs      admin build: 11 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs   storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build                                   ✓ built in 12.38s
node guard/guards.test.mjs                       guard: FAIL — (b) 9 stale guard/allowlist.txt entries (below); no (a) offender
```

The Worker gate was not run: nothing under `cloudflare/` was touched. My new files are untracked, so I checked them myself: none matches the earlier-brand or resale family. No admin-build file of mine imports Firebase.

## Stale allowlist entries (for the reviewer; I did not edit the allowlist)

**Mine:**
- `src/pages/admin/AdminOrderDetail.jsx` (it no longer imports Firebase)
- `src/pages/admin/AdminDashboard.jsx` (no Firebase import; the one comment that matched was reworded)

**Not mine, also reported now:** `CredentialLanguageSwitcher.jsx`, `PlatformTermsGate.jsx`, `ShopPicker.jsx`, `PlatformLayout.jsx`, `AdminPayments.jsx`, `AdminPlatformTerms.jsx`, `AdminSettings.jsx`.

**When these are committed:** `src/pages/admin/adminOrderDetailData.js` and `src/pages/admin/adminDashboardData.js` hold the older build's Firebase calls, moved out of the two pages. The guard's Firebase family will list them as offenders once tracked. Each replaces one stale page entry, so the allowlist's size does not grow. `adminOrdersData.js` imports no Firebase.

## Deviations

1. **Filters are client-side over the walked list; the route's `status`/`fulfilment`/`since`/`until` are not sent by the list page.**
   - The status tabs show a count each and the KPI strip covers the whole set, so the page needs every order anyway.
   - One walk serves all tabs, and it filters on the badge status, so "Skickad" does not list an order that reads "Återbetald".
   - `q` is sent (search). The dashboard uses the route's `count` and `totalMinor`.
2. **The search is server-side and replaces the in-memory filter**, but only in the admin build. To keep the older build identical, the page's filter became an async step over "the search's matches". In the older build those matches are the old filter, resolved a tick later, so a first keystroke can show the empty message for one frame.
3. **`AdminOrderDetail.getStatusInfo` gains `refunded` and `partially_refunded`.** Without them the header pill printed the raw word "refunded". This also changes the older build, for the better.
4. **The menu offers `cancelled`** (the cancel route) besides the fulfilment steps. The brief says the menu offers only fulfilment steps but also that cancel goes through its route, and the menu's "Avbruten" was the page's only cancel control. No confirm dialog was added, which is parity with the old menu.
5. Several shared files were edited by line:
   - `OrderPaymentCard` and `OrderStatusMenu` (data lines only);
   - one JSX comment in AdminDashboard;
   - `vite.admin.config.js`: 5 alias rows appended;
   - `pages.jsx`: my 3 lines swapped in;
   - `dev-api.mjs`: one import and one `...ORDER_ROUTES` row.
6. **The dev routes and fixtures live in their own files**, `src/admin-app/dev/orders-dev.mjs` and `orders.fixtures.json`, in the products/shells builders' style, not in `fixtures.json`. This keeps the shared file untouched.

## Open questions (what the pages do today that the routes cannot express)

1. **Search by name, part of an address or company.** The route searches only an exact e-mail or an order-number prefix. Should `q` also match the recipient's name?
2. **The payment method** ("Betalsätt", the CSV and the PDF) is on no route.
3. **The seller's identity for the verification PDF** (shop and legal name, org. number) is not on the order routes. FE's settings could supply it. Should the data module read `GET /v1/admin/settings`?
4. **The pickup date in the list cell.** The list route carries only `pickupPlace`.
5. **Per-line POD state.** The detail page has no element to show it. Should a small read-only line be added (new markup, a design decision)?
6. **Cancel confirmation.** The old menu had none. A cancellation now stops print jobs and does not refund; the seller refunds next. Should a confirm be added?
7. **A refund answered 202 (`reserved`)** shows the page's "Ordern återbetalad" toast before Stripe has settled it.
8. **The discount line.** The card's discount line is labelled as an affiliate discount. `totals.discountMinor` is mapped to it, and shows only when above 0. Discounts are off (D81), so it should never show, but the label would be wrong if it did.
9. **No code writes `production_state` yet (WB open question 1).** Until a writer exists, a POD order cannot be marked shipped or ready from this page: it always gets `printer_ships`.
10. **The orders page and the dashboard each walk the full list** (capped at 5 000). That is fine for launch-size shops; a bigger shop needs server-side tabs (a count per filter) and real paging.
