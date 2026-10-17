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
