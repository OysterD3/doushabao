/** Prompt text for scheduled-job fires. */
import type { CronJob } from "../shared/types.ts";

const SCHEDULED_JOB_PREAMBLE =
  "[Scheduled job] This run was triggered automatically by a cron schedule, not by a person. " +
  "Your reply is sent to this conversation.\n\n";

export function buildScheduledPrompt(job: Pick<CronJob, "prompt">): string {
  return `${SCHEDULED_JOB_PREAMBLE}${job.prompt}`;
}
