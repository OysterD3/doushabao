/**
 * src/tasks tests. Sets DOUSHABAO_ROOT to a tmp dir *before* the first
 * (dynamic) import of anything that touches src/shared/paths.ts, since that
 * module bakes `ROOT`/`paths` from the env var once, at first import.
 * Every subsequent path derivation in these tests goes through the imported
 * `paths` object, never through a locally-remembered root string.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

const root = await mkdtemp(join(tmpdir(), "doushabao-tasks-"));
process.env.DOUSHABAO_ROOT = root;

const { createTasks } = await import("./index.ts");
const { paths } = await import("../shared/paths.ts");
const { ConfigSchema, expertToolNames } = await import("../shared/types.ts");

type TasksDeps = Parameters<typeof createTasks>[0];
type PiRunnerPort = TasksDeps["runner"];
type RunOpts = Parameters<PiRunnerPort["run"]>[0];

const cfg = ConfigSchema.parse({});

function fakeIpc() {
  return { api: "http://127.0.0.1:8787", token: "test-token" };
}

function fakeWorkspaces(dir = "/fake/workspace", modelOverride?: string): TasksDeps["workspaces"] {
  return { get: (_cid: string) => ({ dir, modelOverride }) };
}

function collectingEnqueue() {
  const calls: { cid: string; prompt: string; opts?: Record<string, unknown> }[] = [];
  const enqueueRun = async (cid: string, prompt: string, opts?: Record<string, unknown>) => {
    calls.push({ cid, prompt, opts });
  };
  return { calls, enqueueRun };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  await rm(paths.tasks, { recursive: true, force: true });
});

describe("lifecycle", () => {
  test("queued -> running -> done -> announced on success", async () => {
    const seenRunOpts: RunOpts[] = [];
    const { calls: announcements, enqueueRun } = collectingEnqueue();
    const deps: TasksDeps = {
      cfg,
      runner: {
        run: async (opts) => {
          seenRunOpts.push(opts);
          return { text: "the answer is 42", ok: true };
        },
      },
      workspaces: fakeWorkspaces("/fake/ws-1"),
      enqueueRun,
      ipc: fakeIpc(),
    };
    const tasks = createTasks(deps);

    const created = await tasks.create("conv-1", "user-1", "please compute the answer");
    expect(created.status).toBe("queued");
    expect(created.conversationId).toBe("conv-1");
    expect(created.requesterId).toBe("user-1");
    expect(created.requestText).toBe("please compute the answer");

    await waitUntil(() => tasks.list("conv-1")[0]?.status === "announced");

    const final = tasks.list("conv-1")[0]!;
    expect(final.status).toBe("announced");
    expect(final.resultSummary).toBe("the answer is 42");
    expect(final.startedAt).toBeGreaterThanOrEqual(final.createdAt);
    expect(final.finishedAt).toBeGreaterThanOrEqual(final.startedAt!);

    // runner.run got a self-contained prompt + correct identity/env wiring
    expect(seenRunOpts).toHaveLength(1);
    const runOpts = seenRunOpts[0]!;
    expect(runOpts.workspaceDir).toBe("/fake/ws-1");
    expect(runOpts.sessionId).toBe(`task-${created.id}`);
    expect(runOpts.prompt).toContain("please compute the answer");
    expect(runOpts.prompt).toContain("user-1");
    expect(runOpts.env).toEqual({
      DOUSHABAO_API: "http://127.0.0.1:8787",
      DOUSHABAO_TOKEN: "test-token",
      DOUSHABAO_CONVERSATION: "conv-1",
      DOUSHABAO_SENDER: "user-1",
    });

    // announcement composed from the task record + result, sent to the origin conversation
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.cid).toBe("conv-1");
    expect(announcements[0]!.prompt).toContain("please compute the answer");
    expect(announcements[0]!.prompt).toContain("the answer is 42");
    expect(announcements[0]!.opts).toEqual({});

    // persisted file matches in-memory state
    const onDisk = JSON.parse(await readFile(join(paths.tasks, `${created.id}.json`), "utf8"));
    expect(onDisk).toEqual(final);

    const summary = tasks.summary();
    expect(summary).toEqual({ queued: 0, running: 0, done: 1, failed: 0 });
  });

  test("resultSummary truncates to 2000 chars", async () => {
    const longText = "x".repeat(2500);
    const { enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: { run: async () => ({ text: longText, ok: true }) },
      workspaces: fakeWorkspaces(),
      enqueueRun,
      ipc: fakeIpc(),
    });
    const created = await tasks.create("conv-2", "user-2", "long task");
    await waitUntil(() => tasks.list("conv-2")[0]?.status === "announced");
    expect(tasks.list("conv-2")[0]!.resultSummary).toHaveLength(2000);
  });

  test("failure: stays 'failed' (not announced) and fires a failure announcement", async () => {
    const { calls: announcements, enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: { run: async () => ({ text: "", ok: false, error: "boom: out of cheese" }) },
      workspaces: fakeWorkspaces(),
      enqueueRun,
      ipc: fakeIpc(),
    });
    await tasks.create("conv-3", "user-3", "do the impossible thing");
    // Gate on the announcement itself (not just the in-memory "failed"
    // status): the announce() call is a continuation *after* that status is
    // visible, so waiting on status alone races with it actually firing.
    await waitUntil(() => announcements.length === 1);

    const final = tasks.list("conv-3")[0]!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("boom: out of cheese");
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.prompt).toContain("do the impossible thing");
    expect(announcements[0]!.prompt).toContain("boom: out of cheese");

    const summary = tasks.summary();
    expect(summary).toEqual({ queued: 0, running: 0, done: 0, failed: 1 });
  });

  test("missing workspace fails the task without calling the runner", async () => {
    let runCalled = false;
    const { enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: {
        run: async () => {
          runCalled = true;
          return { text: "unreachable", ok: true };
        },
      },
      workspaces: { get: () => undefined },
      enqueueRun,
      ipc: fakeIpc(),
    });
    await tasks.create("conv-4", "user-4", "task with no workspace");
    await waitUntil(() => tasks.list("conv-4")[0]?.status === "failed");
    expect(runCalled).toBe(false);
    expect(tasks.list("conv-4")[0]!.error).toContain("conv-4");
  });
});

describe("model selection", () => {
  /** Drive create() -> worker once and report the model the runner was given. */
  async function modelSeenFor(
    models: { default?: string; vision?: string },
    ws: { modelOverride?: string; multimodal?: boolean },
  ): Promise<string | undefined> {
    const seen: RunOpts[] = [];
    const { enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg: ConfigSchema.parse({ models }),
      runner: {
        run: async (opts) => {
          seen.push(opts);
          return { text: "ok", ok: true };
        },
      },
      workspaces: { get: (_cid: string) => ({ dir: "/fake/ws", ...ws }) },
      enqueueRun,
      ipc: fakeIpc(),
    });
    await tasks.create("conv-model", "user-m", "model probe");
    await waitUntil(() => tasks.list("conv-model")[0]?.status === "announced");
    return seen[0]!.model;
  }

  test("modelOverride wins, then vision when multimodal, then the default", async () => {
    const cases = [
      { label: "multimodal + vision configured", models: { default: "cheap", vision: "eyes" }, ws: { multimodal: true }, want: "eyes" },
      { label: "multimodal, no vision configured", models: { default: "cheap" }, ws: { multimodal: true }, want: "cheap" },
      { label: "not multimodal", models: { default: "cheap", vision: "eyes" }, ws: { multimodal: false }, want: "cheap" },
      { label: "override beats vision", models: { default: "cheap", vision: "eyes" }, ws: { multimodal: true, modelOverride: "mine" }, want: "mine" },
      { label: "nothing configured", models: {}, ws: { multimodal: true }, want: undefined },
    ];
    const actual: { label: string; model: string | undefined }[] = [];
    for (const c of cases) {
      actual.push({ label: c.label, model: await modelSeenFor(c.models, c.ws) });
    }
    expect(actual).toEqual(cases.map((c) => ({ label: c.label, model: c.want })));
  });
});

describe("expert tool allowlist", () => {
  test("the worker run gets the owning workspace's expert tool names", async () => {
    const seen: RunOpts[] = [];
    const { enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: {
        run: async (opts) => {
          seen.push(opts);
          return { text: "ok", ok: true };
        },
      },
      workspaces: { get: (_cid: string) => ({ dir: "/fake/ws", expert: "qa-cs" as const }) },
      enqueueRun,
      ipc: fakeIpc(),
    });
    await tasks.create("conv-expert", "user-e", "task in a qa-cs workspace");
    await waitUntil(() => tasks.list("conv-expert")[0]?.status === "announced");

    expect(seen[0]!.tools).toEqual(expertToolNames("qa-cs"));
    // anchor: qa-cs grants the kb tools, and grants no job scheduling
    expect(seen[0]!.tools).toContain("doushabao_kb_save");
    expect(seen[0]!.tools).not.toContain("doushabao_schedule_job");
  });
});

describe("paused workspace", () => {
  test("no run is started while paused; the task stays queued on disk and runs after resume", async () => {
    const pausedByCid = new Map<string, boolean>([["conv-paused", true]]);
    const seen: RunOpts[] = [];
    const { calls: announcements, enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: {
        run: async (opts) => {
          seen.push(opts);
          return { text: "ran", ok: true };
        },
      },
      workspaces: { get: (cid: string) => ({ dir: "/fake/ws", paused: pausedByCid.get(cid) }) },
      enqueueRun,
      ipc: fakeIpc(),
    });

    const blocked = await tasks.create("conv-paused", "user-8", "task for a paused workspace");
    // A live task created after it: once THAT one is announced, pump() has
    // demonstrably run and stepped over the paused queue head.
    const live = await tasks.create("conv-live", "user-8", "task for a live workspace");
    await waitUntil(() => tasks.list("conv-live")[0]?.status === "announced");

    expect(seen.map((o) => o.sessionId)).toEqual([`task-${live.id}`]);
    expect(tasks.list("conv-paused")[0]!.status).toBe("queued");
    // durable: the record on disk is the untouched queued task, not lost
    const onDisk = JSON.parse(await readFile(join(paths.tasks, `${blocked.id}.json`), "utf8"));
    expect(onDisk).toEqual(blocked);

    // resume: the next pump() (here, another create) picks the held task up
    pausedByCid.set("conv-paused", false);
    await tasks.create("conv-live", "user-8", "second live task");
    await waitUntil(() => tasks.list().every((t) => t.status === "announced"));
    expect(tasks.list("conv-paused")[0]!.status).toBe("announced");
    expect(announcements.filter((c) => c.cid === "conv-paused")).toHaveLength(1);
  });
});

describe("retry", () => {
  test("failed -> queued -> processed again; rejects unknown/non-failed ids", async () => {
    const { calls: announcements, enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: { run: async () => ({ text: "", ok: false, error: "still broken" }) },
      workspaces: fakeWorkspaces(),
      enqueueRun,
      ipc: fakeIpc(),
    });
    const created = await tasks.create("conv-5", "user-5", "flaky task");
    await waitUntil(() => announcements.length === 1);
    expect(tasks.list("conv-5")[0]!.status).toBe("failed");

    expect(await tasks.retry("does-not-exist")).toBe(false);

    const ok = await tasks.retry(created.id);
    expect(ok).toBe(true);
    // retry() re-queues; the worker loop picks it up again and it fails again
    await waitUntil(() => announcements.length === 2);
    expect(tasks.list("conv-5")[0]!.status).toBe("failed");

    // a 'failed' task can be retried again while still 'failed'
    expect(await tasks.retry(created.id)).toBe(true);
    await waitUntil(() => announcements.length === 3);
    expect(tasks.list("conv-5")[0]!.status).toBe("failed");

    // retry only accepts tasks currently in 'failed' status
    const notFailed = await tasks.create("conv-5", "user-5", "second task");
    expect(await tasks.retry(notFailed.id)).toBe(false); // still queued/running, not failed

    // drain this task fully before the test ends, so no background write
    // races the next test's directory cleanup
    await waitUntil(() => announcements.length === 4);
  });
});

describe("concurrency", () => {
  test("caps active workers at 2; a 3rd task waits until one finishes", async () => {
    const releasers = new Map<string, (r: { text: string; ok: boolean }) => void>();
    const { enqueueRun } = collectingEnqueue();
    const tasks = createTasks({
      cfg,
      runner: {
        run: (opts) =>
          new Promise((resolve) => {
            releasers.set(opts.sessionId, resolve);
          }),
      },
      workspaces: fakeWorkspaces(),
      enqueueRun,
      ipc: fakeIpc(),
    });

    const t1 = await tasks.create("conv-6", "user-6", "task one");
    const t2 = await tasks.create("conv-6", "user-6", "task two");
    const t3 = await tasks.create("conv-6", "user-6", "task three");

    await waitUntil(() => tasks.list("conv-6").filter((t) => t.status === "running").length === 2);
    // the 3rd stays queued while 2 are running
    expect(tasks.list("conv-6").find((t) => t.id === t3.id)?.status).toBe("queued");

    // release task one; task three should then start running
    releasers.get(`task-${t1.id}`)!({ text: "done one", ok: true });
    await waitUntil(() => tasks.list("conv-6").find((t) => t.id === t3.id)?.status === "running");

    // release the rest to let the test finish cleanly
    releasers.get(`task-${t2.id}`)!({ text: "done two", ok: true });
    releasers.get(`task-${t3.id}`)!({ text: "done three", ok: true });

    await waitUntil(() => tasks.list("conv-6").every((t) => t.status === "announced"));
    expect(tasks.summary()).toEqual({ queued: 0, running: 0, done: 3, failed: 0 });
  });
});

describe("restart recovery", () => {
  test("new createTasks() over the same dir: queued task resumes, running tasks revert then resume, done-but-unannounced re-announces", async () => {
    // --- "before restart": one instance whose runner hangs forever, so any
    // task it starts stays 'running' on disk when we "kill" the process.
    const hangingDeps: TasksDeps = {
      cfg,
      runner: { run: () => new Promise(() => {}) }, // never resolves
      workspaces: fakeWorkspaces(),
      enqueueRun: collectingEnqueue().enqueueRun,
      ipc: fakeIpc(),
    };
    const before = createTasks(hangingDeps);
    const a = await before.create("conv-7", "user-7", "task a");
    const b = await before.create("conv-7", "user-7", "task b");
    const c = await before.create("conv-7", "user-7", "task c");
    // concurrency cap 2: a and b run, c stays queued
    await waitUntilFilesShow(["running", "running", "queued"], [a.id, b.id, c.id]);

    // Also simulate a task that reached 'done' but the process died before
    // the announcement was persisted (crash between the two writes).
    const doneDeps: TasksDeps = {
      cfg,
      runner: { run: async () => ({ text: "already computed", ok: true }) },
      workspaces: fakeWorkspaces(),
      enqueueRun: async () => {
        throw new Error("simulated crash: enqueueRun never got to run");
      },
      ipc: fakeIpc(),
    };
    const doneInstance = createTasks(doneDeps);
    const d = await doneInstance.create("conv-7", "user-7", "task d");
    await waitUntilFilesShow(["done"], [d.id]);

    // --- "after restart": brand-new Tasks instance, same DOUSHABAO_ROOT, real runner.
    const { calls: announcements, enqueueRun: freshEnqueue } = collectingEnqueue();
    const after = createTasks({
      cfg,
      runner: { run: async () => ({ text: "resumed ok", ok: true }) },
      workspaces: fakeWorkspaces(),
      enqueueRun: freshEnqueue,
      ipc: fakeIpc(),
    });
    await after.bootRescan();

    await waitUntil(() => after.list("conv-7").every((t) => t.status === "announced"));
    const final = after.list("conv-7");
    expect(final).toHaveLength(4);
    for (const t of final) {
      expect(t.status).toBe("announced");
    }

    // task d: already 'done' at boot (crash before its announcement was
    // persisted) — re-announced from its ORIGINAL result, not re-run.
    expect(announcements.filter((call) => call.prompt.includes("already computed"))).toHaveLength(1);
    // tasks a, b, c: reverted from 'running'/'queued' and freshly processed
    // by the post-restart runner.
    expect(announcements.filter((call) => call.prompt.includes("resumed ok"))).toHaveLength(3);
    expect(announcements).toHaveLength(4);
  });
});

/** Poll the on-disk task files until they show the expected statuses (order matches ids). */
async function waitUntilFilesShow(expected: string[], ids: string[], timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const statuses = await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await readFile(join(paths.tasks, `${id}.json`), "utf8");
          return (JSON.parse(raw) as { status: string }).status;
        } catch {
          return undefined;
        }
      }),
    );
    if (statuses.every((s, i) => s === expected[i])) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntilFilesShow: timed out, got ${JSON.stringify(statuses)}, expected ${JSON.stringify(expected)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
