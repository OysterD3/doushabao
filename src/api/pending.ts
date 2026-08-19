/** File-backed store for PendingQuestion records under paths.pending/<id>.json. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../shared/paths.ts";
import type { PendingQuestion } from "../shared/types.ts";

function ensureDir(): void {
  mkdirSync(paths.pending, { recursive: true });
}

function fileFor(id: string): string {
  return join(paths.pending, `${id}.json`);
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
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(paths.pending, name), "utf8")) as PendingQuestion);
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
