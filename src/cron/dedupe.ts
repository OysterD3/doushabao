/**
 * Cron fire-log dedupe guard: restart double-fire protection (binding
 * decision). Records are stored as a pruned JSON array at paths.cronFired;
 * functions take an explicit path with that default so tests can point at a
 * tmp file instead of the real var/ directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../shared/paths.ts";

interface FireRecord {
  jobId: string;
  firedAt: number;
}

const DEDUPE_WINDOW_MS = 55_000;
/** Kept well past the dedupe window so the file doesn't grow unbounded. */
const FIRE_LOG_RETAIN_MS = 5 * 60_000;

function readFireLog(file: string): FireRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as FireRecord[]) : [];
  } catch {
    return [];
  }
}

function writeFireLog(file: string, records: FireRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(records));
}

/** True when jobId fired within the last 55s. */
export function shouldSkipFire(jobId: string, now: number, fireLogPath: string = paths.cronFired): boolean {
  return readFireLog(fireLogPath).some((r) => r.jobId === jobId && now - r.firedAt < DEDUPE_WINDOW_MS);
}

/** Records a fire so a near-simultaneous restart won't double-fire the same job. */
export function markFired(jobId: string, now: number, fireLogPath: string = paths.cronFired): void {
  const records = readFireLog(fireLogPath).filter((r) => now - r.firedAt < FIRE_LOG_RETAIN_MS);
  records.push({ jobId, firedAt: now });
  writeFireLog(fireLogPath, records);
}
