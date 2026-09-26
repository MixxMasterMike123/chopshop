const DISABLED_RETRY_SECONDS = 300;

export function handleDisabledAuthEmailQueue(
  batch: MessageBatch<unknown>,
): void {
  console.warn(
    JSON.stringify({
      message: "auth email delivery is disabled",
      messageCount: batch.messages.length,
      queue: batch.queue,
    }),
  );
  batch.retryAll({ delaySeconds: DISABLED_RETRY_SECONDS });
}
