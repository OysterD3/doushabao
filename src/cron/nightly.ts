/**
 * Nightly ritual for one workspace: distill the day's transcript with the
 * strong model, write the handoff note, then run retention cleanup.
 * Extracted from index.ts so it's directly testable against tmp workspace
 * files without waiting for the real 3am cron tick.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config, PiRunnerPort, WorkspaceMeta } from "../shared/types.ts";
import { dailySessionId } from "../shared/types.ts";
import { wsPaths } from "../shared/paths.ts";
import { pruneMedia, pruneTranscript } from "./retention.ts";

export const HANDOFF_INSTRUCTION = "Write handoff notes: open threads, in-flight tasks, decisions.";

export interface NightlyDeps {
  cfg: Config;
  runner: PiRunnerPort;
}

/** Reads the last maxLines non-empty lines of a transcript file (or ""). */
export function readTranscriptTail(transcriptPath: string, maxLines: number): string {
  if (!existsSync(transcriptPath)) return "";
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  return lines.slice(-maxLines).join("\n");
}

/**
 * Distills + writes the handoff note for one workspace, then prunes its
 * transcript and media per cfg.retention. BINDING: distillation uses the
 * strong model (cfg.models.distillation || cfg.models.default) — the one
 * exception to cheap-everywhere.
 */
export async function runNightlyForWorkspace(ws: WorkspaceMeta, deps: NightlyDeps, now: number = Date.now()): Promise<void> {
  const wp = wsPaths(ws.dir);
  const date = dailySessionId(new Date(now), deps.cfg.timezone);
  const tail = readTranscriptTail(wp.transcript, deps.cfg.caps.transcriptTailLines);
  const model = deps.cfg.models.distillation || deps.cfg.models.default || undefined;
  const result = await deps.runner.run({
    workspaceDir: ws.dir,
    sessionId: `distill-${date}`,
    prompt: tail ? `${tail}\n\n${HANDOFF_INSTRUCTION}` : HANDOFF_INSTRUCTION,
    model,
    // System-triggered run: no human sender. Deliberately tool-less — without
    // DOUSHABAO_API/DOUSHABAO_TOKEN every doushabao_* tool refuses, so distillation
    // can only produce text, which this function writes to handoff.md itself.
    env: { DOUSHABAO_CONVERSATION: ws.conversationId, DOUSHABAO_SENDER: "system" },
  });
  if (result.ok) {
    writeFileSync(wp.handoff, result.text);
  } else {
    console.error(`cron: nightly distillation failed for ${ws.conversationId}: ${result.error ?? "unknown error"}`);
  }
  pruneTranscript(wp.transcript, deps.cfg.retention.transcriptDays, now);
  pruneMedia(wp.media, deps.cfg.retention.mediaDays, now);
}
