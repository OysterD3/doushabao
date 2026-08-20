import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Config,
  ConversationType,
  DwsPort,
  InboundEvent,
  InboundMessage,
  InboundReaction,
  PiRunnerPort,
  WorkspaceMeta,
} from "../shared/types.ts";
import { ConfigSchema, expertToolNames } from "../shared/types.ts";
import { createRouter, type WorkspaceRegistryLike } from "./router.ts";

// ---------------------------------------------------------------------------
// Inline fakes for the ports this module depends on (allowed: these are
// ports/contracts we own or assume, not our own modules' real code).
// ---------------------------------------------------------------------------

function makeFakeWorkspaces(root: string) {
  const store = new Map<string, WorkspaceMeta>();
  const transcripts = new Map<string, string[]>();
  const registry: WorkspaceRegistryLike = {
    async getOrCreate(conversationId, conversationType) {
      let meta = store.get(conversationId);
      let created = false;
      if (!meta) {
        created = true;
        const dir = join(root, conversationId.replace(/[^a-zA-Z0-9]+/g, "_"));
        mkdirSync(dir, { recursive: true });
        meta = {
          conversationId,
          conversationType,
          dir,
          expert: "general",
          editors: [],
          multimodal: false,
          digestsEnabled: false,
          createdAt: Date.now(),
          greeted: false,
        };
        store.set(conversationId, meta);
      }
      return { meta, created };
    },
    get(conversationId) {
      return store.get(conversationId);
    },
    async patchMeta(conversationId, patch) {
      const meta = store.get(conversationId);
      if (!meta) throw new Error(`unknown workspace ${conversationId}`);
      Object.assign(meta, patch);
      return meta;
    },
    async appendTranscript(conversationId, entry) {
      const lines = transcripts.get(conversationId) ?? [];
      lines.push(`${entry.senderName ?? entry.senderId}: ${entry.text}`);
      transcripts.set(conversationId, lines);
    },
    async transcriptTail(conversationId, n) {
      return (transcripts.get(conversationId) ?? []).slice(-n);
    },
    async kbDigest() {
      return "KB: (none)";
    },
  };
  return { registry, store, transcripts };
}

function makeFakeDws() {
  const sent: { conversationId: string; conversationType: ConversationType; text: string }[] = [];
  const dws: DwsPort = {
    async startConsuming() {},
    async stopConsuming() {},
    async sendText(conversationId, conversationType, text) {
      sent.push({ conversationId, conversationType, text });
      return { messageId: `m${sent.length}` };
    },
    async downloadMedia() {
      return [];
    },
    async exportDoc() {},
    async doctor() {
      return { ok: true, detail: "fake" };
    },
  };
  return { dws, sent };
}

type RunOpts = Parameters<PiRunnerPort["run"]>[0];
type RunResult = Awaited<ReturnType<PiRunnerPort["run"]>>;

function makeFakeRunner(handler: (opts: RunOpts) => Promise<RunResult>) {
  const calls: RunOpts[] = [];
  const runner: PiRunnerPort = {
    async run(opts) {
      calls.push(opts);
      return handler(opts);
    },
  };
  return { runner, calls };
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    admins: [],
    timezone: "UTC",
    ...overrides,
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function dmMessage(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    eventId: `e${Math.random()}`,
    messageId: `msg${Math.random()}`,
    conversationId: "conv-dm-1",
    conversationType: "dm",
    senderId: "u1",
    senderName: "Alice",
    content: "hello",
    mention: false,
    receivedAt: Date.now(),
    ...over,
  };
}

let rootDir: string;
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "doushabao-router-"));
});
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("router", () => {
  test("DM message triggers a run; group message without mention does not; group message with mention does", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "handled", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-dm", content: "hi" }));
    await waitFor(() => calls.length === 1);

    await router.handleEvent(
      dmMessage({ conversationId: "c-group", conversationType: "group", mention: false, content: "just chatting" }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1); // unchanged

    await router.handleEvent(
      dmMessage({ conversationId: "c-group", conversationType: "group", mention: true, content: "@bot help" }),
    );
    await waitFor(() => calls.length === 2);
  });

  test("every message is appended to the transcript, even when not triggering", async () => {
    const { registry, transcripts } = makeFakeWorkspaces(rootDir);
    const { dws } = makeFakeDws();
    const { runner } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(
      dmMessage({ conversationId: "c-group2", conversationType: "group", mention: false, content: "not a trigger" }),
    );

    const meta = registry.get("c-group2");
    expect(meta).toBeDefined();
    expect(transcripts.get("c-group2")?.join("\n")).toContain("not a trigger");
  });

  test("greeting is sent once on workspace creation, not on subsequent messages", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "[SILENT]", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-greet" }));
    await waitFor(() => calls.length === 1);
    await router.handleEvent(dmMessage({ conversationId: "c-greet", content: "again" }));
    await waitFor(() => calls.length === 2);

    const greetings = sent.filter((s) => s.text.includes("digital employee"));
    expect(greetings.length).toBe(1);
    const meta = registry.get("c-greet");
    expect(meta?.greeted).toBe(true);
  });

  test("greeting stays once even when two messages race a brand-new conversation", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "[SILENT]", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    // Two messages to the same brand-new conversation, not awaited between
    // each other — both handlers observe the workspace mid-creation.
    await Promise.all([
      router.handleEvent(dmMessage({ conversationId: "c-race", content: "first" })),
      router.handleEvent(dmMessage({ conversationId: "c-race", content: "second" })),
    ]);
    await waitFor(() => calls.length === 2);

    const greetings = sent.filter((s) => s.text.includes("digital employee"));
    expect(greetings.length).toBe(1);
  });

  test("[SILENT] prefix suppresses the reply", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "[SILENT] internal only", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-silent" }));
    await waitFor(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));

    const nonGreeting = sent.filter((s) => !s.text.includes("digital employee"));
    expect(nonGreeting.length).toBe(0);
  });

  test("ok:false produces an apology reply", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner } = makeFakeRunner(async () => ({ text: "", ok: false, error: "boom" }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-fail" }));

    await waitFor(() => sent.some((s) => s.text.toLowerCase().includes("sorry")));
    const apology = sent.find((s) => s.text.toLowerCase().includes("sorry"));
    expect(apology).toBeDefined();
  });

  test("workspace daily run budget cuts off with a polite reply", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const cfg = testConfig({ budgets: { perWorkspaceDailyRuns: 1, perUserDailyRuns: 200, writesPerWorkspacePerHour: 20, maxConcurrentTasks: 3 } });
    const router = createRouter({ cfg, dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-budget", senderId: "u1" }));
    await router.handleEvent(dmMessage({ conversationId: "c-budget", senderId: "u2", content: "second" }));

    expect(sent.some((s) => s.text.toLowerCase().includes("budget"))).toBe(true);
    await waitFor(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });

  test("per-user daily run budget cuts off with a polite reply", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const cfg = testConfig({ budgets: { perWorkspaceDailyRuns: 200, perUserDailyRuns: 1, writesPerWorkspacePerHour: 20, maxConcurrentTasks: 3 } });
    const router = createRouter({ cfg, dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-u1", senderId: "u-budget" }));
    await router.handleEvent(dmMessage({ conversationId: "c-u2", senderId: "u-budget", content: "second convo" }));

    expect(sent.some((s) => s.text.toLowerCase().includes("budget"))).toBe(true);
    await waitFor(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });

  test("runCounts reflects workspace and user run counts", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws } = makeFakeDws();
    const { runner } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-count", senderId: "u-count" }));
    await router.handleEvent(dmMessage({ conversationId: "c-count", senderId: "u-count", content: "again" }));

    const counts = router.runCounts();
    expect(counts.workspaceToday["c-count"]).toBe(2);
    expect(counts.userToday["u-count"]).toBe(2);
  });

  test("pendingResolver consuming a message still records the transcript, but triggers no run (binding decision #9)", async () => {
    const { registry, transcripts } = makeFakeWorkspaces(rootDir);
    // Pre-provisioned and already greeted, as a workspace with an open
    // pending always is in the real system (a pending can only exist once
    // an agent has already run there).
    await registry.getOrCreate("c-consumed", "group");
    await registry.patchMeta("c-consumed", { greeted: true });
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });
    router.setPendingResolver(async () => true);

    await router.handleEvent(
      dmMessage({ conversationId: "c-consumed", conversationType: "group", mention: true, content: "the answer" }),
    );

    expect(calls.length).toBe(0); // no run triggered — the message answered a pending instead
    expect(sent.length).toBe(0);
    expect(transcripts.get("c-consumed")?.join("\n")).toContain("the answer"); // still transcribed
  });

  test("pendingResolver not consuming lets normal handling proceed; reactions never trigger runs", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });
    router.setPendingResolver(async (ev: InboundEvent) => ev.kind === "reaction");

    const reaction: InboundReaction = {
      kind: "reaction",
      eventId: "e1",
      messageId: "m1",
      conversationId: "c-react",
      operatorId: "u1",
      emoji: "+1",
      operation: "add",
      receivedAt: Date.now(),
    };
    await router.handleEvent(reaction);
    expect(sent.length).toBe(0);
    expect(calls.length).toBe(0);

    await router.handleEvent(dmMessage({ conversationId: "c-react-2" }));
    await waitFor(() => calls.length === 1);
  });

  test("multimodal workspace runs on the vision model; an explicit modelOverride still wins", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-vision", "dm");
    await registry.patchMeta("c-vision", { greeted: true, multimodal: true });
    const { dws } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const cfg = testConfig({ models: { default: "cheap-model", distillation: "", vision: "vision-model" } });
    const router = createRouter({ cfg, dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-vision", content: "look at this" }));
    await waitFor(() => calls.length === 1);
    expect(calls[0]?.model).toBe("vision-model");

    await registry.patchMeta("c-vision", { modelOverride: "override-model" });
    await router.handleEvent(dmMessage({ conversationId: "c-vision", content: "and this" }));
    await waitFor(() => calls.length === 2);
    expect(calls[1]?.model).toBe("override-model");
  });

  test("multimodal workspace falls through to the default model when no vision model is configured", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-vision-none", "dm");
    await registry.patchMeta("c-vision-none", { greeted: true, multimodal: true });
    const { dws } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const cfg = testConfig({ models: { default: "cheap-model", distillation: "", vision: "" } });
    const router = createRouter({ cfg, dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.handleEvent(dmMessage({ conversationId: "c-vision-none" }));
    await waitFor(() => calls.length === 1);
    expect(calls[0]?.model).toBe("cheap-model");
  });

  test("each run gets its workspace expert's tool allowlist, so different experts get different tools", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-debug", "dm");
    await registry.patchMeta("c-debug", { greeted: true, expert: "debug" });
    await registry.getOrCreate("c-project", "dm");
    await registry.patchMeta("c-project", { greeted: true, expert: "project" });
    const { dws } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    // One at a time: separate conversations run in parallel lanes, so
    // enqueueing both at once leaves `calls` order undefined.
    await router.enqueueRun("c-debug", "diagnose", { ack: false });
    await waitFor(() => calls.length === 1);
    await router.enqueueRun("c-project", "plan the sprint", { ack: false });
    await waitFor(() => calls.length === 2);

    const debugTools = calls[0]?.tools;
    const projectTools = calls[1]?.tools;
    expect(debugTools).toEqual(expertToolNames("debug"));
    expect(projectTools).toEqual(expertToolNames("project"));
    // Diagnosis has no side-effect surface; a project workspace does.
    expect(debugTools).not.toContain("doushabao_worktool");
    expect(projectTools).toContain("doushabao_worktool");
    expect(debugTools).not.toEqual(projectTools);
  });

  test("paused workspace records the message but starts no run; resuming restores normal handling", async () => {
    const { registry, transcripts } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-paused", "dm");
    await registry.patchMeta("c-paused", { greeted: true, paused: true });
    const { dws, sent } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });
    // A pending must not be consumed either — that path can run the agent too.
    let pendingCalls = 0;
    router.setPendingResolver(async () => {
      pendingCalls++;
      return false;
    });

    await router.handleEvent(dmMessage({ conversationId: "c-paused", content: "while paused" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(0);
    expect(sent.length).toBe(0);
    expect(pendingCalls).toBe(0);
    expect(transcripts.get("c-paused")?.join("\n")).toContain("while paused");

    await registry.patchMeta("c-paused", { paused: false });
    await router.handleEvent(dmMessage({ conversationId: "c-paused", content: "after resume" }));
    await waitFor(() => calls.length === 1);
    expect(transcripts.get("c-paused")?.join("\n")).toContain("after resume");
  });

  test("a message delivered twice is transcribed once, and the late mention still triggers exactly one run", async () => {
    const { registry, transcripts } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-dup", "group");
    await registry.patchMeta("c-dup", { greeted: true });
    const { dws } = makeFakeDws();
    const { runner, calls } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    // The `_group_all` copy flushes as a non-mention, then the `_at` sibling
    // lands late with its own eventId — dws cannot pair them any more.
    const groupAll = dmMessage({
      conversationId: "c-dup",
      conversationType: "group",
      messageId: "m-dup",
      eventId: "e-group-all",
      mention: false,
      content: "@bot status please",
    });
    await router.handleEvent(groupAll);
    await router.handleEvent({ ...groupAll, eventId: "e-at", mention: true });

    await waitFor(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
    expect(transcripts.get("c-dup")?.filter((line) => line.includes("status please")).length).toBe(1);
  });

  test("the transcribed-messageId window is bounded: an evicted id is transcribed again", async () => {
    const { registry, transcripts } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-bound", "group");
    await registry.patchMeta("c-bound", { greeted: true });
    const { dws } = makeFakeDws();
    const { runner } = makeFakeRunner(async () => ({ text: "ok", ok: true }));
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    const first = dmMessage({
      conversationId: "c-bound",
      conversationType: "group",
      messageId: "m-oldest",
      mention: false,
      content: "oldest line",
    });
    await router.handleEvent(first);
    // More than TRANSCRIBED_MAX (500) later messages, so "m-oldest" is evicted.
    for (let i = 0; i < 600; i++) {
      await router.handleEvent(
        dmMessage({ conversationId: "c-bound", conversationType: "group", messageId: `m-${i}`, mention: false, content: `filler ${i}` }),
      );
    }
    await router.handleEvent(first);

    expect(transcripts.get("c-bound")?.filter((line) => line.includes("oldest line")).length).toBe(2);
  });

  test("quick-ack fires once for a slow run and is skipped for a fast run", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);

    // slow run
    {
      const { dws, sent } = makeFakeDws();
      const { runner } = makeFakeRunner(
        (opts) =>
          new Promise((resolve) => setTimeout(() => resolve({ text: "done", ok: true }), 60)),
      );
      const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" }, quickAckMs: 20 });
      await router.handleEvent(dmMessage({ conversationId: "c-slow" }));
      await waitFor(() => sent.some((s) => s.text.includes("On it")));
      await waitFor(() => sent.some((s) => s.text === "done"));
      expect(sent.filter((s) => s.text.includes("On it")).length).toBe(1);
    }

    // fast run
    {
      const { dws, sent } = makeFakeDws();
      const { runner } = makeFakeRunner(async () => ({ text: "fast-done", ok: true }));
      const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" }, quickAckMs: 200 });
      await router.handleEvent(dmMessage({ conversationId: "c-fast" }));
      await waitFor(() => sent.some((s) => s.text === "fast-done"));
      await new Promise((r) => setTimeout(r, 30));
      expect(sent.some((s) => s.text.includes("On it"))).toBe(false);
    }
  });

  test("FIFO lane: two runs on the same conversation serialize (concurrency 1 per lane)", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    await registry.getOrCreate("c-lane", "dm");
    const { dws, sent } = makeFakeDws();

    const started: string[] = [];
    const resolvers = new Map<string, (v: RunResult) => void>();
    const { runner } = makeFakeRunner(async (opts) => {
      const tag = opts.prompt.includes("task-A") ? "task-A" : "task-B";
      started.push(tag);
      return new Promise<RunResult>((resolve) => resolvers.set(tag, resolve));
    });
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    await router.enqueueRun("c-lane", "task-A", { ack: false });
    await router.enqueueRun("c-lane", "task-B", { ack: false });

    await waitFor(() => started.length === 1);
    expect(started).toEqual(["task-A"]);

    resolvers.get("task-A")!({ text: "A-done", ok: true });
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["task-A", "task-B"]);

    resolvers.get("task-B")!({ text: "B-done", ok: true });
    await waitFor(() => sent.some((s) => s.text === "B-done"));
    expect(sent.map((s) => s.text)).toEqual(["A-done", "B-done"]);
  });

  test("global cap of 3 concurrent runs, parallel across conversations", async () => {
    const { registry } = makeFakeWorkspaces(rootDir);
    const cids = ["c-g1", "c-g2", "c-g3", "c-g4"];
    for (const cid of cids) await registry.getOrCreate(cid, "dm");
    const { dws, sent } = makeFakeDws();

    let active = 0;
    let maxActive = 0;
    const resolvers: (() => void)[] = [];
    const { runner } = makeFakeRunner(
      () =>
        new Promise<RunResult>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          resolvers.push(() => {
            active--;
            resolve({ text: "done", ok: true });
          });
        }),
    );
    const router = createRouter({ cfg: testConfig(), dws, runner, workspaces: registry, ipc: { api: "http://x", token: "t" } });

    for (const cid of cids) await router.enqueueRun(cid, `p-${cid}`, { ack: false });

    await waitFor(() => resolvers.length === 3);
    expect(maxActive).toBe(3);

    resolvers.shift()!();
    await waitFor(() => resolvers.length === 3);
    expect(maxActive).toBe(3);

    while (resolvers.length > 0) resolvers.shift()!();
    await waitFor(() => sent.filter((s) => s.text === "done").length === 4);
  });
});
