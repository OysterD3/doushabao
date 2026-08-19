/**
 * doushabao daemon entrypoint — wiring only. See ARCHITECTURE.md for the
 * module map and the IPC contract this file implements.
 *
 * Token/ipc note: src/api's start() generates and writes the ipc token
 * itself (paths.ipcToken, mode 0600) and returns {port, token} — so `ipc`
 * (and anything built from it: tasks, router) can only be built AFTER
 * api.start() resolves. But createApi(...) needs `tasks` at construction
 * time, before start() runs. Resolved the same way as the router/enqueueRun
 * circularity below: a `let` binding + indirection object, assigned once
 * the real `tasks` exists.
 */
import { loadConfig, ensureVarDirs } from "./config.ts";
import { createDws } from "./dws/index.ts";
import { createPiRunner } from "./pi/index.ts";
import { createWorkspaceRegistry } from "./workspace/index.ts";
import { createTasks, type Tasks } from "./tasks/index.ts";
import { createWorktools } from "./worktools/index.ts";
import { createCron } from "./cron/index.ts";
import { createApi } from "./api/index.ts";
import { createRouter, type RunOpts } from "./router/index.ts";

async function main() {
  const cfg = loadConfig();
  ensureVarDirs();

  const dws = createDws(cfg);
  const runner = createPiRunner(cfg);
  const workspaces = createWorkspaceRegistry(cfg);
  const worktools = createWorktools({ cfg, dws, workspaces });

  // router is constructed after api (it needs api.tryResolvePending), but
  // cron needs to enqueue runs on router's FIFO lanes before router exists.
  // Resolve with a `let` binding + arrow-function indirection: the closure
  // isn't invoked until after `router` is assigned below.
  let router!: ReturnType<typeof createRouter>;
  const enqueueRun = (conversationId: string, prompt: string, opts?: Record<string, unknown>): Promise<void> =>
    router.enqueueRun(conversationId, prompt, opts as RunOpts | undefined);

  const cron = createCron({ cfg, dws, runner, workspaces, enqueueRun });

  // Same indirection pattern for `tasks`: api needs a tasks reference at
  // construction time, but the real tasks registry needs `ipc`, which is
  // only known once api.start() has generated its token.
  let tasks!: Tasks;
  const tasksIndirect: Tasks = {
    create: (cid, requesterId, requestText) => tasks.create(cid, requesterId, requestText),
    bootRescan: () => tasks.bootRescan(),
    summary: () => tasks.summary(),
    list: (cid) => tasks.list(cid),
    retry: (id) => tasks.retry(id),
  };

  const api = createApi({ cfg, dws, workspaces, tasks: tasksIndirect, cron, worktools, enqueueRun });
  const { port, token } = await api.start();
  const ipc = { api: `http://${cfg.http.host}:${port}`, token };

  tasks = createTasks({ cfg, runner, workspaces, enqueueRun, ipc });
  router = createRouter({ cfg, dws, runner, workspaces, ipc });
  router.setPendingResolver((ev) => api.tryResolvePending(ev));

  await tasks.bootRescan();
  cron.start();

  const sweepInterval = setInterval(() => {
    api.sweepExpired().catch((err: unknown) => {
      console.error("[doushabao] sweepExpired error:", err);
    });
  }, 60_000);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[doushabao] received ${signal}, shutting down...`);
    clearInterval(sweepInterval);
    await dws.stopConsuming();
    cron.stop();
    await api.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  await dws.startConsuming((ev) => router.handleEvent(ev));

  console.log(`[doushabao] daemon started, listening on ${ipc.api} (pid ${process.pid}, tz ${cfg.timezone})`);
}

main().catch((err: unknown) => {
  console.error("[doushabao] fatal startup error:", err);
  process.exit(1);
});
