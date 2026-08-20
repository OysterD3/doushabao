/** Filesystem layout. READ-ONLY for module implementers (request changes in your report). */
import { join, resolve, sep } from "node:path";

/**
 * Containment check for every path built from a non-constant string.
 *
 * Sanitising an id and containing the resulting path fail differently: a
 * sanitiser fails open the day someone adds a new field, a containment check
 * fails open the day a caller forgets it. Use BOTH — validate the id at its
 * choke point, and pass the path through here before touching the disk.
 *
 * Throws rather than returning a fallback: a traversal attempt is never a
 * thing to quietly recover from.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes its root: ${segments.join("/")}`);
  }
  return target;
}

/** Every id we build a filename from is a randomUUID(). Nothing else is. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(kind: string, id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`${kind}: not a valid id`);
  return id;
}

export const ROOT = process.env.DOUSHABAO_ROOT ?? process.cwd();

export const paths = {
  config: join(ROOT, "config", "doushabao.json"),
  var: join(ROOT, "var"),
  ipcToken: join(ROOT, "var", "ipc-token"),
  auditLog: join(ROOT, "var", "audit.jsonl"),
  dedupe: join(ROOT, "var", "dedupe.json"),
  tasks: join(ROOT, "var", "tasks"),
  pending: join(ROOT, "var", "pending"),
  cronFired: join(ROOT, "var", "cron-fired.json"),
  lastEventAt: join(ROOT, "var", "last-event-at"),
  // The workspace tree is its own thing: it can live at a dedicated path
  // (its own git repo), outside the code checkout, so upgrades never touch it
  // and it can be versioned/backed up on its own. Defaults under ROOT for
  // backward compatibility.
  workspaces: process.env.DOUSHABAO_WORKSPACES ?? join(ROOT, "workspaces"),
  sharedKb: join(ROOT, "shared-kb"),
  experts: join(ROOT, "experts"),
} as const;

/** Per-workspace layout, rooted at WorkspaceMeta.dir */
export const wsPaths = (dir: string) => ({
  meta: join(dir, "workspace.json"),
  transcript: join(dir, "transcript.jsonl"),
  jobs: join(dir, "jobs"),
  kb: join(dir, "kb"),
  media: join(dir, "media"),
  handoff: join(dir, "handoff.md"),
  agentsMd: join(dir, "AGENTS.md"),
  piSettings: join(dir, ".pi", "settings.json"),
  piExtensions: join(dir, ".pi", "extensions"),
});
