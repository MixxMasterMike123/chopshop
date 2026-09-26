import { describe, expect, it, vi } from "vitest";

import { handleDisabledAuthEmailQueue } from "../src/email/disabled-email-queue";

describe("disabled auth-email Queue consumer", () => {
  it("retries every accidental message without inspecting its sensitive body", () => {
    const retryAll = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const batch = {
      messages: [
        {
          body: {
            actionUrl: "https://should-not-appear.example/token",
            recipient: "should-not-appear@example.test",
          },
        },
      ],
      queue: "meteorshop-stg-email-auth",
      retryAll,
    } as unknown as MessageBatch<unknown>;

    handleDisabledAuthEmailQueue(batch);

    expect(retryAll).toHaveBeenCalledOnce();
    expect(retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(warn).toHaveBeenCalledOnce();
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("auth email delivery is disabled");
    expect(logged).not.toContain("should-not-appear");
    warn.mockRestore();
  });
});
