// The shop's own admins (unit FH): a member of GET /v1/admin/members as the
// row object AdminUsers' table already reads, and the Swedish sentences of the
// API's refusals. Pure: tested under Node (member.test.mjs).

/** The cap of active admins per shop (the Worker's, D100). */
export const MEMBER_LIMIT = 20;

/** Why a row's remove control is off (a sentence), or null when it works. */
export const REVOKE_BLOCK = {
  self: 'Du kan inte ta bort dig själv som administratör.',
  last_admin: 'Butiken måste ha minst en administratör kvar.',
};

/** True for a member the shop counts as an admin: not suspended. */
const counts = (m) => m.status === 'active';

/**
 * The page's rows from the API's members. The columns the page keeps read
 * `companyName` (the name), `email`, `contactPerson` (empty), `active`,
 * `createdAt`. `invited`, `suspended` and `revokeBlock` feed the new controls.
 */
export function memberRowsOf(members) {
  const list = Array.isArray(members) ? members.filter((m) => m && typeof m.userId === 'string') : [];
  const counting = list.filter(counts).length;
  return list.map((m) => {
    let revokeBlock = null;
    if (m.self === true) revokeBlock = 'self';
    else if (counts(m) && counting <= 1) revokeBlock = 'last_admin';
    return {
      id: m.userId,
      role: 'admin',
      companyName: typeof m.name === 'string' ? m.name : '',
      contactPerson: '',
      email: typeof m.email === 'string' ? m.email : '',
      active: m.status === 'active',
      suspended: m.status === 'suspended',
      invited: m.invited === true && m.status === 'active',
      createdByAdmin: true,
      createdAt: typeof m.joinedAt === 'string' ? m.joinedAt : null,
      self: m.self === true,
      revokeBlock,
    };
  });
}

const REFUSALS = {
  already_member: 'Personen är redan administratör i butiken.',
  not_addable: 'Adressen kan inte läggas till som administratör.',
  member_limit: `Butiken har redan ${MEMBER_LIMIT} administratörer. Ta bort någon först.`,
  cannot_revoke_self: REVOKE_BLOCK.self,
  last_admin: REVOKE_BLOCK.last_admin,
  invalid_request: 'Ange ett namn (högst 100 tecken) och en giltig e-postadress.',
  rate_limited: 'För många inbjudningar just nu. Försök igen om en stund.',
};

/** True when the API says the person was added but the invitation could not be sent. */
export const isInviteMailFailure = (error) => error?.status === 503 && error?.code === 'email_unavailable';

export const INVITE_MAIL_FAILED = 'Administratören lades till, men inbjudan kunde inte skickas. Försök igen om en stund.';

/** A refusal of invite or revoke in the page's language; null for anything else. */
export function memberActionMessage(error) {
  if (!error) return null;
  if (error.status === 429) return REFUSALS.rate_limited;
  if (isInviteMailFailure(error)) return INVITE_MAIL_FAILED;
  if (error.status === 404) return 'Administratören hittades inte, eller så kan butikens administratörer inte hanteras här.';
  return typeof error.code === 'string' ? REFUSALS[error.code] ?? null : null;
}
