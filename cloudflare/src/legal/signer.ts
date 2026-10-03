/**
 * WHO signed a piece of legal evidence (CP5-WJ item 1): the platform-terms
 * acceptance (0031 platform_terms_acceptances) and the legal-pages adoption
 * (0037 legal_acceptances), as a reader of that evidence may see it.
 *
 *   { kind: "admin",    name, email }   a person of the shop. The shop's own
 *                                       admins already see each other's name
 *                                       and address (GET /v1/admin/members).
 *   { kind: "platform", name, email }   a platform user. To the SHOP it is
 *                                       named as the platform only (name and
 *                                       email null), as the order history
 *                                       names an operator (fulfilment.ts
 *                                       `by: "platform"`); the platform's own
 *                                       console sees the person.
 *
 * The Worker never lets a platform user sign for a seller (maySignForSeller),
 * so `platform` can only come from an imported Firebase row whose uid was
 * carried to a platform account. An imported row whose uid was NOT carried
 * (user_id NULL) is named by the address stored with it, `kind: "admin"`.
 *
 * `email` is the address stored WITH the evidence when the table keeps one
 * (legal_acceptances.email, read at signing), else the account's current one.
 */

export type SignerViewer = "platform" | "shop";

export interface SignerView {
  email: string | null;
  kind: "admin" | "platform";
  name: string | null;
}

/** The three columns `signerColumnsSql` selects. */
export interface SignerColumns {
  signer_account_type: string | null;
  signer_email: string | null;
  signer_name: string | null;
}

/**
 * The signer's columns and joins for a table aliased `alias` with a `user_id`
 * column; `storedEmail` is that table's own email column, or null.
 */
export function signerColumnsSql(alias: string, storedEmail: string | null): { columns: string; joins: string } {
  return {
    columns: `signer_user."name" AS signer_name,
              ${storedEmail === null ? 'signer_user."email"' : `COALESCE(${storedEmail}, signer_user."email")`} AS signer_email,
              signer_access.account_type AS signer_account_type`,
    joins: `LEFT JOIN "user" AS signer_user ON signer_user."id" = ${alias}.user_id
            LEFT JOIN identity_access AS signer_access ON signer_access.user_id = ${alias}.user_id`,
  };
}

export function signerView(row: SignerColumns, viewer: SignerViewer): SignerView {
  if (row.signer_account_type === "platform_admin") {
    return viewer === "platform"
      ? { email: row.signer_email, kind: "platform", name: row.signer_name }
      : { email: null, kind: "platform", name: null };
  }
  return { email: row.signer_email, kind: "admin", name: row.signer_name };
}
