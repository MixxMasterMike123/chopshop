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

## The Meny page (M1)

Hierarchy lives in Samlingar only. The Meny page keeps what surrounds the collections: Hem, pages, links, a tag quick-link, and ONE block "Samlingar (från trädet)" that renders the tree read-only, drags as a unit, and links to Samlingar. A single collection can no longer be a menu item; the eye in Samlingar is the only switch. The "Utvald" star on a collection becomes the mega panel's featured tile. Kategori (the free-text product field with `/kategori/` pages) is proposed folded into collections at migration (one collection per existing category, redirects kept); tags stay.

## Two axes at once (N screens, Ninetone)

A record label: every product sits in its artist AND its format. N1 the tree after migration (Artister with six children; Vinyl, CD, Essentials from the old Kategori field, marked "Var kategorin"; Artist Merch from a tag) and the menu it yields. N2 the product with two memberships, picked with two ticks. N3 the Vinyl page offering the other axis as filter chips: a collection page with no children shows, instead, the collections its products also belong to.

## Scope cut (Mikael, 2026-10-17: "this is already confusing")

**Unit 1 keeps:** A1 (tree + eye), A3 (editor with "Ligger under"), a search-box-only picker on the product (P2 simplified: no tree on the product page, for any shop size), P3 (bulk "Lägg i samling"), S1–S2–S3 (automatic menu, breadcrumb, child chips, phone), M1 (Meny page with one collections block), Z0–Z3 (the same components with less data).

**Parked, in `renders/parked/`:** V1 suggestions + "senast använda", V2 bulk sorting with suggestions, N3 cross-axis filter chips, A2 drag-to-nest (the editor's "Ligger under" does the job).

The seller's model in three sentences: a samling can contain products and other samlingar; the Samlingar page shows that as a tree, and the tree is the menu; on a product you type a samling's name and tick it.


## Distilled (final), 2026-10-17 — `renders/` is now this set; the earlier renders are in `old/`, parked ideas in `parked/`

**The feature in three sentences, for a seller:** a samling holds products and can hold other samlingar; the Samlingar page shows that as a tree, and the tree is the menu; on a product you type a samling's name and tick it.

**Removed in the distill pass, and why:**
- Samlingar page: the Träd/Lista toggle (one view), the search box (search lives on the product; the tree is browsed), the per-row "…" menu (open the row), the legend (the rows say it), the explanatory paragraph in the rail.
- Collection editor: the Webbadress field (shown as a line; it follows the name), "Fylls med" segmented control (a link "Fyll automatiskt från en tagg" instead), the "visa även undersamlingarnas produkter" checkbox (always on — the one rule), the second preview in the rail (A1 already shows the menu).
- Product: the tree browser (search + results only, same shape for 2 or 400 samlingar), the "var kunden hittar den" rail (the chips say it), the counts summary.
- Storefront: the featured tile in the mega panel, "Alla i Rock →" rows (the column heading is the link), the "← Vinyl" chip (breadcrumb), the density switch (its own feature, Kent's request, not part of this).
- Meny page: the copy of the tree inside the block (one row: "Samlingar · Vinyl, CD, Merch · Ändra i Samlingar"), the explanatory hint.
- Stage 0/1: the tag tip on day one, the nesting paragraph (one line), the "ingen samling vald" help.

**The 12 screens:** A1 tree · A3 editor · P2 product picker · P3 bulk · S1 menu open · S2 collection page · S3 phone · M1 Meny · Z0–Z3 the artist's shop at stage 0 and 1.
