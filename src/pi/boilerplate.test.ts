import { describe, expect, test } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Boilerplate } from "../shared/types.ts";
import { paths, wsPaths } from "../shared/paths.ts";
import { instantiateBoilerplate } from "./boilerplate.ts";

const TEMPLATES: Boilerplate[] = ["general", "qa-cs", "project", "dev-mgmt"];

// src/shared/paths.ts bakes ROOT (and therefore paths.boilerplates) from
// DOUSHABAO_ROOT once per process. This file never sets that env var itself
// — it expects paths.boilerplates to be the real repo boilerplates/ dir.
// Vitest gives each test file its own process, so that normally holds; if it
// ever shares one with a file that already forced the one-time load under a
// tmp root, it will not. Then seed paths.boilerplates with real template content
// so instantiateBoilerplate (and this test's own "expected" reads, which go
// through that same paths.boilerplates) have real files to work with.
const REAL_BOILERPLATES = join(import.meta.dirname, "..", "..", "boilerplates");
function seedRealBoilerplatesIfNeeded(): void {
  if (resolve(paths.boilerplates) === resolve(REAL_BOILERPLATES)) return;
  for (const template of TEMPLATES) {
    mkdirSync(join(paths.boilerplates, template, ".pi"), { recursive: true });
    copyFileSync(join(REAL_BOILERPLATES, template, "AGENTS.md"), join(paths.boilerplates, template, "AGENTS.md"));
    copyFileSync(join(REAL_BOILERPLATES, template, ".pi", "settings.json"), join(paths.boilerplates, template, ".pi", "settings.json"));
  }
  mkdirSync(join(paths.boilerplates, "_shared", "extensions"), { recursive: true });
  copyFileSync(
    join(REAL_BOILERPLATES, "_shared", "extensions", "doushabao.ts"),
    join(paths.boilerplates, "_shared", "extensions", "doushabao.ts"),
  );
}
seedRealBoilerplatesIfNeeded();

const EXPECTED_TOOL_NAMES = [
  "doushabao_send",
  "doushabao_ask",
  "doushabao_delegate",
  "doushabao_schedule_job",
  "doushabao_cancel_job",
  "doushabao_list_jobs",
  "doushabao_kb_save",
  "doushabao_kb_promote",
  "doushabao_kb_revoke",
  "doushabao_flag_unanswered",
  "doushabao_escalate",
  "doushabao_worktool",
  "doushabao_set_workspace",
  "doushabao_memory",
  "doushabao_ops",
];

describe("instantiateBoilerplate", () => {
  for (const template of TEMPLATES) {
    test(`lays out ${template} correctly in a fresh workspace dir`, async () => {
      const workspaceDir = mkdtempSync(join(tmpdir(), `doushabao-ws-${template}-`));
      await instantiateBoilerplate(template, workspaceDir);

      const ws = wsPaths(workspaceDir);

      const agentsMd = readFileSync(ws.agentsMd, "utf8");
      const sourceAgentsMd = readFileSync(join(paths.boilerplates, template, "AGENTS.md"), "utf8");
      expect(agentsMd).toBe(sourceAgentsMd);
      expect(agentsMd.length).toBeGreaterThan(0);

      const settings = readFileSync(ws.piSettings, "utf8");
      const sourceSettings = readFileSync(join(paths.boilerplates, template, ".pi", "settings.json"), "utf8");
      expect(settings).toBe(sourceSettings);
      expect(JSON.parse(settings)).toEqual({});

      const extensionPath = join(ws.piExtensions, "doushabao.ts");
      const extension = readFileSync(extensionPath, "utf8");
      const sourceExtension = readFileSync(join(paths.boilerplates, "_shared", "extensions", "doushabao.ts"), "utf8");
      expect(extension).toBe(sourceExtension);

      // Regression guard: every ToolRequest variant has a registered doushabao_* tool,
      // and the file stays self-contained (no imports back into our own src/).
      for (const name of EXPECTED_TOOL_NAMES) {
        expect(extension).toContain(`"${name}"`);
      }
      expect(extension).not.toMatch(/from ["']\.\.\//);
    });
  }
});
