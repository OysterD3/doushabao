/**
 * Config loading + var/ directory bootstrap for the doushabao daemon.
 * Owned by main (src/index.ts, src/config.ts, scripts/, SETUP.md).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { ConfigSchema, type Config } from "./shared/types.ts";
import { paths } from "./shared/paths.ts";

/** Parse config/doushabao.json through ConfigSchema. Missing file => {} (all defaults). */
export function loadConfig(): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = {};
  }
  return ConfigSchema.parse(raw);
}

/** Create the durable var/ directories the daemon writes into. Idempotent. */
export function ensureVarDirs(): void {
  for (const dir of [paths.var, paths.tasks, paths.pending, paths.workspaces, paths.sharedKb]) {
    mkdirSync(dir, { recursive: true });
  }
}
