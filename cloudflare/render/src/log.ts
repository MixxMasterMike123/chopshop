/**
 * JSON-line logging to stdout (Workers Logs collects container stdout). Callers pass
 * only ids, codes, sizes and timings: never a token, a URL or a response body.
 */
export type LogValue = boolean | number | string | string[] | null;
export type Logger = (
  level: "error" | "info" | "warn",
  event: string,
  fields: Record<string, LogValue>,
) => void;

export const jsonLog: Logger = (level, event, fields) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`,
  );
};
