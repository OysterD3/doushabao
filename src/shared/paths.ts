/** Filesystem layout. READ-ONLY for module implementers (request changes in your report). */
import { join } from "node:path";

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
  workspaces: join(ROOT, "workspaces"),
  sharedKb: join(ROOT, "shared-kb"),
  boilerplates: join(ROOT, "boilerplates"),
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
