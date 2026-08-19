/**
 * instantiateBoilerplate — materializes a new workspace directory from one
 * of the four boilerplate templates under boilerplates/: AGENTS.md,
 * .pi/settings.json, and (always) the shared self-contained extension.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Boilerplate } from "../shared/types.ts";
import { paths, wsPaths } from "../shared/paths.ts";

export async function instantiateBoilerplate(templateName: Boilerplate, workspaceDir: string): Promise<void> {
  const templateDir = join(paths.boilerplates, templateName);
  const ws = wsPaths(workspaceDir);

  await mkdir(workspaceDir, { recursive: true });
  await copyFile(join(templateDir, "AGENTS.md"), ws.agentsMd);

  await mkdir(join(workspaceDir, ".pi"), { recursive: true });
  await copyFile(join(templateDir, ".pi", "settings.json"), ws.piSettings);

  await mkdir(ws.piExtensions, { recursive: true });
  await copyFile(join(paths.boilerplates, "_shared", "extensions", "doushabao.ts"), join(ws.piExtensions, "doushabao.ts"));
}
