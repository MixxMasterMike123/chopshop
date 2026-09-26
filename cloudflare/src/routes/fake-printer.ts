import {
  fakePrinterJobExists,
  isFakePrinterEnabled,
  listFakePrinterJobs,
  MAX_FAKE_PRINTER_PAYLOAD_LENGTH,
  readSubmittedJobId,
  recordFakePrinterJob,
  validateSnapwearJob,
} from "../dispatch/fake-printer";
import {
  SNAPWEAR_DUPLICATE_JOB_MESSAGE,
  SNAPWEAR_VALIDATION_FAILED_MESSAGE,
} from "../dispatch/snapwear-wire";
import { readBearerToken, secretMatches } from "../lib/bearer";
import { jsonResponse } from "../lib/http";
import {
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";

/**
 * `/v1/staging/fake-printer/jobs` — SnapWear's `POST /api/order/add` stand-in
 * (PLAN §2.6, §2.3), plus a read for the CP2 tests.
 *
 *   POST  SnapWear job body          201 { id, status: "accepted" }
 *                                    400 { status: "error", message } duplicate job_id
 *                                    422 { status: "error", message: "Validation Failed", errors }
 *   GET   ?orderId=<uuid>            200 { jobs: [...] } — what was received
 *
 * THE ROUTE DOES NOT EXIST unless APP_ENV = "staging" AND DISPATCH_TARGET =
 * "fake-printer" AND FAKE_PRINTER_TOKEN is set (isFakePrinterEnabled): anything
 * else — production, a staging pointed at SnapWear, a missing token, a wrong
 * bearer — is the same opaque 404 an unknown path gets, decided before any D1
 * access. That is also why there is no rate limiter here: an unauthenticated
 * caller reaches nothing but a hash compare.
 *
 * Validation runs AFTER the duplicate check, the way an idempotent API should
 * behave: re-submitting an accepted job id is answered "already have it"
 * whatever the body now says.
 */
function snapwearError(
  status: number,
  message: string,
  errors?: Record<string, string[]>,
): Response {
  return jsonResponse(
    errors === undefined
      ? { message, status: "error" }
      : { errors, message, status: "error" },
    status,
  );
}

function duplicateResponse(): Response {
  return snapwearError(400, SNAPWEAR_DUPLICATE_JOB_MESSAGE);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function handleFakePrinterRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (!isFakePrinterEnabled(env)) {
    return routeNotFoundResponse();
  }

  const presented = readBearerToken(request.headers.get("authorization"));
  if (
    presented === null ||
    !(await secretMatches(presented, env.FAKE_PRINTER_TOKEN as string))
  ) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const orderId = new URL(request.url).searchParams.get("orderId");
    if (orderId === null || !UUID_PATTERN.test(orderId)) {
      return invalidRequestResponse();
    }
    return jsonResponse({ jobs: await listFakePrinterJobs(env.DB, orderId) });
  }

  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }

  const body = await readJsonBody(request);

  const submittedJobId = readSubmittedJobId(body);
  if (submittedJobId !== null && (await fakePrinterJobExists(env.DB, submittedJobId))) {
    return duplicateResponse();
  }

  const validation = validateSnapwearJob(body);
  if (validation.status === "invalid") {
    return snapwearError(422, SNAPWEAR_VALIDATION_FAILED_MESSAGE, validation.errors);
  }

  const payloadJson = JSON.stringify(body);
  if (payloadJson.length > MAX_FAKE_PRINTER_PAYLOAD_LENGTH) {
    return snapwearError(422, SNAPWEAR_VALIDATION_FAILED_MESSAGE, {
      body: ["The request body is too large."],
    });
  }

  const recorded = await recordFakePrinterJob(env.DB, {
    jobId: submittedJobId as string,
    now: Date.now(),
    orderId: validation.orderId,
    payloadJson,
  });

  switch (recorded.status) {
    case "accepted":
      return jsonResponse({ id: recorded.id, status: "accepted" }, 201);
    case "duplicate":
      return duplicateResponse();
    case "unknown_order":
      return snapwearError(422, SNAPWEAR_VALIDATION_FAILED_MESSAGE, {
        job_id: ["The job id does not reference a known order."],
      });
  }
}
