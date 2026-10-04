// The data of the console's "Tryckjobb" page (unit CP5-FP). Platform requests
// only (no X-Shop-Id). Tested under Node against the dev API (fpData.test.mjs).
//
//   the list      GET /v1/platform/print-jobs with the page's filters, a page
//                 at a time ("Visa fler" = the next cursor). The default view
//                 ("inte skickade") is asked as dispatchState=accepted with no
//                 state, and the shipped jobs are left out here: when a whole
//                 page holds none to show, the next is read at once (up to
//                 SCAN_PAGES), so the view is not empty while more exist
//   one job       the list again, from the cursor just before the job, one row
//                 (adapters/printJobs.js cursorBefore): the read a confirm is
//                 built on, the re-check at the confirm, and a read-back
//   a status      POST …/:jobId/status; a lost answer (no answer, a 5xx, an
//                 unreadable 2xx) is read back before anything is said: stored
//                 → done; the job as it was → not saved; else → unclear. The
//                 printer's exception (CP6-PS4) goes the same way: its two
//                 bodies, `{ exception: "out_of_stock" | "resolved" }`, are a
//                 status body each (adapters/printJobs.js actionBody)
//   the filters   the shops (GET /v1/platform/tenants) and the printers (GET
//                 /v1/platform/printers: their ids and names only); a list
//                 that cannot be read leaves its filter at "Alla"

import { listPrintJobs, readAllPrinters, readAllTenants, setPrintJobStatus } from '../../../api/admin/platform.js';
import { isLostAnswer } from '../../adapters/platformModels.js';
import { readFailureMessage } from '../../adapters/platformSettings.js';
import { cursorBefore, keepsJob, listParams, statusHolds, statusRefusalText } from '../../adapters/printJobs.js';
import { pageError } from './platformSettingsData.js';

export const PAGE_SIZE = 50;
const SCAN_PAGES = 5;

/** The filters' choices → { shops: [{ id, name }], printers: [{ id, name }] }. */
export async function loadFilterChoices() {
  const [shops, printers] = await Promise.all([
    readAllTenants().then((rows) => rows.map((t) => ({ id: t.tenantId, name: t.shopName || t.tenantId })), () => []),
    readAllPrinters().then(({ printers: rows }) => rows.map((p) => ({ id: p.printerId, name: p.name || p.printerId })), () => []),
  ]);
  const byName = (a, b) => a.name.localeCompare(b.name, 'sv');
  return { shops: shops.sort(byName), printers: printers.sort(byName) };
}

/** One view of the list from `cursor` → { jobs (to show), nextCursor }. */
export async function loadJobs(filters, cursor = null) {
  const params = listParams(filters);
  const jobs = [];
  let next = cursor;
  try {
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const answer = await listPrintJobs({ ...params, cursor: next ?? undefined, limit: PAGE_SIZE });
      jobs.push(...answer.jobs.filter((job) => keepsJob(filters, job)));
      next = answer.nextCursor;
      if (next === null || jobs.length > 0) break;
    }
  } catch (error) {
    throw pageError(readFailureMessage(error, 'Tryckjobben'), error);
  }
  return { jobs, nextCursor: next };
}

/** The job as the server holds it now, or null when the list no longer has it. Throws when it cannot be read. */
export async function readJob(job) {
  try {
    const { jobs } = await listPrintJobs({ tenantId: job.tenantId, cursor: cursorBefore(job) ?? undefined, limit: 1 });
    return jobs[0]?.jobId === job.jobId ? jobs[0] : null;
  } catch (error) {
    throw pageError(readFailureMessage(error, 'Tryckjobbet'), error);
  }
}

const unclear = (cause, fresh) => pageError(
  'Anslutningen bröts och det är oklart om statusen sparades. Ladda om sidan och kontrollera innan du försöker igen.',
  cause,
  fresh ? { fresh } : {},
);

/** A refused write: its sentence, with the job as it is now when that can be read (`fresh`). */
async function refused(job, error, body) {
  let fresh = null;
  try {
    fresh = await readJob(job);
  } catch {
    // The sentence stands without the row.
  }
  return pageError(statusRefusalText(error, body), error, fresh ? { fresh } : {});
}

/** The facts a body would move: the state, or the exception and its resolution. */
const sameMoved = (a, b, body) => (body.exception
  ? (a.exception ?? null) === (b.exception ?? null) && (a.exceptionResolvedAt ?? null) === (b.exceptionResolvedAt ?? null)
  : (a.state ?? null) === (b.state ?? null));

/**
 * Records `body` (adapters/printJobs.js actionBody) for `job`. → { job (as
 * stored, the row's other fields kept), changed, orderShipped (null: not
 * known after a read-back), readBack }.
 */
export async function recordStatus(job, body) {
  let answer;
  try {
    answer = await setPrintJobStatus(job.jobId, body);
    if (!answer.job) throw Object.assign(new Error('The answer did not carry the job'), { code: 'bad_response' });
  } catch (error) {
    if (!isLostAnswer(error)) throw await refused(job, error, body);
    let fresh;
    try {
      fresh = await readJob(job);
    } catch {
      throw unclear(error);
    }
    if (fresh && statusHolds(fresh, body)) return { job: fresh, changed: true, orderShipped: null, readBack: true };
    if (fresh && sameMoved(fresh, job, body)) {
      throw pageError('Anslutningen bröts och statusen sparades inte. Försök igen.', error, { fresh });
    }
    throw unclear(error, fresh);
  }
  const { state, trackingNumber, trackingUrl, carrier, exception = null, exceptionResolvedAt = null } = answer.job;
  return {
    job: { ...job, state, trackingNumber, trackingUrl, carrier, exception, exceptionResolvedAt },
    changed: answer.changed,
    orderShipped: answer.orderShipped,
    readBack: false,
  };
}
