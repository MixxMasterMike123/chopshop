/**
 * Resident-memory numbers for the benchmark (docs/cf-port/RENDER_BENCHMARK.md).
 *
 * Linux: VmHWM (the resident high-water mark) and VmRSS from /proc/self/status,
 * and the high-water mark can be reset by writing "5" to /proc/self/clear_refs —
 * so with one job at a time the peak reported at job end is THAT job's peak
 * (libvips' native buffers included, which the JS heap statistics never see).
 * Anywhere else (the macOS test run): the process-lifetime peak from
 * process.resourceUsage(), clearly not per job.
 */
import { readFileSync, writeFileSync } from "node:fs";

function procStatusKb(field: string): number | null {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(status);
    return match?.[1] === undefined ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Resets the resident high-water mark; false where that is not possible. */
export function resetPeakRss(): boolean {
  try {
    writeFileSync("/proc/self/clear_refs", "5");
    return true;
  } catch {
    return false;
  }
}

export function memorySnapshotMb(): { peakRssMb: number; rssMb: number } {
  const peakKb = procStatusKb("VmHWM");
  const rssKb = procStatusKb("VmRSS");
  const toMb = (kb: number) => Math.round(kb / 1024);
  return {
    // resourceUsage().maxRSS is in kilobytes (Node docs), lifetime peak.
    peakRssMb: toMb(peakKb ?? process.resourceUsage().maxRSS),
    rssMb: rssKb === null ? Math.round(process.memoryUsage.rss() / 1024 / 1024) : toMb(rssKb),
  };
}
