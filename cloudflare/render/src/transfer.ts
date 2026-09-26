/**
 * The two byte transfers of a job, both streamed:
 *
 *   downloadToFile — the input GET (a presigned R2 URL) streamed to a file,
 *                    aborting the moment the running total passes the cap; the
 *                    bytes past the cap are never written and sharp never sees
 *                    an oversized file.
 *   putFile        — an output PUT (a presigned R2 URL) streamed from its file,
 *                    with the sha256 computed over exactly the bytes sent.
 *
 * Neither follows a redirect (`redirect: "error"`): a redirect would move a
 * capability URL's request to a host the allowlist never approved. Neither reads,
 * logs or returns anything from a response body. Errors are TransferError with a
 * code the API accepts as a fail code, plus a short `detail` for the log (an HTTP
 * status or an error name — never a URL).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

import type { FailureCode } from "./contract.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class TransferError extends Error {
  readonly code: FailureCode;
  readonly detail: string;

  constructor(code: FailureCode, detail: string) {
    super(code);
    this.name = "TransferError";
    this.code = code;
    this.detail = detail;
  }
}

/** Bounds each transfer; a stalled R2 connection must not hold a lease forever. */
export const TRANSFER_TIMEOUT_MS = 180_000;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful can come of a failed discard.
  }
}

export async function downloadToFile(
  fetchImpl: FetchLike,
  url: string,
  maxBytes: number,
  path: string,
): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransferError("input_fetch_failed", errorName(error));
  }

  if (!response.ok || response.body === null) {
    await discard(response);
    throw new TransferError("input_fetch_failed", `status_${response.status}`);
  }

  // A header that claims too much is refused before the first chunk; an absent or
  // lying one changes nothing, because the running total below is the authority.
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw new TransferError("input_too_large", "declared");
  }

  let total = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new TransferError("input_too_large", "streamed"));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      cap,
      // `wx`: the job's private temp dir is fresh, so an existing file is a bug.
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (error instanceof TransferError) {
      throw error;
    }
    throw new TransferError("input_fetch_failed", errorName(error));
  }

  return total;
}

export async function putFile(
  fetchImpl: FetchLike,
  url: string,
  path: string,
  contentType: string,
): Promise<{ bytes: number; sha256: string }> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  let sent = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      sent += chunk.length;
      callback(null, chunk);
    },
  });
  // Errors surface through the request body: a read failure destroys `hashing`,
  // which errors the stream fetch is consuming, which rejects the fetch.
  pipeline(createReadStream(path), hashing).catch(() => undefined);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      body: Readable.toWeb(hashing) as unknown as ReadableStream<Uint8Array>,
      // The content type is signed into the presigned URL (render-farm-client.ts):
      // any other value is a 403 SignatureDoesNotMatch. R2 needs an explicit
      // Content-Length for a PUT; with it, Node's fetch sends the stream unchunked.
      headers: { "content-length": String(size), "content-type": contentType },
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      // Required by Node's fetch for a streamed request body.
      ...({ duplex: "half" } as Record<string, unknown>),
    });
  } catch (error) {
    hashing.destroy();
    throw new TransferError("output_put_failed", errorName(error));
  }

  await discard(response);
  if (!response.ok) {
    hashing.destroy();
    throw new TransferError("output_put_failed", `status_${response.status}`);
  }
  // The hash must describe exactly the object R2 now holds; a short read would make
  // it describe something else.
  if (sent !== size) {
    hashing.destroy();
    throw new TransferError("output_put_failed", "short_body");
  }

  return { bytes: size, sha256: hash.digest("hex") };
}
