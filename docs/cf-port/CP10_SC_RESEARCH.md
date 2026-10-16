# CP10-SC — nested collections: how the others do it (research, 2026-10-16)

Prompted by Kent's meeting with a vinyl/CD/merch seller who needs many subcategories. Sources read on 2026-10-16.

| Platform | Model | Depth | Child products show in parent | URL |
|---|---|---|---|---|
| Shopify | Collections flat; hierarchy only in the navigation menu (a top item takes two nested levels; theme-dependent). Products added to parent and child by hand or by rules. | 3 menu levels | No | Flat `/collections/<handle>` |
| WooCommerce | Real category tree, one parent each, "several layers deep". | Unlimited | Yes | Path `/product-category/a/b/` |
| BigCommerce | Real tree, hard platform limit. | 8 | Yes | Path optional |
| Wix Stores | Real tree (new catalog); ≤1 000 categories recommended. | 5 | Yes | Path |
| Squarespace 7.1 | Multi-level categories, nested side menu. | Multiple | Yes | Path |

Sources: help.shopify.com (drop-down menus: "up to two levels of nested drop-down menus"), woocommerce.com/document/managing-product-taxonomies ("hierarchical … nested several layers deep"), support.bigcommerce.com Platform Limits ("Maximum child category depth 8 levels"), support.wix.com (5 levels incl. All Products), support.squarespace.com (categories and tags, 7.1).

## Design direction for ChopShop (for the CP10-SC design, not built)

- A **real tree** (WooCommerce/BigCommerce), not Shopify's menu-only nesting: `parent_collection_id` on collections, one parent each, any collection may be a parent; cycle check; deleting a parent promotes its children.
- **Depth cap 5** (Wix's number; phones must still render the menu).
- **A parent lists its descendants' products** by default (Woo/BC behaviour; what a record seller expects), with a per-collection switch off for pure landing collections.
- **Flat URLs stay** (`/samling/<handle>`, Shopify/BC style): re-nesting never breaks a link or a ranking; breadcrumbs and child tiles come from the tree in the public answer; the sitemap carries the tree.
- **Menu follows the tree automatically**, the manual builder kept as override; three visible levels on desktop dropdowns, full tree in the hamburger.
- Collections remain manual or tag-based, so a smart collection can sit anywhere in the tree.
- Size: two builder units (facts + public reads on Opus; admin picker "Ligger under", tree list, nested menu, storefront on Sonnet). No external waits.
