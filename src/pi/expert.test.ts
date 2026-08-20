import { describe, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXPERTS, EXPERT_PROFILES, expertProfile, expertToolNames } from "../shared/types.ts";
import { paths, wsPaths } from "../shared/paths.ts";
import { instantiateExpert } from "./expert.ts";

const TEMPLATES = EXPERTS;

// src/shared/paths.ts bakes ROOT (and therefore paths.experts) from
// DOUSHABAO_ROOT once per process. This file never sets that env var itself
// — it expects paths.experts to be the real repo experts/ dir.
// Vitest gives each test file its own process, so that normally holds; if it
// ever shares one with a file that already forced the one-time load under a
// tmp root, it will not. Then seed paths.experts with real template content
// so instantiateExpert (and this test's own "expected" reads, which go
// through that same paths.experts) have real files to work with.
const REAL_EXPERTS = join(import.meta.dirname, "..", "..", "experts");
function seedRealExpertsIfNeeded(): void {
  if (resolve(paths.experts) === resolve(REAL_EXPERTS)) return;
  for (const template of TEMPLATES) {
    mkdirSync(join(paths.experts, template, ".pi"), { recursive: true });
    copyFileSync(join(REAL_EXPERTS, template, "AGENTS.md"), join(paths.experts, template, "AGENTS.md"));
    copyFileSync(join(REAL_EXPERTS, template, ".pi", "settings.json"), join(paths.experts, template, ".pi", "settings.json"));
  }
  mkdirSync(join(paths.experts, "_shared", "extensions"), { recursive: true });
  copyFileSync(
    join(REAL_EXPERTS, "_shared", "extensions", "doushabao.ts"),
    join(paths.experts, "_shared", "extensions", "doushabao.ts"),
  );
}
seedRealExpertsIfNeeded();

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

describe("instantiateExpert", () => {
  for (const template of TEMPLATES) {
    test(`lays out ${template} correctly in a fresh workspace dir`, async () => {
      const workspaceDir = mkdtempSync(join(tmpdir(), `doushabao-ws-${template}-`));
      await instantiateExpert(template, workspaceDir);

      const ws = wsPaths(workspaceDir);

      const agentsMd = readFileSync(ws.agentsMd, "utf8");
      const sourceAgentsMd = readFileSync(join(paths.experts, template, "AGENTS.md"), "utf8");
      expect(agentsMd).toBe(sourceAgentsMd);
      expect(agentsMd.length).toBeGreaterThan(0);

      const settings = readFileSync(ws.piSettings, "utf8");
      const sourceSettings = readFileSync(join(paths.experts, template, ".pi", "settings.json"), "utf8");
      expect(settings).toBe(sourceSettings);
      expect(JSON.parse(settings)).toEqual({});

      // The extension is NOT copied into the workspace: the runner loads it
      // read-only from experts/_shared, and a copy would be code inside the
      // git-versioned data tree.
      expect(existsSync(join(ws.piExtensions, "doushabao.ts"))).toBe(false);

      // Regression guard reads the SHARED source directly: every ToolRequest
      // variant has a registered doushabao_* tool, and the file stays
      // self-contained (no imports back into our own src/).
      const extension = readFileSync(join(paths.experts, "_shared", "extensions", "doushabao.ts"), "utf8");
      for (const name of EXPECTED_TOOL_NAMES) {
        expect(extension).toContain(`"${name}"`);
      }
      expect(extension).not.toMatch(/from ["']\.\.\//);
    });
  }
});

/** Every curated worktool action any expert offers — the scan vocabulary. */
const ALL_WORKTOOL_ACTIONS = [...new Set(Object.values(EXPERT_PROFILES).flatMap((profile) => profile.worktools))];

// The templates are prose, and prose drifts: a workspace only ever gets the
// tools in its own EXPERT_PROFILES entry (src/pi passes them as `pi -t`), so a
// template that tells the model to call something else is describing a tool
// that is not there. Keep the two in sync from here on.
describe("template prose stays inside its expert profile", () => {
  for (const template of TEMPLATES) {
    test(`${template}/AGENTS.md names no tool or action its own profile lacks`, () => {
      const agentsMd = readFileSync(join(REAL_EXPERTS, template, "AGENTS.md"), "utf8");

      // `doushabao_*` (the collective noun) is not a tool name, hence [a-z] first.
      const namedTools = [...new Set(agentsMd.match(/doushabao_[a-z][a-z_]*/g) ?? [])];
      expect(namedTools.length).toBeGreaterThan(0);
      expect(namedTools.filter((name) => !expertToolNames(template).includes(name))).toEqual([]);

      const { worktools } = expertProfile(template);
      const namedActions = ALL_WORKTOOL_ACTIONS.filter((action) => agentsMd.includes(action));
      expect(namedActions.filter((action) => !worktools.includes(action))).toEqual([]);
    });
  }
});
