/** Small filesystem + id helpers shared across the workspace registry. */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Deterministic, filesystem-safe directory name for a conversation id.
 * DingTalk conversation ids may contain characters unsafe for directory
 * names (e.g. `=`, `+`, `/`); sanitize and append a short hash so distinct
 * ids can never collide after sanitization.
 */
export function slug(cid: string): string {
  const clean = cid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(cid).digest("hex").slice(0, 8);
  return `${clean || "cid"}-${hash}`;
}

/** Write content to `file` via tmp-file-in-same-dir + rename (atomic on the same filesystem). */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Append one JSON object as a line to a JSONL file, creating parent dirs as needed. */
export function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + "\n");
}
