// The dashboard's "Kom igång" checklist (CP9-OB item 3), pure: the facts the
// admin already reads, in, the steps the seller sees, out. Tested under Node
// in onboarding.test.mjs. The reads are the dashboard data module's
// (src/admin-app/replacements/adminDashboardData.js loadOnboarding).
//
// The facts:
//   status    GET /v1/admin/legal/status: the platform terms (accepted, inGrace),
//             the checkout's readiness (returnAddress, vatAnswered,
//             legalPagesAccepted) and what an adoption would be refused for
//             (identityMissing, CP9-OB)
//   shop      GET /v1/admin/shop `shop`: `published` (the platform's go-live)
//   payments  the payments page's view (adapters/payments.js toPagePayments,
//             or notEnabledPayments when the Connect route answers 404)
//   products  GET /v1/admin/products, one page: `published`, `takenDown`,
//             `screeningStatus` per product
//   pod       the shop has the print-on-demand add-on (its products start in
//             the studio)
//
// Each step: { key, state, title, text, note?, to?, linkLabel? }. `state`:
//   'done'      nothing to do
//   'todo'      the seller acts: `text` says what, `to` is the page
//   'platform'  only the platform can do it: `text` says what it does, and
//               `note` (PLATFORM_STEP_NOTE) says it is not the seller's
//   'waiting'   someone else is on it (Stripe's review): `text` says who
// No figure of any kind: no price, fee, cost or count beyond "x av y".

export const PLATFORM_STEP_NOTE = 'Plattformen gör det här steget.';

const listText = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} och ${names.at(-1)}`);

// The identity facts as the sentence names them (legal-identity.ts fields, then the checkout's two).
const FACT_NAMES = {
  legalName: 'juridiskt namn',
  address: 'adress',
  orgNumber: 'organisationsnummer',
  vatNumber: 'momsregistreringsnummer',
  returnAddress: 'returadress',
  vatAnswered: 'om butiken är momsregistrerad',
};

function termsStep(status) {
  const done = status?.accepted === true || status?.inGrace === true;
  return done
    ? { key: 'terms', state: 'done', title: 'Plattformsvillkor', text: 'Godkända.' }
    : {
      key: 'terms',
      state: 'todo',
      title: 'Plattformsvillkor',
      text: 'Läs och godkänn plattformens villkor.',
      to: '/admin/plattformsvillkor',
      linkLabel: 'Öppna villkoren',
    };
}

function identityStep(status) {
  const missing = Array.isArray(status?.identityMissing) ? status.identityMissing : [];
  const readiness = status?.readiness || {};
  const sellerFacts = [
    ...['legalName', 'address', 'orgNumber', 'vatNumber'].filter((key) => missing.includes(key)),
    ...(readiness.returnAddress === true ? [] : ['returnAddress']),
    ...(readiness.vatAnswered === true ? [] : ['vatAnswered']),
  ];
  const supportMissing = missing.includes('supportEmail');
  if (sellerFacts.length > 0) {
    return {
      key: 'identity',
      state: 'todo',
      title: 'Butikens uppgifter',
      text: `Fyll i ${listText(sellerFacts.map((key) => FACT_NAMES[key]))} under Inställningar.${
        supportMissing ? ' Support-e-posten lägger plattformen in.' : ''}`,
      to: '/admin/settings',
      linkLabel: 'Öppna Inställningar',
    };
  }
  if (supportMissing) {
    return { key: 'identity', state: 'platform', title: 'Butikens uppgifter', text: 'Plattformen lägger in butikens support-e-post.' };
  }
  return { key: 'identity', state: 'done', title: 'Butikens uppgifter', text: 'Ifyllda.' };
}

function legalStep(status) {
  return status?.readiness?.legalPagesAccepted === true
    ? { key: 'legal', state: 'done', title: 'Juridiska sidor', text: 'Godkända.' }
    : {
      key: 'legal',
      state: 'todo',
      title: 'Juridiska sidor',
      text: 'Läs igenom och godkänn köpvillkor, ångerrätt och integritetspolicy längst ned på sidan Inställningar.',
      to: '/admin/settings',
      linkLabel: 'Öppna Inställningar',
    };
}

function paymentsStep(payments) {
  if (payments?.chargesEnabled === true) {
    return { key: 'payments', state: 'done', title: 'Betalningar', text: 'Butiken kan ta betalt.' };
  }
  if (payments?.connectEnabled !== true) {
    return { key: 'payments', state: 'platform', title: 'Betalningar', text: 'Plattformen öppnar betalningar för butiken.' };
  }
  if (payments.connectStatus === 'pending') {
    return { key: 'payments', state: 'waiting', title: 'Betalningar', text: 'Stripe granskar dina uppgifter. Du behöver inte göra något just nu.' };
  }
  return {
    key: 'payments',
    state: 'todo',
    title: 'Betalningar',
    text: payments.stripeAccountId === true
      ? 'Fyll i det som saknas i Stripes formulär under Utbetalningar.'
      : 'Fyll i Stripes formulär under Utbetalningar så att butiken kan ta betalt.',
    to: '/admin/payments',
    linkLabel: 'Öppna Utbetalningar',
  };
}

function productStep(products, pod) {
  const live = (Array.isArray(products) ? products : []).filter((p) => p && p.published === true && p.takenDown !== true);
  const create = {
    key: 'product',
    state: 'todo',
    title: 'Första produkten',
    text: pod
      ? 'Skapa din första produkt i designstudion under Print on demand och publicera den.'
      : 'Lägg upp din första produkt och publicera den.',
    to: pod ? '/admin/pod' : '/admin/products',
    linkLabel: pod ? 'Öppna Print on demand' : 'Öppna Produkter',
  };
  if (live.length === 0) return create;
  // The server's statuses (cloudflare/src/catalog/screening-core.ts): 'pending'
  // is held for the platform's review, 'blocked' is refused; neither is in
  // the shop. Anything else (approved, flagged, none) is.
  if (live.some((p) => p.screeningStatus !== 'pending' && p.screeningStatus !== 'blocked')) {
    return { key: 'product', state: 'done', title: 'Första produkten', text: 'Publicerad.' };
  }
  if (live.some((p) => p.screeningStatus === 'pending')) {
    return {
      key: 'product',
      state: 'platform',
      title: 'Första produkten',
      text: 'Produkten är sparad och visas i butiken när plattformen har granskat den.',
    };
  }
  return {
    key: 'product',
    state: 'todo',
    title: 'Första produkten',
    text: 'Plattformen godkände inte produkten. Öppna den under Produkter för att se varför.',
    to: '/admin/products',
    linkLabel: 'Öppna Produkter',
  };
}

function liveStep(shop) {
  return shop?.published === true
    ? { key: 'live', state: 'done', title: 'Butiken är publicerad', text: 'Köpare kan hitta butiken.' }
    : { key: 'live', state: 'platform', title: 'Butiken publiceras', text: 'Plattformen publicerar butiken när stegen ovan är klara.' };
}

/** The six steps, in the order a new shop meets them. */
export function onboardingSteps({ status, shop, payments, products, pod = false }) {
  return [
    termsStep(status),
    identityStep(status),
    legalStep(status),
    paymentsStep(payments),
    productStep(products, pod),
    liveStep(shop),
  ].map((step) => (step.state === 'platform' ? { ...step, note: PLATFORM_STEP_NOTE } : step));
}

/** True when nothing is left: the checklist is not shown. */
export function onboardingComplete(steps) {
  return Array.isArray(steps) && steps.every((step) => step.state === 'done');
}
