/**
 * instantiateExpert — materializes a new workspace directory from one of the
 * expert templates under experts/: AGENTS.md and .pi/settings.json.
 *
 * It does NOT copy the workspace extension in. The runner loads the extension
 * read-only from experts/_shared (see src/pi/index.ts SHARED_EXTENSION) — a
 * per-workspace copy would be both dead weight and code inside what is now a
 * data-only tree that gets git-versioned. Left here it would just bloat the
 * workspace repo's history; the workspace .gitignore excludes .pi/ anyway.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Expert } from "../shared/types.ts";
import { paths, wsPaths } from "../shared/paths.ts";

export async function instantiateExpert(templateName: Expert, workspaceDir: string): Promise<void> {
  const templateDir = join(paths.experts, templateName);
  const ws = wsPaths(workspaceDir);

  await mkdir(workspaceDir, { recursive: true });
  await copyFile(join(templateDir, "AGENTS.md"), ws.agentsMd);

  await mkdir(join(workspaceDir, ".pi"), { recursive: true });
  await copyFile(join(templateDir, ".pi", "settings.json"), ws.piSettings);
}
