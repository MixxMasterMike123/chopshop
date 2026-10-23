PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0060 — CP13 round 3: `affiliate` becomes a reserved page slug
-- (docs/cf-port/CP13_AFFILIATE_DESIGN.md §7.1: the storefront's `/affiliate`
-- page — the program's landing and application form — owns that first
-- segment, so a merchant content page must not take it).
--
-- 0042's two `pages_reserved_slug_*` triggers are REPLACED (the 0032/0058
-- recipe: DROP + CREATE under the same names, the same messages), their list
-- gaining 'affiliate'. The list MUST equal RESERVED_PAGE_SLUGS in
-- src/content/pages.ts (test/pages.test.ts reads these triggers back from
-- sqlite_master and pins the two together).
--
-- EXISTING ROWS ARE NOT TOUCHED, and nothing here can fail on them: a trigger
-- never re-checks rows already in the table. A page a shop ALREADY named
-- `affiliate` therefore survives the migration as it is. It stays listed and
-- editable in the admin (an edit that does not send a slug, or sends the same
-- one, is allowed — see the update trigger's `NEW.slug IS NOT OLD.slug`); the
-- API refuses only a body that names `affiliate` as the slug (400
-- slug_reserved, src/content/pages.ts), and renaming it to any free slug
-- works. While the shop's affiliate add-on is ON the storefront's own
-- `/affiliate` page answers that address, so the merchant's page is shadowed
-- there until it is renamed; with the add-on OFF it is served as before.
--
-- The update trigger now fires only when the slug CHANGES (0042's fired on
-- any UPDATE naming the column). For every row 0042 admitted that is the same
-- rule — none of them could hold a reserved slug — and it keeps the one
-- legacy `affiliate` row writable without letting any row move INTO the list.
-- ============================================================================

DROP TRIGGER pages_reserved_slug_insert;
DROP TRIGGER pages_reserved_slug_update;

CREATE TRIGGER pages_reserved_slug_insert
BEFORE INSERT ON pages
FOR EACH ROW
WHEN NEW.slug IN (
  '_api', 'affiliate', 'angerratt', 'angra', 'assets', 'cart', 'checkout', 'integritetspolicy',
  'kategori', 'kopvillkor', 'legal', 'order-confirmation', 'order-return',
  'plattformsvillkor', 'product', 'produkter', 'rapportera-intrang', 'samling', 'tagg'
)
BEGIN
  SELECT RAISE(ABORT, 'the slug is reserved by the storefront');
END;

CREATE TRIGGER pages_reserved_slug_update
BEFORE UPDATE OF slug ON pages
FOR EACH ROW
WHEN NEW.slug IS NOT OLD.slug AND NEW.slug IN (
  '_api', 'affiliate', 'angerratt', 'angra', 'assets', 'cart', 'checkout', 'integritetspolicy',
  'kategori', 'kopvillkor', 'legal', 'order-confirmation', 'order-return',
  'plattformsvillkor', 'product', 'produkter', 'rapportera-intrang', 'samling', 'tagg'
)
BEGIN
  SELECT RAISE(ABORT, 'the slug is reserved by the storefront');
END;
