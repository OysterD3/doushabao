/**
 * KB entry file I/O: one JSON file per entry (named `<id>.json`) under a
 * directory — either a workspace's `kb/` dir or the global `shared-kb/` dir.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertUuid, resolveInside } from "../shared/paths.ts";
import type { KbEntry } from "../shared/types.ts";

/**
 * The one place a KB id becomes a filename — read, write and delete all go
 * through here, so this is where both containment layers belong.
 *
 * A KB id is always a randomUUID(), so anything else is refused outright; the
 * resolveInside call then contains the result no matter what a future caller
 * (or a future id shape) lets through. The two checks fail differently on
 * purpose: `../../../../.pi/agent/auth` is neither a uuid nor inside `dir`.
 */
export function kbEntryFile(dir: string, id: string): string {
  return resolveInside(dir, `${assertUuid("kb entry", id)}.json`);
}

/** Atomic write (tmp-file-in-same-dir + rename). */
export function writeKbEntry(dir: string, entry: KbEntry): void {
  mkdirSync(dir, { recursive: true });
  const file = kbEntryFile(dir, entry.id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** All entries in a directory, oldest-injected first. Corrupt/partial entry
 * files are skipped, not thrown. readdirSync order is filesystem-defined, not
 * creation order, so callers (e.g. kbDigest's cap) need this explicit sort to
 * behave deterministically. */
export function readKbEntries(dir: string): KbEntry[] {
  if (!existsSync(dir)) return [];
  const out: KbEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as KbEntry);
    } catch {
      /* skip corrupt/partial entry file */
    }
  }
  out.sort((a, b) => a.injectedAt - b.injectedAt);
  return out;
}

export function readKbEntry(dir: string, id: string): KbEntry | undefined {
  const file = kbEntryFile(dir, id);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as KbEntry;
  } catch {
    return undefined;
  }
}

export function deleteKbEntry(dir: string, id: string): boolean {
  const file = kbEntryFile(dir, id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
