# Samlingar med undernivåer — the concept (2026-10-17)

Six screens answering Mikael's four tests: is it understandable in the admin, understandable for visitors, easier to navigate for both, and how the menu is handled. `collections.html?s=A1|A2|A3|S1|S2|S3`; renders in `~/chopshop-export/collections-concept-2026-10-17/`. Demo shop: Skivbörsen (vinyl, CD, merch). Research behind it: `docs/cf-port/CP10_SC_RESEARCH.md`.

**The one idea:** a samling holds products and other samlingar, and the tree IS the menu. No separate navigation system (Shopify) and no categories-plus-menus-plus-widgets (WooCommerce).

| Screen | What it shows |
|---|---|
| A1 | Admin "Samlingar": the tree with counts, drag handles, an eye per row that hides it from the menu without deleting it, "Ny samling under Rock" inline, tag-filled collections marked; the right rail shows the customer's menu live |
| A2 | Dragging Jazz: a drop line, "drag right to nest under Rock" |
| A3 | Editing Rock: "Ligger under" picker (the tree, self greyed), "Fylls med" (chosen products / a tag), "Visa även produkterna i undersamlingarna", "Visa i menyn"; its sub-collections and the customer's breadcrumb + chips in the rail |
| S1 | Storefront desktop: the Vinyl panel built from the tree, one column per child with its children, "Alla i Rock (180) →", one featured tile |
| S2 | Collection page Rock: breadcrumb, child chips with counts as the filter, "← Vinyl", density switch (2/4/6 per row), six-per-row grid |
| S3 | Phone: hamburger shows the tree as expandable rows; the collection page uses the same chips |

## The product side (added the same day)

| Screen | What it shows |
|---|---|
| P1 | The product form's "Samlingar" card: the chosen collections as chips with their full path (Vinyl › Rock › 70-tal), tag-filled memberships shown as read-only "via taggen" chips, "Lägg i samling"; the rail says where the customer finds the product |
| P2 | The picker open: type to filter the tree (matches highlighted, parents kept for context, matches elsewhere shown with their parent), checkboxes at every level, parents half-checked when a child is chosen, "Ny samling under Rock…" inline under the node you are in, tag collections greyed with the reason |
| P3 | The product list with 14 selected and the bulk bar: "Lägg i samling" opens the same picker; "Utan samling" filter finds the orphans |

## The simple end: how it scales down (Z screens, the artist Nora)

The UI grows with the data. Nothing from the next stage shows before the seller takes the first step toward it.

| Stage | Screen | What the seller sees |
|---|---|---|
| 0 — no collections | Z0 | "Samlingar" is an empty state: all products on one page is the right answer at six products; three example chips; the tag tip. No tree, no eyes, no drag. |
| 1 — a few flat collections | Z1, Z2, Z3 | A plain list with thumbnails and counts, one eye per row, the menu preview shows "a tab per collection". The product form has a short checkbox list with "Ny samling…" at the bottom. The storefront nav is pills, no dropdown, no breadcrumb beyond the title. One hint row explains how to nest, when the seller wants it. |
| 2 — nested | A1–A3, S1–S3, P1–P3 | The tree, the drop lines, "Ligger under", path chips, the filtering picker, the mega panel, breadcrumbs and chips. Appears the moment a collection gets a child. |

Same component in all three stages: the tree renders a one-level tree as a list. The seller never switches a mode.
