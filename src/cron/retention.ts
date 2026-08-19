/**
 * Nightly retention cleanup: drop old transcript lines, delete old media
 * files. Pure-ish (take `now` as a parameter) so tests don't need real time.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Drops transcript.jsonl lines older than retentionDays. Router owns the
 * transcript line format; this looks for a numeric `receivedAt` (falling
 * back to `ts`/`timestamp`/`at`) and keeps any line whose timestamp can't be
 * determined, to avoid destroying data on an unrecognized/legacy shape.
 */
export function pruneTranscript(transcriptPath: string, retentionDays: number, now: number = Date.now()): void {
  if (!existsSync(transcriptPath)) return;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const kept = lines.filter((line) => {
    const ts = extractTimestamp(line);
    return ts === undefined || ts >= cutoff;
  });
  writeFileSync(transcriptPath, kept.length ? kept.join("\n") + "\n" : "");
}

function extractTimestamp(line: string): number | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    for (const key of ["receivedAt", "ts", "timestamp", "at"]) {
      const v = obj[key];
      if (typeof v === "number") return v;
    }
  } catch {
    /* not JSON — keep the line */
  }
  return undefined;
}

/** Deletes files in mediaDir older than retentionDays, by mtime. */
export function pruneMedia(mediaDir: string, retentionDays: number, now: number = Date.now()): void {
  if (!existsSync(mediaDir)) return;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(mediaDir)) {
    const file = join(mediaDir, name);
    const stat = statSync(file);
    if (stat.isFile() && stat.mtimeMs < cutoff) rmSync(file);
  }
}
