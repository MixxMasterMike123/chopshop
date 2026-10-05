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

// ── "Skicka inbjudan igen" (unit CP5-FP) ────────────────────────────────────
// POST /v1/admin/members/:userId/resend-invite → 202 { invite: { userId,
// surface, expiresAt } }: a new 72-hour link is queued and the previous
// unused one is dead. 409 not_invited (the person has set a password) ·
// 409 not_invitable · 429 (Retry-After) · 503 email_unavailable (the old link
// is already superseded: WK open question 3) · 404 (no longer a member here,
// OR the route is dark: invite mail not configured in this environment).

/** "15 minuter", "1 timme": a Retry-After as words, or null. */
function waitText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return `${Math.ceil(seconds)} sekunder`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} ${minutes === 1 ? 'minut' : 'minuter'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} ${hours === 1 ? 'timme' : 'timmar'}`;
}

/** The sentence after a new link was sent. */
export function resendDoneMessage(email, invite) {
  if (invite?.mailConfigured === false) return mailNotSentMessage(email);
  const until = typeof invite?.expiresAt === 'string' && !Number.isNaN(Date.parse(invite.expiresAt))
    ? ` Den gäller till ${new Date(invite.expiresAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })}.`
    : '';
  return `En ny inbjudningslänk har skickats till ${email}. Den tidigare länken fungerar inte längre.${until}`;
}

/**
 * CP9-OB: an invite was accepted but this environment has no mail account
 * (the Worker's `mailConfigured` false), so no mail left. Said plainly: the
 * person cannot sign in until mail works. Never the link or a token.
 */
export function mailNotSentMessage(email) {
  return `Inget mejl skickades: e-post är inte inställd här ännu. ${email} kan inte logga in förrän e-posten fungerar och inbjudan skickas igen.`;
}

/**
 * A refused or failed resend → { message, reload }: the sentence, and whether
 * the list must be read again (the person's row is no longer what it shows).
 * A 404 is decided by the caller after that re-read (resendGoneMessage).
 * null for a lost answer (the caller says it is unclear).
 */
export function resendRefusal(error, email) {
  if (error?.status === 409 && error.code === 'not_invited') {
    return { message: `${email} har redan valt ett lösenord, så ingen ny inbjudan behövs.`, reload: true };
  }
  if (error?.status === 409 && error.code === 'not_invitable') {
    return { message: `${email} kan inte bjudas in: kontot är spärrat av plattformen.`, reload: false };
  }
  if (error?.status === 429) {
    const wait = waitText(error.retryAfterSeconds);
    return { message: `För många inbjudningar på kort tid. Försök igen ${wait ? `om ${wait}` : 'om en stund'}.`, reload: false };
  }
  if (isInviteMailFailure(error)) {
    return { message: 'Inbjudan kunde inte skickas just nu, och den tidigare länken fungerar inte längre. Försök igen om en stund.', reload: false };
  }
  if (error?.code === 'unauthenticated') return { message: error.message, reload: false };
  return null;
}

/**
 * A 404, after the list was read again: the person is gone from the list →
 * no longer a member here; still listed → the route itself is off here
 * (invite mail is not set up in this environment).
 */
export function resendGoneMessage(stillListed, email) {
  return stillListed
    ? 'Inbjudningar kan inte skickas igen härifrån just nu: e-post för inbjudningar är inte påslagen i den här miljön.'
    : `${email} är inte längre administratör i butiken.`;
}

/** A resend whose answer was lost: nothing a route shows tells whether it went. */
export const RESEND_UNCLEAR =
  'Anslutningen bröts, så det är oklart om en ny inbjudan skickades. Om den skickades fungerar bara den nya länken. Du kan skicka igen.';
