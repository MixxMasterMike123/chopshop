import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { downloadToFile, putFile, TransferError } from "../src/transfer.ts";

const URL_IN = "https://acct.r2.cloudflarestorage.com/b/in?X-Amz-Signature=s";
const URL_OUT = "https://acct.r2.cloudflarestorage.com/b/out?X-Amz-Signature=s";

let dir = "";
let counter = 0;
const next = (name: string) => join(dir, `${name}-${(counter += 1)}`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-transfer-test-"));
});
afterAll(async () => {
  await rm(dir, { force: true, recursive: true });
});

/** A body that arrives in chunks and declares no length. */
function chunked(chunks: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof TransferError ? `${error.code}/${error.detail}` : `other/${String(error)}`;
  }
  return "resolved";
}

describe("downloadToFile", () => {
  it("streams the bytes to disk with a GET that never follows a redirect", async () => {
    const payload = Buffer.alloc(100_000, 3);
    const calls: RequestInit[] = [];
    const path = next("in");
    const bytes = await downloadToFile(
      async (_url, init) => {
        calls.push(init ?? {});
        return new Response(payload, { headers: { "content-length": String(payload.length) } });
      },
      URL_IN,
      payload.length,
      path,
    );
    expect(bytes).toBe(100_000);
    expect(await readFile(path)).toStrictEqual(payload);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.redirect).toBe("error");
  });

  it("refuses a declared length over the cap before reading a byte", async () => {
    const path = next("in");
    const code = await codeOf(
      downloadToFile(
        async () => new Response(Buffer.alloc(10), { headers: { "content-length": "11" } }),
        URL_IN,
        10,
        path,
      ),
    );
    expect(code).toBe("input_too_large/declared");
    expect(existsSync(path)).toBe(false);
  });

  it("aborts a stream that runs past the cap even with no length declared", async () => {
    const code = await codeOf(
      downloadToFile(
        async () => new Response(chunked([Buffer.alloc(6), Buffer.alloc(6)])),
        URL_IN,
        10,
        next("in"),
      ),
    );
    expect(code).toBe("input_too_large/streamed");
  });

  it("names the status of a refused GET and the error of a failed one — never the URL", async () => {
    expect(
      await codeOf(downloadToFile(async () => new Response("denied", { status: 403 }), URL_IN, 10, next("in"))),
    ).toBe("input_fetch_failed/status_403");
    expect(
      await codeOf(
        downloadToFile(
          async () => {
            throw new TypeError("fetch failed");
          },
          URL_IN,
          10,
          next("in"),
        ),
      ),
    ).toBe("input_fetch_failed/TypeError");
  });
});

describe("putFile", () => {
  it("PUTs the file with its length and type, and hashes exactly the bytes sent", async () => {
    const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    const path = next("out");
    await writeFile(path, payload);
    let received = Buffer.alloc(0);
    let seen: RequestInit = {};
    const report = await putFile(
      async (_url, init) => {
        seen = init ?? {};
        received = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        return new Response(null, { status: 200 });
      },
      URL_OUT,
      path,
      "image/png",
    );
    expect(received).toStrictEqual(payload);
    expect(report).toStrictEqual({
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    expect(seen.method).toBe("PUT");
    expect(seen.redirect).toBe("error");
    expect(seen.headers).toStrictEqual({ "content-length": "300000", "content-type": "image/png" });
  });

  it("fails with the status of a refused PUT (e.g. a signature mismatch)", async () => {
    const path = next("out");
    await writeFile(path, Buffer.alloc(10));
    const code = await codeOf(
      putFile(
        async (_url, init) => {
          await new Response(init?.body ?? null).arrayBuffer();
          return new Response("SignatureDoesNotMatch", { status: 403 });
        },
        URL_OUT,
        path,
        "image/png",
      ),
    );
    expect(code).toBe("output_put_failed/status_403");
  });

  it("fails when the answer arrives before the whole body was sent", async () => {
    const path = next("out");
    await writeFile(path, Buffer.alloc(200_000));
    const code = await codeOf(
      putFile(async () => new Response(null, { status: 200 }), URL_OUT, path, "image/png"),
    );
    expect(code).toBe("output_put_failed/short_body");
  });
});
