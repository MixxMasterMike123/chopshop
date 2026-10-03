// Who signed: the Worker's SignerView (cloudflare/src/legal/signer.ts) as the
// pages print it, where the older build printed `email || uid`.
//
//   { kind: 'admin' | 'platform', name: string | null, email: string | null }
//
// A person of the shop is named by the address, else the name. A platform
// account is "Plattformen": the shop is never told which person (the Worker
// sends no name or address to a shop for it); the platform console may be, and
// then sees the person. Pure.

export const PLATFORM_SIGNER_LABEL = 'Plattformen';

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

/** The signer's label, or '' when the answer names no one (the page then prints its own fallback). */
export function signerLabelOf(signer) {
  if (!signer || typeof signer !== 'object') return '';
  const person = text(signer.email) || text(signer.name);
  if (signer.kind === 'platform') return person || PLATFORM_SIGNER_LABEL;
  return person;
}
