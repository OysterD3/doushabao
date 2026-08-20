/**
 * src/cron — croner scheduler over all workspaces' jobs/, the nightly ritual
 * (distill + handoff + retention), and the heartbeat watchdog. Never spawns
 * dws or pi directly; depends on the DwsPort/PiRunnerPort ports plus an
 * `enqueueRun` callback (owned by router) for firing scheduled prompts.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Cron } from "croner";
import type { Config, CronJob, DwsPort, PiRunnerPort, WorkspaceMeta } from "../shared/types.ts";
import { UUID_RE, assertUuid, paths, resolveInside, wsPaths } from "../shared/paths.ts";
import { markFired, shouldSkipFire } from "./dedupe.ts";
import { runHeartbeatCheck, type HeartbeatState } from "./heartbeat.ts";
import { runNightlyForWorkspace } from "./nightly.ts";
import { buildScheduledPrompt } from "./prompt.ts";
import { digestJobInput, type DigestKind } from "./digests.ts";

export { checkQuiet, isWithinWorkHours, runHeartbeatCheck } from "./heartbeat.ts";
export type { HeartbeatDeps, HeartbeatState } from "./heartbeat.ts";
export { shouldSkipFire, markFired } from "./dedupe.ts";
export { pruneMedia, pruneTranscript } from "./retention.ts";
export { runNightlyForWorkspace, readTranscriptTail, HANDOFF_INSTRUCTION } from "./nightly.ts";
export type { NightlyDeps } from "./nightly.ts";
export { buildScheduledPrompt } from "./prompt.ts";
export { digestJobInput } from "./digests.ts";
export type { DigestKind } from "./digests.ts";

/**
 * Minimal shape cron needs from the workspace registry. The workspace module
 * is not yet a formal Port in shared/types.ts (createCron's `workspaces` dep
 * is typed `any` per the module contract) — see the final report for the
 * assumed shape.
 */
export interface WorkspacesLike {
  list(): WorkspaceMeta[];
}

export type EnqueueRun = (conversationId: string, prompt: string, opts: Record<string, unknown>) => void | Promise<void>;

export interface CronSvc {
  start(): void;
  stop(): void;
  addJob(input: Omit<CronJob, "id" | "createdAt" | "enabled" | "lastFiredAt">): CronJob;
  removeJob(conversationId: string, id: string): boolean;
  listJobs(conversationId: string): CronJob[];
  /** Materializes (or removes) this workspace's digest jobs. Called when an
   * editor flips meta.digestsEnabled — without it the flag is inert. */
  syncDigests(conversationId: string, enabled: boolean): { added: number; removed: number };
}

interface CronDeps {
  cfg: Config;
  dws: DwsPort;
  runner: PiRunnerPort;
  /** Workspace registry — not yet a formal Port; see WorkspacesLike above. */
  workspaces: any;
  enqueueRun: EnqueueRun;
}

export function createCron(deps: CronDeps): CronSvc {
  const workspaces = deps.workspaces as WorkspacesLike;
  const jobCrons = new Map<string, Cron>();
  let nightlyCron: Cron | undefined;
  let heartbeatCron: Cron | undefined;
  let started = false;
  const heartbeatState: HeartbeatState = { lastAlertAt: 0 };

  function findWorkspace(conversationId: string): WorkspaceMeta | undefined {
    return workspaces.list().find((w) => w.conversationId === conversationId);
  }

  function scheduleJob(ws: WorkspaceMeta, job: CronJob): void {
    if (!job.enabled) return;
    try {
      const cron = new Cron(job.cronExpr, { timezone: deps.cfg.timezone }, () => fireJob(ws, job));
      jobCrons.set(job.id, cron);
    } catch (err) {
      console.error(`cron: skipping job ${job.id} (${job.conversationId}) — invalid schedule: ${(err as Error).message}`);
    }
  }

  async function fireJob(ws: WorkspaceMeta, job: CronJob): Promise<void> {
    try {
      // Admin kill switch: no run is started for a paused workspace. Re-read
      // the registry — `ws` is the snapshot taken when the job was scheduled.
      if (findWorkspace(job.conversationId)?.paused) return;
      const now = Date.now();
      if (shouldSkipFire(job.id, now)) return;
      markFired(job.id, now);
      await deps.enqueueRun(job.conversationId, buildScheduledPrompt(job), {});
      persistLastFiredAt(ws, job.id, now);
    } catch (err) {
      console.error(`cron: job ${job.id} (${job.conversationId}) fire failed: ${(err as Error).message}`);
    }
  }

  function persistLastFiredAt(ws: WorkspaceMeta, jobId: string, firedAt: number): void {
    try {
      const file = jobFile(ws, jobId);
      if (!existsSync(file)) return;
      const job = JSON.parse(readFileSync(file, "utf8")) as CronJob;
      job.lastFiredAt = firedAt;
      writeFileSync(file, JSON.stringify(job, null, 2));
    } catch (err) {
      console.error(`cron: failed to persist lastFiredAt for job ${jobId}: ${(err as Error).message}`);
    }
  }

  async function runNightly(): Promise<void> {
    for (const ws of workspaces.list()) {
      try {
        await runNightlyForWorkspace(ws, { cfg: deps.cfg, runner: deps.runner });
      } catch (err) {
        console.error(`cron: nightly ritual failed for ${ws.conversationId}: ${(err as Error).message}`);
      }
    }
  }

  async function runHeartbeat(): Promise<void> {
    try {
      const now = Date.now();
      const lastEventAt = readLastEventAt();
      await runHeartbeatCheck({ cfg: deps.cfg, dws: deps.dws }, heartbeatState, now, lastEventAt);
    } catch (err) {
      console.error(`cron: heartbeat tick failed: ${(err as Error).message}`);
    }
  }

  const svc: CronSvc = {
    start(): void {
      if (started) return;
      started = true;
      for (const ws of workspaces.list()) {
        for (const job of readJobFiles(ws)) {
          scheduleJob(ws, job);
        }
      }
      nightlyCron = new Cron(`0 ${deps.cfg.nightly.hour} * * *`, { timezone: deps.cfg.timezone }, () => runNightly());
      heartbeatCron = new Cron("*/5 * * * *", { timezone: deps.cfg.timezone }, () => runHeartbeat());
    },

    stop(): void {
      for (const cron of jobCrons.values()) cron.stop();
      jobCrons.clear();
      nightlyCron?.stop();
      heartbeatCron?.stop();
      nightlyCron = undefined;
      heartbeatCron = undefined;
      started = false;
    },

    addJob(input): CronJob {
      try {
        // Validate only — no callback means croner never schedules a timer.
        new Cron(input.cronExpr, { timezone: deps.cfg.timezone, paused: true });
      } catch (err) {
        throw new Error(`cron: invalid cron expression "${input.cronExpr}": ${(err as Error).message}`);
      }
      const ws = findWorkspace(input.conversationId);
      if (!ws) throw new Error(`cron: unknown workspace for conversation ${input.conversationId}`);
      const job: CronJob = {
        ...input,
        id: randomUUID(),
        createdAt: Date.now(),
        enabled: true,
      };
      writeJobFile(ws, job);
      if (started) scheduleJob(ws, job);
      return job;
    },

    removeJob(conversationId, id): boolean {
      // The id arrives from cancel_job, i.e. from the model. Refuse a malformed
      // one here, before any lookup — jobFile() below is the second, independent
      // layer that contains whatever a future caller forgets to check.
      assertUuid("cron job", id);
      const ws = findWorkspace(conversationId);
      if (!ws) return false;
      const file = jobFile(ws, id);
      if (!existsSync(file)) return false;
      rmSync(file);
      jobCrons.get(id)?.stop();
      jobCrons.delete(id);
      return true;
    },

    listJobs(conversationId): CronJob[] {
      const ws = findWorkspace(conversationId);
      if (!ws) return [];
      return readJobFiles(ws);
    },

    syncDigests(conversationId, enabled): { added: number; removed: number } {
      const ws = findWorkspace(conversationId);
      if (!ws) throw new Error(`cron: unknown workspace for conversation ${conversationId}`);
      // Digest jobs are identified by their recipe description + the "system"
      // creator, so an editor's own hand-scheduled jobs are never touched.
      const recipes = DIGEST_KINDS.map((kind) => digestJobInput(kind, conversationId));
      const byDescription = new Map(recipes.map((r) => [r.description, r]));
      const existing = readJobFiles(ws).filter((j) => j.createdBy === "system" && byDescription.has(j.description));

      if (!enabled) {
        for (const job of existing) svc.removeJob(conversationId, job.id);
        return { added: 0, removed: existing.length };
      }
      const have = new Set(existing.map((j) => j.description));
      let added = 0;
      for (const recipe of recipes) {
        if (have.has(recipe.description)) continue;
        svc.addJob(recipe);
        added += 1;
      }
      return { added, removed: 0 };
    },
  };
  return svc;
}

const DIGEST_KINDS: DigestKind[] = ["standup", "kb-gaps"];

/**
 * The only way a job file path is ever built. Two layers that fail differently:
 * the id must be a randomUUID (nothing else ever names a job file), and the
 * result must resolve inside this workspace's jobs/ dir. Both throw — a job id
 * that tries to leave the directory is not a thing to recover from quietly.
 */
function jobFile(ws: WorkspaceMeta, jobId: string): string {
  return resolveInside(wsPaths(ws.dir).jobs, `${assertUuid("cron job", jobId)}.json`);
}

function readJobFiles(ws: WorkspaceMeta): CronJob[] {
  const dir = wsPaths(ws.dir).jobs;
  if (!existsSync(dir)) return [];
  const jobs: CronJob[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -".json".length);
    if (!UUID_RE.test(id)) {
      console.error(`cron: skipping job file with a non-id name: ${f}`);
      continue;
    }
    try {
      const job = JSON.parse(readFileSync(jobFile(ws, id), "utf8")) as CronJob;
      // job.id is what every later path is built from (persistLastFiredAt,
      // removeJob), so a file whose contents disagree with its name is not
      // loaded at all — that mismatch is how a planted id would travel.
      if (job.id !== id) {
        console.error(`cron: skipping job file ${f}: id "${job.id}" does not match its file name`);
        continue;
      }
      jobs.push(job);
    } catch (err) {
      console.error(`cron: skipping unreadable job file ${f}: ${(err as Error).message}`);
    }
  }
  return jobs;
}

function writeJobFile(ws: WorkspaceMeta, job: CronJob): void {
  const file = jobFile(ws, job.id);
  mkdirSync(wsPaths(ws.dir).jobs, { recursive: true });
  writeFileSync(file, JSON.stringify(job, null, 2));
}

/** Fallback "last event" for a fresh install: var/last-event-at is only ever
 * written by src/dws on the first inbound event, so before that the watchdog
 * measures quiet time from boot instead of from a missing timestamp. */
const BOOT_AT = Date.now();

function readLastEventAt(): number {
  try {
    const at = Number(readFileSync(paths.lastEventAt, "utf8"));
    return Number.isFinite(at) ? at : BOOT_AT;
  } catch {
    return BOOT_AT;
  }
}
