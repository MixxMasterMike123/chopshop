// The platform's settings and the brand filter (unit CP5-FL): what the console
// pages say about each value, the confirms of the changes that move money or
// the storefront, and the server's refusals as Swedish sentences.
// PURE: no React, no fetch; tested under Node (platformSettings.test.mjs).
//
// Every number shown is the server's (cloudflare/src/platform/platform-settings.ts,
// cloudflare/src/catalog/screening.ts). The browser only parses what the
// operator types (a percentage, a count) into the unit the Worker takes; it
// computes no fee, no product count and no consequence.
//
// What each change does (CP3_D_REPORT.md §4, §7; screening-core.ts):
//   defaultCommissionBps  the fee of every payment of a shop WITHOUT its own fee,
//                         frozen when the payment starts (the PaymentIntent);
//                         a started payment keeps its fee. 0..800 (D45).
//   reviewFirstProducts   N: a shop's first N products wait for the platform's
//                         approval. Decided once, at a product's first
//                         screening: a product already waiting keeps waiting.
//   screeningHardBlock    ON: every filter hit takes a product off the storefront,
//                         in the same write (approved products only on a hit
//                         new to them). OFF lifts no block: a blocked product
//                         stays blocked until the platform approves it.
//   refundApplicationFee, reverseDisputeOnCreated   fixed in code; shown only.

// ── the settings ────────────────────────────────────────────────────────────

/** The Worker's cap on the default fee (MAX_DEFAULT_COMMISSION_BPS, D45). */
export const MAX_DEFAULT_COMMISSION_BPS = 800;
/** The Worker's cap on N (MAX_REVIEW_FIRST_PRODUCTS). */
export const MAX_REVIEW_FIRST_PRODUCTS = 100;

/** "5,00 %" for 500, "—" when not a count of basis points. */
export function percentText(bps) {
  if (!Number.isInteger(bps) || bps < 0) return '—';
  const whole = Math.floor(bps / 100);
  const cents = String(bps % 100).padStart(2, '0');
  return `${whole},${cents} %`;
}

/** The input's starting text for a fee: "5" for 500, "5,25" for 525. */
export function percentInput(bps) {
  if (!Number.isInteger(bps) || bps < 0) return '';
  const cents = bps % 100;
  return cents === 0 ? String(bps / 100) : `${Math.floor(bps / 100)},${String(cents).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * A typed percentage → basis points, exactly (no rounding): "6", "6,5",
 * "6.25 %". → { bps } or { problem } (a Swedish sentence).
 */
export function parsePercent(text) {
  const m = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(String(text ?? ''));
  if (!m) return { problem: 'Skriv avgiften i procent, t.ex. 5 eller 5,25 (högst två decimaler).' };
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (bps > MAX_DEFAULT_COMMISSION_BPS) {
    return { problem: `Standardavgiften får vara högst ${percentText(MAX_DEFAULT_COMMISSION_BPS)}: prisgolvet för tryckta produkter räknar med högst 8 %.` };
  }
  return { bps };
}

/** A typed count of products → { value } or { problem }. */
export function parseReviewCount(text) {
  const m = /^\s*(\d{1,3})\s*$/.exec(String(text ?? ''));
  const value = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(value) || value > MAX_REVIEW_FIRST_PRODUCTS) {
    return { problem: `Skriv ett heltal från 0 till ${MAX_REVIEW_FIRST_PRODUCTS}.` };
  }
  return { value };
}

/** "3 produkter" / "1 produkt" / "Av" for N. */
export function reviewCountText(n) {
  if (!Number.isInteger(n)) return '—';
  if (n === 0) return 'Av';
  return n === 1 ? '1 produkt' : `${n} produkter`;
}

/** What each setting means, one plain sentence each (the page shows them all). */
export const SETTING_MEANINGS = Object.freeze({
  defaultCommissionBps:
    'Plattformens avgift i procent av varje betalning, för butiker som inte har en egen avgift (den sätts på butikens sida under Butiker).',
  refundApplicationFee:
    'När en order återbetalas behåller plattformen sin avgift; den betalas inte tillbaka till butiken.',
  reverseDisputeOnCreated:
    'När en köpare bestrider en betalning dras det omtvistade beloppet från butiken så fort tvisten öppnas, inte först när den avgörs.',
  reviewFirstProducts:
    'Så många av en ny butiks första produkter måste du godkänna under Anmälningar → Granskning innan de syns i butiken. 0 stänger av förhandsgranskningen.',
  screeningHardBlock:
    'På: varje träff i varumärkesfiltret tar produkten ur butiken. Av: bara ord märkta "Spärrar" gör det; andra träffar flaggar produkten för granskning men den ligger kvar.',
  screeningTermsVersion:
    'Räknas upp vid varje ändring av filtret. Publicerade produkter som granskats mot en äldre version granskas om automatiskt.',
});

/** The value shown for a read-only policy. */
export const refundFeeText = (v) => (v === true ? 'Återbetalas till butiken' : v === false ? 'Behålls av plattformen' : '—');
export const disputeText = (v) => (v === true ? 'Direkt när tvisten öppnas' : v === false ? 'När tvisten avgjorts' : '—');

/** The fields a patch names whose value on the server moved since `loaded`. */
export function staleFields(loaded, fresh, patch) {
  return Object.keys(patch ?? {}).filter((key) => loaded?.[key] !== fresh?.[key]);
}

/** The settings the PATCH answer carries all hold the patch's values. */
export function patchApplied(settings, patch) {
  return Boolean(settings) && Object.entries(patch ?? {}).every(([key, value]) => settings[key] === value);
}

/** The Swedish sentence for a setting whose value someone else changed. */
export function staleSettingMessage(key, fresh) {
  const now = key === 'defaultCommissionBps' ? percentText(fresh?.[key])
    : key === 'reviewFirstProducts' ? reviewCountText(fresh?.[key])
      : key === 'screeningHardBlock' ? (fresh?.[key] ? 'På' : 'Av') : String(fresh?.[key]);
  return `Inställningen har ändrats av någon annan sedan sidan lästes (den är nu ${now}). Sidan visar nu det nya värdet; gör om ändringen om den fortfarande behövs.`;
}

/**
 * The confirm of a money- or storefront-relevant change: { title, lines,
 * confirmLabel, tone }. `from` = the server's value read just before.
 */
export function commissionConfirm(fromBps, toBps) {
  return {
    title: `Ändra standardavgiften från ${percentText(fromBps)} till ${percentText(toBps)}?`,
    lines: [
      'Gäller alla butiker som inte har en egen avgift. Butiker med egen avgift påverkas inte.',
      'Den nya avgiften gäller betalningar som startar efter att du sparat. En betalning som redan har startat behåller sin avgift.',
      'Säljarna ser avgiften som ett belopp per order.',
    ],
    confirmLabel: `Ändra till ${percentText(toBps)}`,
    tone: 'primary',
  };
}

export function hardBlockConfirm(next) {
  return next
    ? {
        title: 'Slå på "Alla träffar spärrar"?',
        lines: [
          'Direkt när du sparar tas varje publicerad produkt vars text träffar något ord i filtret bort ur butikerna.',
          'En produkt du godkänt för hand ligger kvar, så länge inget nytt ord träffar den.',
          'Produkter vars text servern inte har kontrollerat än tas om hand av omgranskningen, högst 25 åt gången var 15:e minut.',
        ],
        confirmLabel: 'Slå på – spärra alla träffar',
        tone: 'danger',
      }
    : {
        title: 'Slå av "Alla träffar spärrar"?',
        lines: [
          'Från nu flaggar en träff bara produkten för granskning, utom för ord märkta "Spärrar".',
          'Produkter som redan spärrats ligger kvar spärrade. Du släpper dem genom att godkänna dem under Anmälningar → Granskning.',
        ],
        confirmLabel: 'Slå av',
        tone: 'primary',
      };
}

/** The line after a change of the filter or of the hard block (`rescreen` the server's summary). */
export function rescreenSummaryText(rescreen) {
  if (!rescreen || typeof rescreen !== 'object') return null;
  const parts = [];
  if (Number.isInteger(rescreen.blockedNow) && rescreen.blockedNow > 0) {
    parts.push(rescreen.blockedNow === 1
      ? '1 produkt togs bort ur butiken direkt.'
      : `${rescreen.blockedNow} produkter togs bort ur butikerna direkt.`);
  }
  parts.push(...backlogLines(rescreen));
  return parts.length > 0 ? parts.join(' ') : null;
}

function backlogLines({ pending, unverified } = {}) {
  const lines = [];
  if (Number.isInteger(pending) && pending > 0) {
    lines.push(pending === 1
      ? '1 publicerad produkt väntar på omgranskning.'
      : `${pending} publicerade produkter väntar på omgranskning.`);
  }
  if (Number.isInteger(unverified) && unverified > 0) {
    lines.push(unverified === 1
      ? '1 publicerad produkt saknar en text som servern har kontrollerat och kan inte stämmas av direkt mot filtret.'
      : `${unverified} publicerade produkter saknar en text som servern har kontrollerat och kan inte stämmas av direkt mot filtret.`);
  }
  return lines;
}

// ── the brand filter's terms ────────────────────────────────────────────────

/** The Worker's kinds (SCREENING_TERM_KINDS), with their labels. */
export const TERM_KINDS = Object.freeze([
  { value: 'band', label: 'Band/artist' },
  { value: 'brand', label: 'Varumärke' },
  { value: 'club', label: 'Klubb/lag' },
  { value: 'other', label: 'Annat' },
]);
export const termKindLabel = (kind) => TERM_KINDS.find((k) => k.value === kind)?.label ?? kind ?? '—';

/** The Worker's caps. */
export const MAX_TERM_NOTE_LENGTH = 500;
export const MAX_SCREENING_TERMS = 2000;
export const RESCREEN_BATCH = 25;

/** A form's values → the POST body, or { problem }. The term's own rules are the server's. */
export function newTermBody({ term, kind, hardBlock, note }) {
  const text = String(term ?? '').trim();
  if (text === '') return { problem: 'Skriv ordet som ska filtreras.' };
  const noteText = String(note ?? '').trim();
  if (noteText.length > MAX_TERM_NOTE_LENGTH) return { problem: `Anteckningen får vara högst ${MAX_TERM_NOTE_LENGTH} tecken.` };
  if (!TERM_KINDS.some((k) => k.value === kind)) return { problem: 'Välj en typ.' };
  return { body: { term: text, kind, hardBlock: hardBlock === true, note: noteText === '' ? null : noteText } };
}

/** The fields an edit changes (only those are sent: the Worker writes the named ones). */
export function termChanges(term, draft) {
  const out = {};
  if (draft.kind !== term.kind) out.kind = draft.kind;
  if ((draft.hardBlock === true) !== (term.hardBlock === true)) out.hardBlock = draft.hardBlock === true;
  const note = String(draft.note ?? '').trim();
  if ((note === '' ? null : note) !== (term.note ?? null)) out.note = note === '' ? null : note;
  return out;
}

/** The confirm of a term change that moves the storefront, or null when none is needed. */
/**
 * `globalHardBlock`: "Alla träffar spärrar" is on, so every term blocks
 * whatever its own flag says (isHardBlock in screening-core.ts).
 */
export function addTermConfirm(body, globalHardBlock = false) {
  if (body.hardBlock !== true && globalHardBlock !== true) return null;
  return {
    title: `Lägga till "${body.term}" som spärrande ord?`,
    lines: [
      'Direkt när du sparar tas varje publicerad produkt vars text innehåller ordet bort ur butikerna, även produkter du godkänt för hand.',
      ...(body.hardBlock === true ? [] : ['Ordet spärrar fast det inte är markerat, eftersom "Alla träffar spärrar" är på under Allmänt.']),
      'Produkter vars text servern inte har kontrollerat än tas om hand av omgranskningen.',
    ],
    confirmLabel: 'Lägg till och spärra',
    tone: 'danger',
  };
}

export function updateTermConfirm(term, changes, globalHardBlock = false) {
  if (globalHardBlock === true && changes.hardBlock !== undefined) {
    return {
      title: changes.hardBlock ? `Markera "${term.term}" som spärrande?` : `Ta bort markeringen "Spärrar" från "${term.term}"?`,
      lines: [
        '"Alla träffar spärrar" är på under Allmänt, så ordet spärrar redan, med eller utan markering. Ändringen märks först om du slår av det.',
      ],
      confirmLabel: 'Spara markeringen',
      tone: 'primary',
    };
  }
  if (changes.hardBlock === true) {
    return {
      title: `Låta "${term.term}" spärra?`,
      lines: [
        'Direkt när du sparar tas varje publicerad produkt vars text innehåller ordet bort ur butikerna, även produkter du godkänt för hand om ordet är nytt för dem.',
      ],
      confirmLabel: 'Spärra',
      tone: 'danger',
    };
  }
  if (changes.hardBlock === false) {
    return {
      title: `Sluta spärra på "${term.term}"?`,
      lines: [
        'Nya träffar flaggar bara produkten för granskning.',
        'Produkter som redan spärrats av ordet ligger kvar spärrade. Du släpper dem genom att godkänna dem under Anmälningar → Granskning.',
      ],
      confirmLabel: 'Sluta spärra',
      tone: 'primary',
    };
  }
  return null;
}

export function deleteTermConfirm(term, globalHardBlock = false) {
  return {
    title: `Ta bort "${term.term}" ur filtret?`,
    lines: term.hardBlock || globalHardBlock === true
      ? [
          'Produkter som spärrats bara av det här ordet kommer tillbaka i butiken, flaggade för granskning, när omgranskningen når dem: inom ungefär 15 minuter, eller direkt med "Granska om nu".',
          'Produkter som plattformen avpublicerat för hand förblir avpublicerade.',
        ]
      : [
          'Ordet flaggar inga nya produkter. Produkter som redan flaggats för det ligger kvar i granskningskön tills du hanterar dem.',
        ],
    confirmLabel: 'Ta bort ordet',
    tone: 'danger',
  };
}

/** The confirm of a re-screen run; with the global hard block on, every hit blocks. */
export function rescreenConfirm(globalHardBlock = false) {
  return {
    title: 'Granska om publicerade produkter nu?',
    lines: [
      `Servern granskar om upp till ${RESCREEN_BATCH} publicerade produkter vars granskning är äldre än filtret, samma sak som görs automatiskt var 15:e minut.`,
      ...(globalHardBlock === true
        ? ['En produkt som träffar något ord i filtret tas bort ur butiken, eftersom "Alla träffar spärrar" är på.']
        : [
            'En produkt som träffar ett spärrande ord tas bort ur butiken.',
            'En produkt som träffar ett nytt ord flaggas och hamnar under Anmälningar → Granskning, men ligger kvar i butiken. En ny butiks första produkter väntar på ditt godkännande.',
          ]),
      'En produkt som spärrats av ett ord som sedan tagits bort kommer tillbaka i butiken, flaggad.',
      'Produkter som plattformen avpublicerat för hand förblir avpublicerade.',
    ],
    confirmLabel: `Granska om upp till ${RESCREEN_BATCH}`,
    tone: 'primary',
  };
}

/** The line after a re-screen run (the server's counts). */
export function rescreenResultText(result) {
  if (!result || !Number.isInteger(result.rescreened)) return null;
  const done = result.rescreened === 0
    ? 'Ingen produkt behövde granskas om.'
    : result.rescreened === 1 ? '1 produkt granskades om.' : `${result.rescreened} produkter granskades om.`;
  const rest = backlogLines(result);
  return [done, ...(rest.length > 0 ? rest : ['Alla publicerade produkter är granskade mot filtret som det ser ut nu.'])].join(' ');
}

/**
 * After an add whose answer was lost: the term the read-back found that was
 * not there before, with the kind, flag and note sent. → the term, null when
 * none, or 'unclear' when several new terms appeared (someone else added too).
 */
export function findAddedTerm(before, after, body) {
  const known = new Set((before ?? []).map((t) => t.termKey));
  const fresh = (after ?? []).filter((t) => !known.has(t.termKey));
  const same = fresh.filter((t) => t.kind === body.kind && t.hardBlock === body.hardBlock && (t.note ?? null) === (body.note ?? null));
  if (same.length === 1 && fresh.length === 1) return same[0];
  if (fresh.length === 0) return null;
  return 'unclear';
}

/** The term holds every field of `changes`. */
export const termHolds = (term, changes) =>
  Boolean(term) && Object.entries(changes).every(([key, value]) => (term[key] ?? null) === value);

// ── the server's refusals ───────────────────────────────────────────────────

/**
 * Any refusal of the settings and filter routes → a Swedish sentence. `what`
 * names the change; `term` = the request carried a filter term.
 */
export function refusalMessage(error, { what = 'Ändringen', term = false } = {}) {
  const code = error?.code;
  if (code === 'unauthenticated') return error.message;
  if (code === 'network_error') return `${what} kunde inte skickas: servern kunde inte nås.`;
  if (code === 'duplicate_term') return 'Filtret har redan ett ord som matchar samma text (stora och små bokstäver, accenter och skiljetecken räknas inte).';
  if (code === 'term_limit') return `Filtret är fullt: det rymmer högst ${MAX_SCREENING_TERMS.toLocaleString('sv-SE')} ord. Ta bort ord som inte behövs.`;
  if (code === 'conflict') return 'Filtret eller granskningsinställningarna ändrades samtidigt av någon annan. Ladda om sidan och försök igen.';
  if (code === 'setting_not_editable') return 'Den inställningen är låst i koden och kan inte ändras här.';
  if (code === 'rate_limited') return 'För många ändringar på kort tid. Vänta en stund och försök igen.';
  if (error?.status === 404 && term) return 'Ordet finns inte längre i filtret: någon annan har tagit bort det. Ladda om sidan.';
  if (code === 'invalid_request' && error?.details?.field === 'defaultCommissionBps') {
    return `Servern tog inte emot avgiften: den ska vara mellan 0 och ${percentText(MAX_DEFAULT_COMMISSION_BPS)}.`;
  }
  if (code === 'invalid_request' && error?.details?.field === 'reviewFirstProducts') {
    return `Servern tog inte emot antalet: det ska vara ett heltal från 0 till ${MAX_REVIEW_FIRST_PRODUCTS}.`;
  }
  if (code === 'invalid_request' && term) {
    return 'Servern tog inte emot ordet: det måste innehålla en bokstav eller siffra i latinska alfabetet (eller bara symboler, t.ex. ™), vara högst 200 tecken och sakna styrtecken.';
  }
  return `${what} gick inte igenom: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).`;
}

/** A read that failed → the sentence the page shows instead of the content. */
export function readFailureMessage(error, what) {
  if (error?.code === 'unauthenticated') return error.message;
  if (error?.code === 'network_error') return `${what} kunde inte läsas: servern kunde inte nås.`;
  return `${what} kunde inte läsas: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).`;
}
