import { describe, expect, test } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneMedia, pruneTranscript } from "./retention.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cron-retention-"));
}

describe("pruneTranscript", () => {
  test("drops lines older than retentionDays, keeps recent ones", () => {
    const dir = tmpDir();
    const file = join(dir, "transcript.jsonl");
    const now = Date.parse("2026-08-19T00:00:00Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const oldLine = JSON.stringify({ content: "old", receivedAt: now - 31 * dayMs });
    const recentLine = JSON.stringify({ content: "recent", receivedAt: now - 1 * dayMs });
    writeFileSync(file, `${oldLine}\n${recentLine}\n`);

    pruneTranscript(file, 30, now);

    const kept = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(kept).toHaveLength(1);
    expect(kept[0].content).toBe("recent");
  });

  test("keeps lines whose timestamp can't be determined", () => {
    const dir = tmpDir();
    const file = join(dir, "transcript.jsonl");
    const now = Date.parse("2026-08-19T00:00:00Z");
    writeFileSync(file, `not json\n${JSON.stringify({ content: "no-ts" })}\n`);

    pruneTranscript(file, 30, now);

    const kept = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    expect(kept).toHaveLength(2);
  });

  test("no-op when the transcript file does not exist", () => {
    const dir = tmpDir();
    const file = join(dir, "transcript.jsonl");
    expect(() => pruneTranscript(file, 30, Date.now())).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe("pruneMedia", () => {
  test("deletes files older than retentionDays by mtime, keeps recent ones", () => {
    const dir = tmpDir();
    const mediaDir = join(dir, "media");
    mkdirSync(mediaDir);
    const oldFile = join(mediaDir, "old.txt");
    const newFile = join(mediaDir, "new.txt");
    writeFileSync(oldFile, "old");
    writeFileSync(newFile, "new");

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const oldTime = new Date(now - 8 * dayMs);
    const newTime = new Date(now - 1 * dayMs);
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    pruneMedia(mediaDir, 7, now);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  test("no-op when the media dir does not exist", () => {
    const dir = tmpDir();
    const mediaDir = join(dir, "media");
    expect(() => pruneMedia(mediaDir, 7, Date.now())).not.toThrow();
  });

  test("refuses a media dir that is a symlink, so no file outside the workspace is deleted", () => {
    const dir = tmpDir();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const victim = join(outside, "system.txt");
    writeFileSync(victim, "not ours");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(victim, old, old);

    const mediaDir = join(dir, "media");
    symlinkSync(outside, mediaDir);

    expect(() => pruneMedia(mediaDir, 7, Date.now())).toThrow();
    expect(existsSync(victim)).toBe(true);
  });

  test("deletes only regular files — a symlink entry is left alone", () => {
    const dir = tmpDir();
    const mediaDir = join(dir, "media");
    mkdirSync(mediaDir);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "not ours");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(outside, old, old);
    const link = join(mediaDir, "link.txt");
    symlinkSync(outside, link);

    pruneMedia(mediaDir, 7, Date.now());

    expect(existsSync(outside)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
