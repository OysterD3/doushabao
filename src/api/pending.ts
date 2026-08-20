/** File-backed store for PendingQuestion records under paths.pending/<id>.json. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertUuid, paths, resolveInside, UUID_RE } from "../shared/paths.ts";
import type { PendingQuestion } from "../shared/types.ts";

function ensureDir(): void {
  mkdirSync(paths.pending, { recursive: true });
}

/** Two independent layers on the one filename this module builds from a
 * record field: the id must be a randomUUID(), and the resulting path must
 * still land inside var/pending. A pending is re-saved after being read back
 * from disk, so `id` is not automatically the one we minted. */
function fileFor(id: string): string {
  return resolveInside(paths.pending, `${assertUuid("pending", id)}.json`);
}

export function savePending(p: PendingQuestion): void {
  ensureDir();
  writeFileSync(fileFor(p.id), JSON.stringify(p, null, 2));
}

export function listPending(): PendingQuestion[] {
  ensureDir();
  let names: string[];
  try {
    names = readdirSync(paths.pending);
  } catch {
    return [];
  }
  const out: PendingQuestion[] = [];
  for (const name of names) {
    // Only files this module itself wrote: "<uuid>.json", holding that same
    // id. Anything else is not a pending we minted, and a pending is a
    // durable instruction to execute an approved payload — so it is skipped,
    // never loaded.
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!UUID_RE.test(id)) continue;
    try {
      const p = JSON.parse(readFileSync(join(paths.pending, name), "utf8")) as PendingQuestion;
      if (p?.id !== id) continue;
      out.push(p);
    } catch {
      /* skip a corrupt/partial-write file */
    }
  }
  return out;
}

/** Open pendings for a conversation, excluding anything already past its ttl
 * (even if sweepExpired() has not run yet — a late reaction must not answer
 * a dead question). */
export function openPendingsFor(conversationId: string, now: number): PendingQuestion[] {
  return listPending().filter(
    (p) => p.conversationId === conversationId && p.status === "open" && p.expiresAt > now,
  );
}
