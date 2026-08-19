import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type PiRunnerPort, type WorkspaceMeta } from "../shared/types.ts";
import { wsPaths } from "../shared/paths.ts";
import { HANDOFF_INSTRUCTION, readTranscriptTail, runNightlyForWorkspace } from "./nightly.ts";

function tmpWorkspace(): WorkspaceMeta {
  const dir = mkdtempSync(join(tmpdir(), "cron-nightly-"));
  return {
    conversationId: "conv-1",
    conversationType: "group",
    dir,
    boilerplate: "general",
    editors: [],
    multimodal: false,
    digestsEnabled: false,
    createdAt: Date.now(),
    greeted: true,
  };
}

function fakeRunner(text = "handoff notes", ok = true): PiRunnerPort & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    async run(opts) {
      calls.push(opts as unknown as Record<string, unknown>);
      return { text, ok, error: ok ? undefined : "boom" };
    },
  };
}

describe("readTranscriptTail", () => {
  test("returns '' when the transcript is missing", () => {
    expect(readTranscriptTail("/does/not/exist.jsonl", 80)).toBe("");
  });

  test("returns only the last maxLines non-empty lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-tail-"));
    const file = join(dir, "transcript.jsonl");
    writeFileSync(file, "a\nb\nc\n\nd\n");
    expect(readTranscriptTail(file, 2)).toBe("c\nd");
  });
});

describe("runNightlyForWorkspace", () => {
  test("distills with the strong model, writes handoff, prunes retention", async () => {
    const ws = tmpWorkspace();
    const wp = wsPaths(ws.dir);
    const now = Date.parse("2026-08-19T19:00:00Z"); // 2026-08-20 03:00 Asia/Shanghai
    const dayMs = 24 * 60 * 60 * 1000;

    writeFileSync(wp.transcript, `${JSON.stringify({ content: "hi", receivedAt: now - 1 * dayMs })}\n`);

    mkdirSync(wp.media, { recursive: true });
    const oldMedia = join(wp.media, "old.png");
    writeFileSync(oldMedia, "x");
    const oldTime = new Date(now - 10 * dayMs);
    utimesSync(oldMedia, oldTime, oldTime);

    const runner = fakeRunner("open threads: none");
    const cfg = ConfigSchema.parse({
      timezone: "Asia/Shanghai",
      models: { default: "cheap-model", distillation: "strong-model" },
      retention: { transcriptDays: 30, mediaDays: 7 },
      caps: { transcriptTailLines: 80 },
    });

    await runNightlyForWorkspace(ws, { cfg, runner }, now);

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.workspaceDir).toBe(ws.dir);
    expect(call.sessionId).toBe("distill-2026-08-20");
    expect(call.model).toBe("strong-model");
    expect(String(call.prompt)).toContain("hi");
    expect(String(call.prompt)).toContain(HANDOFF_INSTRUCTION);
    // Tool-less by design: no DOUSHABAO_API/DOUSHABAO_TOKEN in the run env.
    expect(call.env).toEqual({ DOUSHABAO_CONVERSATION: ws.conversationId, DOUSHABAO_SENDER: "system" });

    expect(readFileSync(wp.handoff, "utf8")).toBe("open threads: none");
    expect(existsSync(oldMedia)).toBe(false);
  });

  test("falls back to cfg.models.default when distillation is unset", async () => {
    const ws = tmpWorkspace();
    const runner = fakeRunner();
    const cfg = ConfigSchema.parse({ models: { default: "cheap-model", distillation: "" } });
    await runNightlyForWorkspace(ws, { cfg, runner }, Date.now());
    expect(runner.calls[0]?.model).toBe("cheap-model");
  });

  test("does not write handoff.md when the run fails", async () => {
    const ws = tmpWorkspace();
    const wp = wsPaths(ws.dir);
    const runner = fakeRunner("", false);
    const cfg = ConfigSchema.parse({});
    await runNightlyForWorkspace(ws, { cfg, runner }, Date.now());
    expect(existsSync(wp.handoff)).toBe(false);
  });
});
