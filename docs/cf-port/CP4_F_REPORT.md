# CP4-F and CP4-W — the page swap and the web Worker's deploy path: the reviewer's report

Builders F1, F2 and W were stopped on 2026-09-28 at 07:35 before any of them wrote a report. The reviewer finished the three by hand from what was in the tree on the same day. This report stands in for theirs.

## State

| Part | Commit | Gate |
|---|---|---|
| W, the deploy path | `eedfa614` | `guard/preflight.test.sh` 182, `guard/deploy.test.sh` 48 |
| F1 + F2, the page swap | this commit | 110 tests under Node; the storefront build holds no Firebase code; the older build still builds |
| The Worker (unchanged) | — | 89 files, 3838 tests, 0 failed; `tsc` clean for both projects |

F1 and F2 are one commit: both edit `src/storefront/pages.jsx`, and F2's pages build only with F1's alias list.

## What changes for a visitor

Every change is a removal of a feature that is not ported. No markup, class name or copy was changed or added on any page (checked line by line on the diff of every page).

| Page | What is gone | Why |
|---|---|---|
| Navigation | the account menu: sign in as customer or affiliate, the two registration links, the signed-in name, sign out | D81 |
| Footer | "Mitt konto", "Bli en affiliate", the affiliate sign-in link | D81 |
| Cart | the discount code field; the carriage line and its tier note; **the total and its VAT line** | D81; the brief's rule: no figure the server would not charge. The cart shows the sum of its lines; the total comes at checkout |
| Checkout | sign in and the sign-in window; "create an account" with its password field; "från ditt konto"; **the box "Påminn mig via e-post om jag inte slutför köpet"** | D81; the abandoned-cart reminder is not ported |
| Checkout, summary | the figures are empty until the payment step, where the server has priced the order | the brief: the server prices the order |
| Order confirmation | the button "Visa mina beställningar"; the buyer's name, address and pickup place are not shown | D81; D98 |
| Product page, cards | review stars and the review block | D81 |
| An address that names no shop | the shop's not-found page instead of the platform's landing page | brief E, deviation 5 |

**For Mikael at the design gate:** the cart without a total, and the checkout summary that is empty before the payment step, are the two removals a buyer will notice.

## Findings of the review

1. **The receipt poll ran 111 s and 58 polls instead of 90 s and 45 (F2's open finding). Fixed.** The poll itself cannot pass its deadline. The page was mounted a second time about 21 s in (during F2's test most likely the dev server reloading while F1 edited files in the same tree) and a new 90 s began. The 90 s are now the checkout's, not the page's: `receiptPollTimeLeft` (`src/api/orders.js`) keeps the start per checkout for the tab, and a page mounted again continues the same poll. A page mounted after the time is up still asks once. Three tests. **Not proven in a browser**: the cause is reasoned from the code and the numbers, and the fix holds whatever mounted the page again.
2. **An order holds no name and no delivery address (D98).** A gap of the Worker since CP2, not of the pages. The pages are right against the API as it is.
3. **The infringement report needs a product the page can find.** The API takes a report only with the id of a product of the shop (0036). A report about a product that is already unpublished, or whose link the page cannot read, is refused on the page. The source took a report with a link alone. For a notice-and-takedown duty the looser rule is the safer one: open, Mikael's and Kent's to weigh.
4. **One test of W claimed more than it checked.** "Not a non-VITE_ line" was never looked for in the build's environment; the mutation survived. The fake build now reports it and the test fails on the mutant.
5. **W's order of steps:** the API is deployed before the storefront is built and before the web Worker's configuration is checked, so a failing build leaves the API deployed alone. The script says so in its one line. Building first would be stricter; not changed, the API's changes are additive.

## What was read, and how closely

| Read line by line | Read for shape, tests trusted |
|---|---|
| `scripts/cf-preflight.sh`, `scripts/cf-deploy.sh`, the pinned files, both `wrangler.jsonc` | `guard/preflight.test.sh` (its cases, and 15 mutations of the script against it) |
| Every page and shared component of the swap | `src/storefront/replacements/**` (ten files, 630 lines) |
| `StripePaymentForm`, `src/api/orders.js`, `useReceiptPoll.js` | `src/storefront/dev/**` (never part of a build: the build check fails when it is) |
| The adapters of the checkout, the order, the report and the legal pages | The adapters of products, collections, pages, the storefront and the withdrawal |
| `vite.storefront.config.js`, `src/storefront/pages.jsx` | |

**Codex is asked to read the right-hand column first**, `replacements/productUrls.js` before the rest (it builds every address of the storefront).

## Not done

- No page was looked at rendered by the reviewer. F1 looked at its pages before it was stopped and left no record. The design gate on staging (every page at 375, 768 and 1440 against the baseline) is the proof, and it has not run.
- `OrderReturn.jsx` is switched in unchanged; nobody has walked the return from a payment method's own page.
- The guard's allowlist went from 313 to 298: 15 entries removed, none added.

## Codex, 2026-09-28 14:51–14:59 (medium effort, one commit at a time)

`6ecd315e` (K) and `3022da12`: **no finding.** Seven comments on the other three; six were real and are fixed in one commit, each with its test where a test can reach it.

| Commit | Finding | What was done |
|---|---|---|
| B `14274ea3` | A change of a title only could remove the members another request had just given the collection (the row it read was older than that change) | Members are removed only by the change that writes the rule. **No test:** the state the test needs (members in a smart collection) is one the database refuses (0041) |
| B `14274ea3` | A script of another origin could read the body and neither `ETag` nor `Retry-After` | `Access-Control-Expose-Headers: ETag, Retry-After` on every answer of the two routes |
| W `eedfa614` | A shell that holds `NODE_ENV=development` built a development storefront (the libraries' development build, the payment form's development-only note) | The build runs with `NODE_ENV=production`; the deploy tests now run under `NODE_ENV=development` and read what the build saw |
| W `eedfa614` | A source map comment behind code on its line passed the check | Found anywhere on a line, when an address follows the `=`; the bare words in a string of the code still pass. The real build passes the new check |
| F `f26d616e` | A gallery tile whose product path holds no sku (`/product/mugg`) lost its link | The tile links the path the API gave it, under the shop's root |
| F `f26d616e` | Featured collections behind the first hundred were not shown on the home page | `listCollections` follows the cursor to the end (at most 1 000) |
| F `f26d616e` | **Not changed, by the brief.** In the OLDER build (`src/App.jsx`) the shop routes stand behind the swapped gate and wait for ever | The older build must build, and it does: the admin and platform pages live in it until CP5, and none of them stands behind the gate. Its storefront pages are all swapped and read an API that build does not have. This branch is never deployed to the older hosting |

Gate after the fixes: Worker 89 files, 3838 tests, 0 failed; 112 tests under Node; preflight 183; deploy 48; both builds build; guard PASS.
