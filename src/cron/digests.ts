/**
 * Digest recipes — opt-in cron jobs editors enable per workspace. Callers
 * pass the returned input straight to CronSvc.addJob(). `createdBy` is set
 * to "system" since this factory takes no creator identity; callers wired
 * to a real editor action may overwrite it before calling addJob.
 */
import type { CronJob } from "../shared/types.ts";

export type DigestKind = "standup" | "kb-gaps";

type DigestJobInput = Omit<CronJob, "id" | "createdAt" | "enabled" | "lastFiredAt">;

export function digestJobInput(kind: DigestKind, conversationId: string): DigestJobInput {
  if (kind === "standup") {
    return {
      conversationId,
      cronExpr: "0 9 * * 1-5",
      description: "Weekday standup: summarize yesterday's activity in this conversation.",
      prompt:
        "Write a short standup digest of yesterday's conversation in this workspace: what was discussed, decided, and left open.",
      createdBy: "system",
    };
  }
  return {
    conversationId,
    cronExpr: "0 10 * * 1",
    description: "Monday KB gaps: list this workspace's unanswered questions.",
    prompt:
      "List every flag_unanswered record still open in this workspace's knowledge-base directory, so editors can close the gaps.",
    createdBy: "system",
  };
}
