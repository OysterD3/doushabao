import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markFired, shouldSkipFire } from "./dedupe.ts";

function tmpFireLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "cron-dedupe-"));
  return join(dir, "cron-fired.json");
}

describe("dedupe guard", () => {
  test("does not skip a jobId that has never fired", () => {
    const file = tmpFireLog();
    expect(shouldSkipFire("job-1", Date.now(), file)).toBe(false);
  });

  test("skips a jobId fired less than 55s ago", () => {
    const file = tmpFireLog();
    const t0 = 1_000_000;
    markFired("job-1", t0, file);
    expect(shouldSkipFire("job-1", t0 + 1_000, file)).toBe(true);
    expect(shouldSkipFire("job-1", t0 + 54_999, file)).toBe(true);
  });

  test("does not skip once 55s have passed", () => {
    const file = tmpFireLog();
    const t0 = 1_000_000;
    markFired("job-1", t0, file);
    expect(shouldSkipFire("job-1", t0 + 55_000, file)).toBe(false);
  });

  test("other jobIds are unaffected", () => {
    const file = tmpFireLog();
    const t0 = 1_000_000;
    markFired("job-1", t0, file);
    expect(shouldSkipFire("job-2", t0 + 100, file)).toBe(false);
  });

  test("old entries are pruned from the log on write", () => {
    const file = tmpFireLog();
    markFired("job-1", 1_000_000, file);
    // Far enough later that job-1's entry is pruned when job-2 fires.
    markFired("job-2", 1_000_000 + 10 * 60_000, file);
    const contents = JSON.parse(readFileSync(file, "utf8"));
    expect(contents).toHaveLength(1);
    expect(contents[0].jobId).toBe("job-2");
  });
});
