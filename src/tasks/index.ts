/**
 * src/tasks — delegated-task registry + async worker loop.
 *
 * Binding decision (docs/brainstorming): task records are self-contained
 * (requester id + requestText verbatim) so a worker can compose a prompt,
 * and later an announcement, from the persisted record alone — completion
 * survives daemon restarts and the nightly session reset with no other
 * context available.
 *
 * Persistence: one JSON file per task at paths.tasks/<id>.json. Every status
 * transition is rewritten atomically (write to a unique tmp file, then
 * rename over the target) so a crash mid-write never leaves a half-written
 * record.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../shared/paths.ts";
import type { Config, DelegatedTask, PiRunnerPort } from "../shared/types.ts";

const MAX_CONCURRENT_WORKERS = 2;
const RESULT_SUMMARY_MAX_CHARS = 2000;

export interface Tasks {
  create(cid: string, requesterId: string, requestText: string): Promise<DelegatedTask>;
  bootRescan(): Promise<void>;
  summary(): { queued: number; running: number; done: number; failed: number };
  list(cid?: string): DelegatedTask[];
  retry(id: string): Promise<boolean>;
}

export interface TasksDeps {
  cfg: Config;
  runner: PiRunnerPort;
  workspaces: any;
  enqueueRun: (conversationId: string, prompt: string, opts?: Record<string, unknown>) => Promise<void>;
  ipc: { api: string; token: string };
}

/** Minimal shape expected from `deps.workspaces` (untyped Port; see final report). */
interface WorkspaceLookup {
  get(conversationId: string): { dir: string; modelOverride?: string; multimodal?: boolean; paused?: boolean } | undefined;
}

/** Model precedence, identical to the router's: an explicit per-workspace
 * override wins, then the vision model for a multimodal workspace, then the
 * cheap default. Empty string = not configured, so fall through. */
function pickModel(cfg: Config, ws: { modelOverride?: string; multimodal?: boolean }): string | undefined {
  if (ws.modelOverride) return ws.modelOverride;
  if (ws.multimodal && cfg.models.vision) return cfg.models.vision;
  return cfg.models.default || undefined;
}

function taskFile(id: string): string {
  return join(paths.tasks, `${id}.json`);
}

async function persist(task: DelegatedTask): Promise<void> {
  await mkdir(paths.tasks, { recursive: true });
  const file = taskFile(task.id);
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(task, null, 2), "utf8");
  await rename(tmp, file);
}

async function loadAll(): Promise<DelegatedTask[]> {
  await mkdir(paths.tasks, { recursive: true });
  const entries = await readdir(paths.tasks);
  const tasks: DelegatedTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue; // skips in-flight "*.json.tmp-<uuid>" files
    try {
      const raw = await readFile(join(paths.tasks, entry), "utf8");
      tasks.push(JSON.parse(raw) as DelegatedTask);
    } catch {
      /* partial/corrupt file — skip, do not let one bad record block boot */
    }
  }
  return tasks;
}

function buildTaskPrompt(task: DelegatedTask): string {
  return [
    `You are completing a delegated background task for ${task.requesterId} in conversation ${task.conversationId}.`,
    `Original request (verbatim):`,
    task.requestText,
  ].join("\n\n");
}

function successAnnouncementPrompt(task: DelegatedTask): string {
  return [
    `A delegated background task you started has finished. Compose a short message announcing the result to ${task.requesterId}.`,
    `Original request (verbatim):`,
    task.requestText,
    `Result:`,
    task.resultSummary ?? "",
  ].join("\n\n");
}

function failureAnnouncementPrompt(task: DelegatedTask): string {
  return [
    `A delegated background task you started has failed. Compose a short one-line message telling ${task.requesterId} it failed.`,
    `Original request (verbatim):`,
    task.requestText,
    `Error:`,
    task.error ?? "unknown error",
  ].join("\n\n");
}

export function createTasks(deps: TasksDeps): Tasks {
  const tasksById = new Map<string, DelegatedTask>();
  const workspaces = deps.workspaces as WorkspaceLookup;
  let activeWorkers = 0;

  /** Merge `patch` into the record, persist it durably, then publish the new
   * object to the in-memory map — observers (list/summary) only ever see a
   * status that is already safe on disk. */
  async function transition(id: string, patch: Partial<DelegatedTask>): Promise<DelegatedTask> {
    const current = tasksById.get(id);
    if (!current) throw new Error(`[tasks] unknown task ${id}`);
    const updated: DelegatedTask = { ...current, ...patch };
    await persist(updated);
    tasksById.set(id, updated);
    return updated;
  }

  /** Admin kill switch: a paused workspace starts no runs. Its tasks stay
   * queued on disk (nothing is lost or rewritten) and are picked up by the
   * next pump() after the workspace resumes. */
  function isPaused(task: DelegatedTask): boolean {
    return workspaces.get(task.conversationId)?.paused === true;
  }

  function pump(): void {
    while (activeWorkers < MAX_CONCURRENT_WORKERS) {
      const next = [...tasksById.values()]
        .filter((t) => t.status === "queued" && !isPaused(t))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) return;
      // Synchronous claim (new object, never mutate `next` in place — it may
      // be a snapshot already handed to a caller, e.g. create()'s return value):
      // no other pump() iteration in this tick can pick the same task.
      tasksById.set(next.id, { ...next, status: "running" });
      activeWorkers++;
      runWorker(next.id)
        .catch((err) => {
          console.error(`[tasks] worker crashed for task ${next.id}:`, err);
        })
        .finally(() => {
          activeWorkers--;
          pump();
        });
    }
  }

  async function announce(task: DelegatedTask, success: boolean): Promise<void> {
    const prompt = success ? successAnnouncementPrompt(task) : failureAnnouncementPrompt(task);
    try {
      await deps.enqueueRun(task.conversationId, prompt, {});
      if (success) {
        await transition(task.id, { status: "announced" });
      }
    } catch (err) {
      // Announcement failed to enqueue: leave status as-is ("done"/"failed") so
      // a future bootRescan() (done) or retry() (failed) can recover it.
      console.error(`[tasks] failed to announce task ${task.id}:`, err);
    }
  }

  async function runWorker(id: string): Promise<void> {
    const task = await transition(id, { status: "running", startedAt: Date.now() });
    const ws = workspaces.get(task.conversationId);
    if (!ws) {
      const failed = await transition(id, {
        status: "failed",
        finishedAt: Date.now(),
        error: `no workspace registered for conversation ${task.conversationId}`,
      });
      await announce(failed, false);
      return;
    }

    let result: { text: string; ok: boolean; error?: string };
    try {
      result = await deps.runner.run({
        workspaceDir: ws.dir,
        sessionId: `task-${id}`,
        prompt: buildTaskPrompt(task),
        model: pickModel(deps.cfg, ws),
        env: {
          DOUSHABAO_API: deps.ipc.api,
          DOUSHABAO_TOKEN: deps.ipc.token,
          DOUSHABAO_CONVERSATION: task.conversationId,
          DOUSHABAO_SENDER: task.requesterId,
        },
      });
    } catch (err) {
      result = { text: "", ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      const done = await transition(id, {
        status: "done",
        finishedAt: Date.now(),
        resultSummary: result.text.slice(0, RESULT_SUMMARY_MAX_CHARS),
      });
      await announce(done, true);
    } else {
      const failed = await transition(id, {
        status: "failed",
        finishedAt: Date.now(),
        error: (result.error ?? "unknown error").slice(0, RESULT_SUMMARY_MAX_CHARS),
      });
      await announce(failed, false);
    }
  }

  return {
    async create(cid, requesterId, requestText) {
      const task: DelegatedTask = {
        id: randomUUID(),
        conversationId: cid,
        requesterId,
        requestText,
        status: "queued",
        createdAt: Date.now(),
      };
      tasksById.set(task.id, task);
      await persist(task);
      pump();
      return task;
    },

    async bootRescan() {
      const loaded = await loadAll();
      tasksById.clear();
      for (const task of loaded) {
        tasksById.set(task.id, task);
      }
      // Crash recovery: a "running" task's worker died with it — requeue.
      for (const task of loaded) {
        if (task.status === "running") {
          await transition(task.id, { status: "queued" });
        }
      }
      // Crash recovery: "done" but never announced (crashed between the two
      // writes) — re-fire the announcement. At-least-once: a requester may
      // see a duplicate announcement across a crash, which is acceptable.
      for (const task of loaded) {
        if (task.status === "done") {
          await announce(tasksById.get(task.id)!, true);
        }
      }
      pump();
    },

    summary() {
      const out = { queued: 0, running: 0, done: 0, failed: 0 };
      for (const t of tasksById.values()) {
        if (t.status === "queued") out.queued++;
        else if (t.status === "running") out.running++;
        else if (t.status === "done" || t.status === "announced") out.done++;
        else if (t.status === "failed") out.failed++;
      }
      return out;
    },

    list(cid) {
      const all = [...tasksById.values()].sort((a, b) => a.createdAt - b.createdAt);
      return cid ? all.filter((t) => t.conversationId === cid) : all;
    },

    async retry(id) {
      const task = tasksById.get(id);
      if (!task || task.status !== "failed") return false;
      await transition(id, { status: "queued" });
      pump();
      return true;
    },
  };
}
