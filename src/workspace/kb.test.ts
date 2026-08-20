/**
 * KB entry file I/O — the choke point where a model-supplied id becomes a
 * filename.
 *
 * These are direct unit tests on purpose. The registry (src/workspace/index.ts)
 * refuses a non-uuid kbId before it ever calls in here, so an integration test
 * alone would keep passing with kbEntryFile's own guards deleted. This file is
 * what makes the backstop load-bearing.
 *
 * kb.ts takes its directory as a parameter and never reads paths.ts's ROOT, so
 * a plain mkdtemp is enough — no DOUSHABAO_ROOT dance.
 */
import { afterAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteKbEntry, kbEntryFile, readKbEntries, readKbEntry, writeKbEntry } from "./kb.ts";
import type { KbEntry } from "../shared/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "doushabao-kb-"));
const KB_DIR = join(ROOT, "workspaces", "ws-1", "kb");
mkdirSync(KB_DIR, { recursive: true });

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Valid JSON, so an unguarded readKbEntry would parse it and hand the secret
 * back to the caller — garbage content would be swallowed by the corrupt-file
 * catch and the test would pass without the fix. */
const SECRET = JSON.stringify({ id: "stolen", question: "q", answer: "sk-live-TOPSECRET", scope: "global", injectedBy: "pi", injectedAt: 1, revoked: false });

function plantSecret(relDir: string, base: string): string {
  const dir = join(ROOT, relDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${base}.json`);
  writeFileSync(file, SECRET);
  return file;
}

// Every id below is what an adversarial model can type into kb_promote/kb_revoke.
const TRAVERSING_IDS = [
  "../../../config/doushabao",
  "../../../../../.pi/agent/auth",
  "../../../.pi/agent/auth",
  "../sibling",
  "..%2f..%2fetc%2fpasswd",
  "/etc/passwd",
  "a/../../../escape",
  "not-a-uuid",
  "",
];

describe("kbEntryFile", () => {
  test("accepts a randomUUID id and keeps it inside the directory", () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(kbEntryFile(KB_DIR, id)).toBe(join(KB_DIR, `${id}.json`));
  });

  test("refuses every traversing / non-uuid id", () => {
    for (const id of TRAVERSING_IDS) {
      expect(() => kbEntryFile(KB_DIR, id), id).toThrow();
    }
  });
});

describe("read / write / delete refuse a traversing id and leave the target untouched", () => {
  test("readKbEntry does not read pi's credential store", () => {
    const target = plantSecret(".pi/agent", "auth");
    expect(() => readKbEntry(KB_DIR, "../../../.pi/agent/auth")).toThrow();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(SECRET);
  });

  test("deleteKbEntry does not unlink a file outside the kb dir", () => {
    const target = plantSecret("config", "doushabao");
    expect(() => deleteKbEntry(KB_DIR, "../../../config/doushabao")).toThrow();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(SECRET);
  });

  test("writeKbEntry does not overwrite a file outside the kb dir", () => {
    const target = plantSecret("config", "overwrite-me");
    const entry = { id: "../../../config/overwrite-me", question: "q", answer: "a", scope: "global", injectedBy: "pi", injectedAt: 1, revoked: false } as KbEntry;
    expect(() => writeKbEntry(KB_DIR, entry)).toThrow();
    expect(readFileSync(target, "utf8")).toBe(SECRET);
    // and no tmp-file debris was left next to the target either
    expect(readdirSync(join(ROOT, "config")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("a legitimate uuid entry still round-trips", () => {
    const entry: KbEntry = { id: "9f8b7c6d-1a2b-4c3d-8e9f-0a1b2c3d4e5f", question: "hours?", answer: "9-6", scope: "global", injectedBy: "admin", injectedAt: 5, revoked: false };
    writeKbEntry(KB_DIR, entry);
    expect(readKbEntry(KB_DIR, entry.id)).toEqual(entry);
    expect(readKbEntries(KB_DIR).map((e) => e.id)).toEqual([entry.id]);
    expect(deleteKbEntry(KB_DIR, entry.id)).toBe(true);
    expect(readKbEntry(KB_DIR, entry.id)).toBeUndefined();
  });
});
