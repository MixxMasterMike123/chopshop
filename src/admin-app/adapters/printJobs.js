// The console's "Tryckjobb" page (unit CP5-FP): its filters, what a row may
// do, the confirm of a status, and the sentences. Pure; tested under Node in
// printJobs.test.mjs. Nothing here talks to the API (printJobsData.js does).
//
// A job is ONE printer line of an order (`{orderId}-{lineNo}`). The status
// route (cloudflare/src/dispatch/production-status.ts) moves a job forward
// only (in_production → produced → shipped, skipping allowed), only once the
// printer accepted it, never on a cancelled or refunded order; the tracking
// comes with `shipped` only and is written once. What the confirm says beyond
// the line is that file's header and commerce/fulfilment.ts's
// printerShippedOrderStatements (CP5_FP_REPORT.md cites each sentence).
//
// CP6-PS4: the printer's exception (CP6-PS3, production-status.ts). A job may
// be reported out of stock after the printer accepted it (`{ exception:
// "out_of_stock" }`), and that exception closed without the printer sending
// the line (`{ exception: "resolved" }`). What each one offers and says is
// below; CP6_PS4_REPORT.md cites each sentence's source.

export const PRODUCTION_STATES = Object.freeze(['in_production', 'produced', 'shipped']);
const RANK = { in_production: 1, produced: 2, shipped: 3 };

export const STATE_LABEL = Object.freeze({
  none: 'Ingen rapport ännu',
  in_production: 'I produktion',
  produced: 'Producerad',
  shipped: 'Skickad',
});

export const DISPATCH_LABEL = Object.freeze({
  none: 'I kö, inte skickad till tryckeriet',
  pending: 'Väntar på att skickas',
  submitting: 'Skickas till tryckeriet',
  accepted: 'Mottagen av tryckeriet',
  unknown: 'Svar saknas: okänt om tryckeriet fick jobbet',
  failed: 'Tryckeriet tog inte emot jobbet',
  cancelled: 'Avbruten',
});

export const ORDER_STATUS_LABEL = Object.freeze({
  paid: 'Betald',
  processing: 'Behandlas',
  printed: 'Tryckt',
  shipped: 'Skickad',
  ready_for_pickup: 'Klar att hämta',
  delivered: 'Levererad',
  completed: 'Slutförd',
  partially_refunded: 'Delvis återbetald',
  refunded: 'Återbetald',
  cancelled: 'Avbruten',
});

/**
 * The order statuses the status route refuses a job of: commerce/fulfilment.ts
 * openSql (`status NOT IN ('refunded', 'cancelled')`), the guard of every
 * status write. (It also refuses an order cancelled by its `cancelled_at`, or
 * refunded to its charge, which the row does not carry: the 409's reason says
 * so then.)
 */
export const REFUSED_ORDER_STATUSES = Object.freeze(['cancelled', 'refunded']);

const stateOf = (job) => job?.state ?? null;

// ── the printer's exception (CP6-PS3) ───────────────────────────────────────

/**
 * Where a job's exception stands: 'open' (reported, not closed, not shipped),
 * 'restocked' (reported, then shipped after all), 'resolved' (closed without
 * the printer sending the line), or null (none reported).
 */
export function exceptionState(job) {
  if (!job?.exception) return null;
  if (job.exceptionResolvedAt) return 'resolved';
  return stateOf(job) === 'shipped' ? 'restocked' : 'open';
}

/** The states the route would take for `job` now, in order: none for a job it refuses. */
export function nextStates(job) {
  if (!job || job.dispatchState !== 'accepted' || REFUSED_ORDER_STATUSES.includes(job.orderStatus)) return [];
  // After a resolution nothing follows (`exception_resolved`); while the
  // exception is open only the printer's `shipped` (`out_of_stock` otherwise).
  const exception = exceptionState(job);
  if (exception === 'resolved') return [];
  if (exception === 'open') return ['shipped'];
  const rank = RANK[stateOf(job)] ?? 0;
  return PRODUCTION_STATES.filter((state) => RANK[state] > rank);
}

/** The two exception bodies, in the order a row offers them. */
export const EXCEPTION_ACTIONS = Object.freeze(['out_of_stock', 'resolved']);

/**
 * The exception bodies the route would take for `job` now:
 *   out_of_stock  an accepted line in an open order, not produced or shipped,
 *                 with no exception yet (`not_accepted`, `cancelled`,
 *                 `refunded`, `produced` otherwise; a repeat is a no-op)
 *   resolved      an open exception, on any order, closed or not (a
 *                 resolution is the human's bookkeeping; `no_exception`,
 *                 `produced` otherwise)
 */
export function exceptionActions(job) {
  if (!job) return [];
  const exception = exceptionState(job);
  if (exception === 'open') return ['resolved'];
  if (exception !== null) return [];
  const recordable = job.dispatchState === 'accepted'
    && !REFUSED_ORDER_STATUSES.includes(job.orderStatus)
    && (stateOf(job) === null || stateOf(job) === 'in_production');
  return recordable ? ['out_of_stock'] : [];
}

const isExceptionAction = (action) => EXCEPTION_ACTIONS.includes(action);

/** Whether the route would take `action` (a state or an exception body) for `job` now. */
export function offersAction(job, action) {
  return isExceptionAction(action) ? exceptionActions(job).includes(action) : nextStates(job).includes(action);
}

/**
 * Why a row offers no step of its state, as a line on the row, or null (it
 * offers some, it is shipped, its exception is closed and says so itself, or
 * there is nothing to add to its state: a job whose answer was lost,
 * `unknown`, is resolved outside this page and the console has no page for
 * it, so the row only shows the state).
 */
export function actionBlockText(job) {
  if (!job || nextStates(job).length > 0 || stateOf(job) === 'shipped' || exceptionState(job) === 'resolved') return null;
  if (job.orderStatus === 'cancelled') return 'Ordern är avbruten: ingen status rapporteras.';
  if (job.orderStatus === 'refunded') return 'Ordern är återbetald: ingen status rapporteras.';
  if (job.dispatchState === 'cancelled') return 'Raden är avbruten: ingen status rapporteras.';
  if (job.dispatchState === 'unknown') return null;
  if (job.dispatchState !== 'accepted') return 'Tryckeriet har inte tagit emot jobbet, så ingen status kan rapporteras.';
  return null;
}

// ── the filters ─────────────────────────────────────────────────────────────

/**
 * The page's filters. `state` 'open' (the default) is "not shipped yet": the
 * list takes ONE value per filter, so it is asked without a state and the
 * shipped jobs are left out here (keepsJob); 'all' asks without a state.
 * `dispatchState` 'accepted' is the default: the jobs a person acts on.
 */
export const DEFAULT_FILTERS = Object.freeze({ state: 'open', dispatchState: 'accepted', exception: 'all', tenantId: '', printerId: '' });

export const STATE_FILTERS = Object.freeze([
  ['open', 'Inte skickade'],
  ['all', 'Alla'],
  ['none', STATE_LABEL.none],
  ['in_production', STATE_LABEL.in_production],
  ['produced', STATE_LABEL.produced],
  ['shipped', STATE_LABEL.shipped],
]);

/**
 * CP6-PS4. The list's `exception=out_of_stock` holds every reported line,
 * closed or not: 'open' asks it and leaves out the restocked and the
 * resolved here (keepsJob), as the 'open' state leaves out the shipped.
 */
export const EXCEPTION_FILTERS = Object.freeze([
  ['all', 'Alla'],
  ['open', 'Slut i lager, inte stängda'],
  ['none', 'Inget undantag'],
]);

export const DISPATCH_FILTERS = Object.freeze([
  ['accepted', 'Mottagna av tryckeriet'],
  ['all', 'Alla'],
  ['none', 'I kö'],
  ['pending', 'Väntar'],
  ['submitting', 'Skickas'],
  ['unknown', 'Svar saknas'],
  ['failed', 'Inte mottagna'],
  ['cancelled', 'Avbrutna'],
]);

/** The list's query for `filters` (one value per key; empty keys left out). */
export function listParams(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return {
    state: f.state === 'open' || f.state === 'all' ? undefined : f.state,
    dispatchState: f.dispatchState === 'all' ? undefined : f.dispatchState,
    exception: f.exception === 'open' ? 'out_of_stock' : f.exception === 'none' ? 'none' : undefined,
    tenantId: f.tenantId || undefined,
    printerId: f.printerId || undefined,
  };
}

/** Whether a listed job shows under `filters` (the 'open' view leaves the shipped out; open exceptions only their own). */
export function keepsJob(filters, job) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  if (f.state === 'open' && stateOf(job) === 'shipped') return false;
  return f.exception !== 'open' || exceptionState(job) === 'open';
}

/**
 * What an empty view says. `more`: the list has pages not read yet (the
 * default view reads ahead a few pages of shipped jobs and may stop before
 * the list ends), so nothing is said to be absent and the page offers to go on.
 */
export function emptyViewText(filters, more) {
  if (more) return 'Inget tryckjobb att visa bland de som lästs hittills. Listan fortsätter: sök vidare.';
  return isDefaultFilters(filters)
    ? 'Inga tryckjobb att hantera: tryckeriet har inget mottaget jobb som inte är skickat.'
    : 'Inga tryckjobb matchar filtret.';
}

export const isDefaultFilters = (filters) =>
  Object.entries(DEFAULT_FILTERS).every(([key, value]) => (filters?.[key] ?? value) === value);

// ── reading one job back through the list ───────────────────────────────────

/** The UUID just before `uuid` in the list's order (same length, hex), or null for the first. */
function previousUuid(uuid) {
  const chars = uuid.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (chars[i] === '-') continue;
    if (chars[i] === '0') {
      chars[i] = 'f';
      continue;
    }
    chars[i] = (parseInt(chars[i], 16) - 1).toString(16);
    return chars.join('');
  }
  return null;
}

/**
 * The list's cursor whose next job is `job` (the list is ordered by order id,
 * then line, and starts AFTER the cursor): the line before it in its order,
 * or for a first line the last possible line of the order id just before.
 * null: no cursor (the very first job id).
 */
export function cursorBefore(job) {
  if (job.lineNo > 1) return `${job.orderId}-${job.lineNo - 1}`;
  const previous = previousUuid(job.orderId);
  return previous ? `${previous}-9999` : null;
}

/** The facts of a job a confirm is built on. */
export function sameJobFacts(a, b) {
  return ['state', 'dispatchState', 'orderStatus', 'trackingNumber', 'trackingUrl', 'carrier', 'exception', 'exceptionResolvedAt']
    .every((key) => (a?.[key] ?? null) === (b?.[key] ?? null));
}

// ── the tracking (shipped only), as the route takes it ──────────────────────

const CONTROL = /[\u0000-\u001f\u007f]/;

function textField(value, max) {
  const text = String(value ?? '').trim();
  if (text === '') return { value: null };
  return text.length > max || CONTROL.test(text) ? { bad: true } : { value: text };
}

/**
 * The status body for `state`: `{ body }`, or `{ problems }` (sentences) when
 * a tracking field would be refused (production-status.ts
 * parseProductionStatusInput: trimmed, no control characters, a number of at
 * most 100, a carrier of at most 60, an https address of at most 500 without
 * credentials or spaces). Empty fields are left out.
 */
export function statusBody(state, tracking = {}) {
  if (state !== 'shipped') return { body: { state } };
  const problems = [];
  const number = textField(tracking.trackingNumber, 100);
  const carrier = textField(tracking.carrier, 60);
  const url = textField(tracking.trackingUrl, 500);
  if (number.bad) problems.push('Spårningsnumret får vara högst 100 tecken, på en rad.');
  if (carrier.bad) problems.push('Fraktbolaget får vara högst 60 tecken, på en rad.');
  let urlOk = !url.bad;
  if (urlOk && url.value !== null) {
    try {
      const parsed = new URL(url.value);
      urlOk = parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
        && !url.value.includes(' ') && url.value.startsWith('https://');
    } catch {
      urlOk = false;
    }
  }
  if (!urlOk) problems.push('Länken ska vara en https-adress (som börjar med https://), högst 500 tecken och utan mellanslag.');
  if (problems.length > 0) return { problems };
  const body = { state };
  if (number.value !== null) body.trackingNumber = number.value;
  if (url.value !== null) body.trackingUrl = url.value;
  if (carrier.value !== null) body.carrier = carrier.value;
  return { body };
}

/** The body of `action`: an exception body, or statusBody's (with its tracking checks). */
export function actionBody(action, tracking = {}) {
  return isExceptionAction(action) ? { body: { exception: action } } : statusBody(action, tracking);
}

/** Whether a job holds what a status (or exception) body wrote (a lost answer read back). */
export function statusHolds(job, body) {
  if (body.exception === 'out_of_stock') return job?.exception === 'out_of_stock';
  if (body.exception === 'resolved') return Boolean(job?.exceptionResolvedAt);
  if (stateOf(job) !== body.state) return false;
  if (body.state !== 'shipped') return true;
  return (job.trackingNumber ?? null) === (body.trackingNumber ?? null)
    && (job.trackingUrl ?? null) === (body.trackingUrl ?? null)
    && (job.carrier ?? null) === (body.carrier ?? null);
}

// ── the confirm ─────────────────────────────────────────────────────────────

const lineText = (job) =>
  `${job.quantity} × ${job.name}${job.variantLabel ? ` (${job.variantLabel})` : ''}, artikel ${job.sku}`;

/**
 * What recording `state` for `job` does, said before it is sent, from the
 * route's own code (each sentence's source is in CP5_FP_REPORT.md). Built on
 * the job as just read.
 */
export function statusConfirm(job, state) {
  const label = STATE_LABEL[state];
  const lines = [
    `${job.shopName || job.tenantId}, order ${job.orderNumber}, rad ${job.lineNo}: ${lineText(job)}.`,
    `Statusen går bara framåt: när raden är "${label.toLowerCase()}" kan den inte få en tidigare status igen.`,
  ];
  if (state === 'in_production') {
    lines.push('Ordern kan fortfarande avbrytas eller återbetalas helt. Då skapas ett ärende om att avbryta jobbet hos tryckeriet, som plattformen sköter för hand.');
  } else {
    lines.push('Efter det kan butiken inte avbryta ordern (det blir ett returärende), och en full återbetalning betalar tillbaka köparen men skapar inget ärende om att avbryta jobbet hos tryckeriet.');
  }
  if (state === 'shipped') {
    lines.push('När alla tryckrader i ordern är skickade kan butiken markera ordern som skickad eller klar att hämta.');
    lines.push('Är det här den sista oskickade raden i en order där alla rader trycks och skickas med paket till köparen, markeras hela ordern som skickad direkt, och köparen får ett mejl om att den är skickad (ett mejl per order).');
    lines.push('Spårningsuppgifterna nedan kan bara anges nu: de sparas på raden tillsammans med statusen och kan inte läggas till eller ändras efteråt. De visas inte för köparen eller butiken.');
  }
  lines.push('Ändringen loggas med ditt konto och tidpunkten.');
  return {
    title: `Rapportera "${label}" för order ${job.orderNumber}, rad ${job.lineNo}?`,
    lines,
    confirmLabel: `Rapportera ${label.toLowerCase()}`,
    tone: 'primary',
  };
}

/** The two exception bodies' confirms, from the route's own code (sources in CP6_PS4_REPORT.md). */
export function exceptionConfirm(job, action) {
  const where = `order ${job.orderNumber}, rad ${job.lineNo}`;
  const head = `${job.shopName || job.tenantId}, ${where}: ${lineText(job)}.`;
  if (action === 'out_of_stock') {
    return {
      title: `Rapportera "slut i lager" för ${where}?`,
      lines: [
        head,
        'Tryckeriet har tagit emot jobbet men meddelar att plagget är slut i lager. Det sparas på raden och kan inte tas bort efteråt.',
        'Ordern hålls kvar: butiken kan inte markera den som skickad eller klar att hämta, och den markeras inte som skickad av sig själv, förrän raden är skickad eller undantaget är stängt.',
        'I butikens order står raden som misslyckad, utan någon orsak.',
        'Ett larm skapas för plattformen, ett per rad.',
        'Inga pengar flyttas, och köparen får inget mejl.',
        'Därefter kan raden bara rapporteras som skickad (om tryckeriet får in plagget och skickar det), eller så stänger du undantaget.',
        'Ändringen loggas med ditt konto och tidpunkten.',
      ],
      confirmLabel: 'Rapportera slut i lager',
      tone: 'primary',
    };
  }
  const closed = REFUSED_ORDER_STATUSES.includes(job.orderStatus);
  return {
    title: `Stäng undantaget för ${where}?`,
    lines: [
      head,
      'Gör det bara när tryckeriet inte kommer att skicka raden, och köparen och butiken redan har fått det utrett för hand (till exempel med en återbetalning av raden).',
      'Raden skickas inte, och ingen status kan rapporteras på den efteråt. Det går inte att ångra.',
      // A closed order is shipped by no one (fulfilment.ts order_closed, openSql in the auto-ship).
      ...(closed
        ? [`Ordern är ${job.orderStatus === 'cancelled' ? 'avbruten' : 'återbetald'}, så ingenting mer händer med den, och inget mejl skickas.`]
        : [
          'Raden håller inte längre kvar ordern: butiken kan markera ordern som skickad eller klar att hämta när de andra tryckraderna är skickade.',
          'Är det här den sista oskickade raden i en order där alla rader trycks och skickas med paket till köparen, och en annan rad redan är skickad, markeras hela ordern som skickad direkt, och köparen får ett mejl om att den är skickad.',
        ]),
      'Inga pengar flyttas av det här. Larmet om slut i lager stängs inte heller: det stängs för sig.',
      'Ändringen loggas med ditt konto och tidpunkten.',
    ],
    confirmLabel: 'Stäng undantaget',
    tone: 'danger',
  };
}

/** The confirm of `action` for `job`: a step of its state, or an exception body. */
export function actionConfirm(job, action) {
  return isExceptionAction(action) ? exceptionConfirm(job, action) : statusConfirm(job, action);
}

/** The row's line about its exception, or null. */
export function exceptionText(job) {
  switch (exceptionState(job)) {
    case 'open':
      // A closed order is held by nothing: its own refusal is said beside it (actionBlockText).
      return REFUSED_ORDER_STATUSES.includes(job.orderStatus)
        ? 'Tryckeriet har meddelat att plagget är slut i lager.'
        : 'Tryckeriet har meddelat att plagget är slut i lager. Ordern hålls kvar tills raden skickas eller undantaget stängs.';
    case 'restocked':
      return 'Tryckeriet hade plagget slut i lager men har skickat raden.';
    case 'resolved': {
      const at = timeText(job.exceptionResolvedAt);
      return `Undantaget stängdes${at ? ` ${at}` : ''}: tryckeriet skickar inte raden.`;
    }
    default:
      return null;
  }
}

/** The sentence when `action` is no longer offered for the job as read now. */
export function actionMovedText(job, action) {
  const where = `Order ${job.orderNumber}, rad ${job.lineNo} har ändrats sedan listan lästes`;
  if (action === 'out_of_stock') return `${where}, och slut i lager kan inte rapporteras nu. Raden visar läget.`;
  if (action === 'resolved') return `${where}, och undantaget kan inte stängas nu. Raden visar läget.`;
  return `${where} och kan inte få statusen "${STATE_LABEL[action].toLowerCase()}" nu. Raden visar läget.`;
}

/** The sentence when the job moved while the confirm was open and `action` is no longer offered. */
export function actionGoneText(action) {
  return isExceptionAction(action)
    ? 'Tryckjobbet ändrades medan rutan var öppen, och ändringen kan inte göras nu. Ingenting skickades; raden visar läget.'
    : 'Tryckjobbet ändrades medan rutan var öppen och kan inte få den statusen nu. Ingenting skickades; raden visar läget.';
}

// ── the sentences after a write ─────────────────────────────────────────────

/** After an answer (or a read-back that found the status stored). */
export function statusDoneText(job, state, { changed = true, orderShipped = false, readBack = false } = {}) {
  const head = `Order ${job.orderNumber}, rad ${job.lineNo}: ${STATE_LABEL[state].toLowerCase()}.`;
  if (readBack) {
    return `${head} Svaret kom aldrig fram, men statusen är sparad.${state === 'shipped' ? ' Om hela ordern därmed markerades som skickad kunde inte läsas här.' : ''}`;
  }
  if (!changed) return `${head} Raden hade redan den statusen med samma uppgifter; ingenting ändrades.`;
  return orderShipped ? `${head} Hela ordern är nu markerad som skickad, och köparen får ett mejl om det.` : head;
}

/** After an exception body's answer (or a read-back that found it stored). */
export function exceptionDoneText(job, action, { changed = true, orderShipped = false, readBack = false } = {}) {
  const where = `Order ${job.orderNumber}, rad ${job.lineNo}`;
  if (action === 'out_of_stock') {
    if (readBack) return `${where}: slut i lager är rapporterat. Svaret kom aldrig fram, men ändringen är sparad.`;
    if (!changed) return `${where}: slut i lager var redan rapporterat; ingenting ändrades.`;
    return `${where}: slut i lager är rapporterat. Ordern hålls kvar tills raden skickas eller undantaget stängs.`;
  }
  if (readBack) {
    return `${where}: undantaget är stängt. Svaret kom aldrig fram, men ändringen är sparad. Om hela ordern därmed markerades som skickad kunde inte läsas här.`;
  }
  if (!changed) return `${where}: undantaget var redan stängt; ingenting ändrades.`;
  return `${where}: undantaget är stängt, och raden skickas inte.${orderShipped ? ' Hela ordern är nu markerad som skickad, och köparen får ett mejl om det.' : ''}`;
}

/** After `action`'s answer: the page's line. */
export function actionDoneText(job, action, result) {
  return isExceptionAction(action) ? exceptionDoneText(job, action, result) : statusDoneText(job, action, result);
}

/** After `action`'s answer: the toast. */
export function actionToastText(action, { orderShipped = false } = {}) {
  if (action === 'out_of_stock') return 'Slut i lager är rapporterat.';
  if (action === 'resolved') return orderShipped ? 'Undantaget är stängt och ordern är skickad.' : 'Undantaget är stängt.';
  return orderShipped ? 'Statusen är sparad och ordern är skickad.' : 'Statusen är sparad.';
}

const REFUSAL_REASONS = {
  not_accepted: 'Tryckeriet har inte tagit emot jobbet, så ingen status kan rapporteras.',
  cancelled: 'Ordern eller raden är avbruten: ingen status kan rapporteras.',
  refunded: 'Ordern är återbetald: ingen status kan rapporteras.',
  backwards: 'Raden har redan en senare status, och statusen går bara framåt.',
  tracking_differs: 'Raden är redan skickad med andra spårningsuppgifter, och de kan inte ändras.',
  // CP6-PS3's four.
  out_of_stock: 'Tryckeriet har rapporterat slut i lager för raden: nu kan den bara rapporteras som skickad, eller så stänger du undantaget.',
  exception_resolved: 'Undantaget för raden är stängt: raden skickas inte, och ingen status kan rapporteras.',
  no_exception: 'Tryckeriet har inte rapporterat slut i lager för raden, så det finns inget undantag att stänga.',
};

// `produced` answers both exception bodies, each for its own reason.
const PRODUCED_REASONS = {
  out_of_stock: 'Raden är redan producerad eller skickad, så plagget fanns i lager: slut i lager kan inte rapporteras.',
  resolved: 'Raden är redan skickad, så det finns inget undantag att stänga.',
};

/** A refused status (or exception) write → the sentence (the row is read again beside it). `body`: what was sent. */
export function statusRefusalText(error, body = null) {
  if (error?.code === 'unauthenticated') return error.message;
  if (error?.code === 'print_job_status_not_allowed') {
    const reason = error.reason ?? error.details?.reason;
    if (reason === 'produced' && PRODUCED_REASONS[body?.exception]) return PRODUCED_REASONS[body.exception];
    return REFUSAL_REASONS[reason] ?? 'Tryckjobbet kan inte få den statusen.';
  }
  if (error?.code === 'conflict') return 'Jobbet ändrades samtidigt av något annat. Raden visar läget nu; försök igen om det behövs.';
  if (error?.code === 'invalid_request') {
    return 'Servern tog inte emot uppgifterna: spårningsnumret högst 100 tecken, fraktbolaget högst 60 och länken en https-adress.';
  }
  if (error?.status === 404) return 'Jobbet finns inte, eller så är raden inte ett tryckjobb. Ladda om sidan.';
  if (error?.code === 'network_error') return 'Ändringen kunde inte skickas: servern kunde inte nås.';
  return `Ändringen gick inte igenom: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).`;
}

/** "2 okt. 2026 08:10", or '' when not a time. */
export function timeText(iso) {
  const at = typeof iso === 'string' ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
