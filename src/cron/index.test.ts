import { afterEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, wsPaths } from "../shared/paths.ts";
import { ConfigSchema, type Config, type DwsPort, type PiRunnerPort, type WorkspaceMeta } from "../shared/types.ts";
import { createCron, type CronSvc, type WorkspacesLike } from "./index.ts";

function tmpWorkspace(conversationId = "conv-1", dir = mkdtempSync(join(tmpdir(), "cron-ws-"))): WorkspaceMeta {
  return {
    conversationId,
    conversationType: "group",
    dir,
    expert: "general",
    editors: [],
    multimodal: false,
    digestsEnabled: false,
    createdAt: Date.now(),
    greeted: true,
  };
}

function fakeWorkspaces(list: WorkspaceMeta[]): WorkspacesLike {
  return { list: () => list };
}

/**
 * A workspace laid out like production (<root>/workspaces/<slug>) next to a
 * <root>/config/doushabao.json, so the literal traversal id from the audit —
 * "../../../config/doushabao" — resolves exactly onto that config file.
 */
function sandboxWorkspace(conversationId: string): { ws: WorkspaceMeta; victim: string } {
  const root = mkdtempSync(join(tmpdir(), "cron-root-"));
  const dir = join(root, "workspaces", "ws-1");
  mkdirSync(wsPaths(dir).jobs, { recursive: true });
  const victim = join(root, "config", "doushabao.json");
  mkdirSync(dirname(victim), { recursive: true });
  writeFileSync(victim, JSON.stringify({ secret: "keep me" }));
  return { ws: tmpWorkspace(conversationId, dir), victim };
}

function fakeDws(): DwsPort {
  return {
    async startConsuming() {},
    async stopConsuming() {},
    async sendText() {
      return {};
    },
    async downloadMedia() {
      return [];
    },
    async exportDoc() {},
    async doctor() {
      return { ok: true, detail: "" };
    },
  };
}

function fakeRunner(): PiRunnerPort {
  return {
    async run() {
      return { text: "ok", ok: true };
    },
  };
}

function baseCfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ timezone: "Asia/Shanghai", ...overrides });
}

const stopHandles: CronSvc[] = [];
afterEach(() => {
  for (const svc of stopHandles.splice(0)) svc.stop();
});

describe("syncDigests", () => {
  function svcFor(ws: WorkspaceMeta): CronSvc {
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    return svc;
  }

  test("enabling materializes the digest jobs, is idempotent, and disabling removes them", () => {
    const ws = tmpWorkspace("conv-digest-1");
    const svc = svcFor(ws);

    const first = svc.syncDigests(ws.conversationId, true);
    expect(first.added).toBeGreaterThan(0);
    const afterEnable = svc.listJobs(ws.conversationId);
    expect(afterEnable.length).toBe(first.added);
    expect(afterEnable.every((j) => j.createdBy === "system")).toBe(true);

    // Flipping the flag on twice must not duplicate the jobs.
    expect(svc.syncDigests(ws.conversationId, true)).toEqual({ added: 0, removed: 0 });
    expect(svc.listJobs(ws.conversationId).length).toBe(first.added);

    expect(svc.syncDigests(ws.conversationId, false)).toEqual({ added: 0, removed: first.added });
    expect(svc.listJobs(ws.conversationId)).toEqual([]);
  });

  test("disabling digests leaves an editor's own scheduled job alone", () => {
    const ws = tmpWorkspace("conv-digest-2");
    const svc = svcFor(ws);
    const mine = svc.addJob({
      conversationId: ws.conversationId,
      cronExpr: "0 8 * * *",
      description: "my own job",
      prompt: "do the thing",
      createdBy: "editor-1",
    });
    svc.syncDigests(ws.conversationId, true);
    svc.syncDigests(ws.conversationId, false);

    const left = svc.listJobs(ws.conversationId);
    expect(left.map((j) => j.id)).toEqual([mine.id]);
  });

  test("throws for an unknown conversationId", () => {
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    expect(() => svc.syncDigests("nope", true)).toThrow();
  });
});

describe("addJob / listJobs / removeJob", () => {
  test("addJob validates the cron expression and throws on invalid input", () => {
    const ws = tmpWorkspace();
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    expect(() =>
      svc.addJob({
        conversationId: ws.conversationId,
        cronExpr: "not a cron expr",
        description: "bad",
        prompt: "bad",
        createdBy: "admin-1",
      }),
    ).toThrow();
  });

  test("addJob throws for an unknown conversationId", () => {
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    expect(() =>
      svc.addJob({
        conversationId: "unknown",
        cronExpr: "0 9 * * *",
        description: "d",
        prompt: "p",
        createdBy: "admin-1",
      }),
    ).toThrow();
  });

  test("addJob persists a job file and returns it with id/createdAt/enabled", () => {
    const ws = tmpWorkspace();
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    const job = svc.addJob({
      conversationId: ws.conversationId,
      cronExpr: "0 9 * * *",
      description: "daily standup",
      prompt: "summarize",
      createdBy: "admin-1",
    });
    expect(job.id).toBeTruthy();
    expect(job.enabled).toBe(true);
    expect(typeof job.createdAt).toBe("number");

    const file = join(wsPaths(ws.dir).jobs, `${job.id}.json`);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.description).toBe("daily standup");
  });

  test("listJobs returns jobs for the conversation; [] for unknown/empty", () => {
    const ws = tmpWorkspace();
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    expect(svc.listJobs(ws.conversationId)).toEqual([]);
    svc.addJob({ conversationId: ws.conversationId, cronExpr: "0 9 * * *", description: "d1", prompt: "p1", createdBy: "a" });
    svc.addJob({ conversationId: ws.conversationId, cronExpr: "0 10 * * *", description: "d2", prompt: "p2", createdBy: "a" });
    expect(svc.listJobs(ws.conversationId)).toHaveLength(2);
    expect(svc.listJobs("no-such-conversation")).toEqual([]);
  });

  test("removeJob deletes the file and returns true; false when absent", () => {
    const ws = tmpWorkspace();
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async () => {},
    });
    stopHandles.push(svc);
    const job = svc.addJob({ conversationId: ws.conversationId, cronExpr: "0 9 * * *", description: "d", prompt: "p", createdBy: "a" });
    expect(svc.removeJob(ws.conversationId, job.id)).toBe(true);
    expect(svc.listJobs(ws.conversationId)).toEqual([]);
    expect(svc.removeJob(ws.conversationId, job.id)).toBe(false);
    expect(svc.removeJob("unknown-conv", randomUUID())).toBe(false);
  });
});

describe("job file containment", () => {
  function svcFor(ws: WorkspaceMeta, enqueueRun: (cid: string) => void = () => {}): CronSvc {
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async (cid) => enqueueRun(cid),
    });
    stopHandles.push(svc);
    return svc;
  }

  test("cancel_job with a traversal jobId is refused and the target file survives", () => {
    const { ws, victim } = sandboxWorkspace("conv-traversal");
    const svc = svcFor(ws);

    expect(() => svc.removeJob(ws.conversationId, "../../../config/doushabao")).toThrow();
    expect(existsSync(victim)).toBe(true);
    // An absolute path is the other half of the same trick.
    expect(() => svc.removeJob(ws.conversationId, victim.replace(/\.json$/, ""))).toThrow();
    expect(existsSync(victim)).toBe(true);
  });

  test("a legitimate uuid job still cancels normally", () => {
    const { ws } = sandboxWorkspace("conv-legit");
    const svc = svcFor(ws);
    const job = svc.addJob({
      conversationId: ws.conversationId,
      cronExpr: "0 9 * * *",
      description: "d",
      prompt: "p",
      createdBy: "editor-1",
    });
    const file = join(wsPaths(ws.dir).jobs, `${job.id}.json`);
    expect(existsSync(file)).toBe(true);
    expect(svc.removeJob(ws.conversationId, job.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
    // A well-formed id for a job that is not there is still just "not found".
    expect(svc.removeJob(ws.conversationId, randomUUID())).toBe(false);
  });

  test(
    "a job file whose id is a traversal string is not scheduled and cannot overwrite the target",
    async () => {
      const { ws, victim } = sandboxWorkspace("conv-planted");
      const before = readFileSync(victim, "utf8");
      const calls: string[] = [];
      const svc = svcFor(ws, (cid) => calls.push(cid));

      // Correctly named file, hostile `id` inside — the shape persistLastFiredAt
      // trusts. Firing it would rewrite the config file with this job's JSON.
      writeFileSync(
        join(wsPaths(ws.dir).jobs, `${randomUUID()}.json`),
        JSON.stringify({
          id: "../../../config/doushabao",
          conversationId: ws.conversationId,
          cronExpr: "* * * * * *",
          description: "planted",
          prompt: "tick",
          createdBy: "editor-1",
          createdAt: Date.now(),
          enabled: true,
        }),
      );

      expect(svc.listJobs(ws.conversationId)).toEqual([]);

      const snapshot = existsSync(paths.cronFired) ? readFileSync(paths.cronFired, "utf8") : undefined;
      try {
        svc.start();
        // Several ~1/s ticks: enough for the planted job to have fired.
        await new Promise((r) => setTimeout(r, 2_200));
      } finally {
        svc.stop();
        if (snapshot === undefined) {
          if (existsSync(paths.cronFired)) rmSync(paths.cronFired);
        } else {
          writeFileSync(paths.cronFired, snapshot);
        }
      }

      expect(calls).toEqual([]);
      expect(readFileSync(victim, "utf8")).toBe(before);
    },
    8_000,
  );
});

describe("start() live scheduling", () => {
  test(
    "fires an existing job via a real croner tick, enforcing the dedupe guard end-to-end",
    async () => {
      const ws = tmpWorkspace();
      const calls: { conversationId: string; prompt: string; opts: Record<string, unknown> }[] = [];

      const svc = createCron({
        cfg: baseCfg(),
        dws: fakeDws(),
        runner: fakeRunner(),
        workspaces: fakeWorkspaces([ws]),
        enqueueRun: async (conversationId, prompt, opts) => {
          calls.push({ conversationId, prompt, opts });
        },
      });

      // Write the job file directly (rather than via addJob) so this test
      // doesn't depend on addJob's live-scheduling branch, which gets its
      // own test below.
      const jobId = randomUUID();
      const dir = wsPaths(ws.dir).jobs;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${jobId}.json`),
        JSON.stringify({
          id: jobId,
          conversationId: ws.conversationId,
          cronExpr: "* * * * * *",
          description: "test",
          prompt: "hello from cron",
          createdBy: "admin-1",
          createdAt: Date.now(),
          enabled: true,
        }),
      );

      // createCron has no path-injection hook, so the dedupe guard writes to
      // the real var/cron-fired.json (same as production). Snapshot/restore
      // it so this test leaves no trace on the repo's runtime state.
      const snapshot = existsSync(paths.cronFired) ? readFileSync(paths.cronFired, "utf8") : undefined;

      try {
        svc.start();
        await waitUntil(() => calls.length > 0, 3_000);
        // A few more ~1/s ticks; the dedupe guard must suppress all of them.
        await new Promise((r) => setTimeout(r, 2_200));
      } finally {
        svc.stop();
        if (snapshot === undefined) {
          if (existsSync(paths.cronFired)) rmSync(paths.cronFired);
        } else {
          writeFileSync(paths.cronFired, snapshot);
        }
      }

      expect(calls).toHaveLength(1);
      expect(calls[0]?.conversationId).toBe(ws.conversationId);
      expect(calls[0]?.prompt).toContain("hello from cron");
      expect(calls[0]?.opts).toEqual({});

      const persisted = JSON.parse(readFileSync(join(dir, `${jobId}.json`), "utf8"));
      expect(typeof persisted.lastFiredAt).toBe("number");
    },
    8_000,
  );

  test(
    "addJob() after start() live-schedules the new job (no restart needed)",
    async () => {
      const ws = tmpWorkspace();
      const calls: { conversationId: string; prompt: string }[] = [];
      const svc = createCron({
        cfg: baseCfg(),
        dws: fakeDws(),
        runner: fakeRunner(),
        workspaces: fakeWorkspaces([ws]),
        enqueueRun: async (conversationId, prompt) => {
          calls.push({ conversationId, prompt });
        },
      });

      const snapshot = existsSync(paths.cronFired) ? readFileSync(paths.cronFired, "utf8") : undefined;
      try {
        svc.start(); // no jobs yet
        svc.addJob({
          conversationId: ws.conversationId,
          cronExpr: "* * * * * *", // 6-part: croner accepts seconds precision
          description: "runtime-added",
          prompt: "added after start",
          createdBy: "admin-1",
        });
        await waitUntil(() => calls.length > 0, 3_000);
      } finally {
        svc.stop();
        if (snapshot === undefined) {
          if (existsSync(paths.cronFired)) rmSync(paths.cronFired);
        } else {
          writeFileSync(paths.cronFired, snapshot);
        }
      }

      expect(calls[0]?.conversationId).toBe(ws.conversationId);
      expect(calls[0]?.prompt).toContain("added after start");
    },
    6_000,
  );

  test(
    "does not fire a job for a paused workspace, while an unpaused one still fires",
    async () => {
      const active = tmpWorkspace("conv-active");
      const paused: WorkspaceMeta = { ...tmpWorkspace("conv-paused"), paused: true };
      const calls: string[] = [];
      const svc = createCron({
        cfg: baseCfg(),
        dws: fakeDws(),
        runner: fakeRunner(),
        workspaces: fakeWorkspaces([active, paused]),
        enqueueRun: async (conversationId) => {
          calls.push(conversationId);
        },
      });

      for (const ws of [active, paused]) {
        const dir = wsPaths(ws.dir).jobs;
        mkdirSync(dir, { recursive: true });
        const jobId = randomUUID();
        writeFileSync(
          join(dir, `${jobId}.json`),
          JSON.stringify({
            id: jobId,
            conversationId: ws.conversationId,
            cronExpr: "* * * * * *",
            description: "test",
            prompt: "tick",
            createdBy: "admin-1",
            createdAt: Date.now(),
            enabled: true,
          }),
        );
      }

      const snapshot = existsSync(paths.cronFired) ? readFileSync(paths.cronFired, "utf8") : undefined;
      try {
        svc.start();
        // The unpaused workspace firing anchors the absence: both jobs tick
        // ~1/s, so by now the paused one has had its chances too.
        await waitUntil(() => calls.length > 0, 3_000);
        await new Promise((r) => setTimeout(r, 1_100));
      } finally {
        svc.stop();
        if (snapshot === undefined) {
          if (existsSync(paths.cronFired)) rmSync(paths.cronFired);
        } else {
          writeFileSync(paths.cronFired, snapshot);
        }
      }

      expect(calls).toEqual(["conv-active"]);
    },
    8_000,
  );

  test("start() is idempotent and stop() releases job timers", () => {
    const ws = tmpWorkspace();
    const svc = createCron({
      cfg: baseCfg(),
      dws: fakeDws(),
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([ws]),
      enqueueRun: async () => {},
    });
    expect(() => {
      svc.start();
      svc.start();
      svc.stop();
      svc.stop();
    }).not.toThrow();
  });
});

describe("heartbeat watchdog", () => {
  test("alerts admins on a fresh install, where var/last-event-at was never written", async () => {
    const root = mkdtempSync(join(tmpdir(), "cron-root-"));
    const prevRoot = process.env.DOUSHABAO_ROOT;
    // Wed 2026-08-19 10:00 Asia/Shanghai — inside the default work hours, and
    // clear of the 03:00 nightly tick.
    const t0 = Date.parse("2026-08-19T02:00:00Z");
    const dms: { to: string; text: string }[] = [];
    const dws: DwsPort = {
      ...fakeDws(),
      async sendText(to, _type, text) {
        dms.push({ to, text });
        return {};
      },
    };

    // Both must precede the import: shared/paths.ts bakes ROOT from the env
    // var at first load, and index.ts captures its boot timestamp there too.
    process.env.DOUSHABAO_ROOT = root; // fresh install — no var/last-event-at
    vi.useFakeTimers({ now: t0 });
    vi.resetModules();
    const { createCron: createFreshCron } = await import("./index.ts");

    const svc = createFreshCron({
      cfg: ConfigSchema.parse({ timezone: "Asia/Shanghai", admins: ["admin-1"], heartbeat: { quietMinutes: 30 } }),
      dws,
      runner: fakeRunner(),
      workspaces: fakeWorkspaces([]),
      enqueueRun: async () => {},
    });
    try {
      svc.start();
      await vi.advanceTimersByTimeAsync(36 * 60_000);
    } finally {
      svc.stop();
      vi.useRealTimers();
      if (prevRoot === undefined) delete process.env.DOUSHABAO_ROOT;
      else process.env.DOUSHABAO_ROOT = prevRoot;
    }

    expect(dms).toHaveLength(1);
    expect(dms[0]?.to).toBe("admin-1");
    expect(dms[0]?.text).toContain("30 minutes");
  });
});

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
