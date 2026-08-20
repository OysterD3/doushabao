/**
 * src/api tests. Sets DOUSHABAO_ROOT to a tmp dir *before* the first (dynamic)
 * import of anything that touches src/shared/paths.ts, since that module
 * bakes `ROOT`/`paths` from the env var once, at first import — same
 * convention as src/tasks and src/workspace's test files.
 *
 * Drives the real Api over an ephemeral HTTP port (cfg.http.port = 0) plus
 * handleToolRequest/tryResolvePending/sweepExpired directly, against inline
 * in-memory port fakes for workspaces/tasks/cron/worktools/dws (all of these
 * are `unknown`-typed dependencies per the module contract — this module
 * does not own any of them, so it does not import their real
 * implementations here; see final report for the exact surface expected).
 */
import { beforeEach, describe, expect, test } from "vitest";
import { statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = await mkdtemp(join(tmpdir(), "doushabao-api-"));
process.env.DOUSHABAO_ROOT = ROOT;

const { createApi } = await import("./index.ts");
const { paths } = await import("../shared/paths.ts");
const { ConfigSchema } = await import("../shared/types.ts");
const { canApprove, isAdmin, isEditor, matchApprovalReply, matchReply } = await import("./authz.ts");
const { listPending, savePending } = await import("./pending.ts");

import type {
  Config,
  DwsPort,
  InboundEvent,
  KbEntry,
  PendingQuestion,
  ToolRequest,
  ToolResponse,
  WorkspaceMeta,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeCfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ admins: ["admin-1"], http: { host: "127.0.0.1", port: 0 }, ...overrides });
}

function makeMeta(over: Partial<WorkspaceMeta> & { conversationId: string }): WorkspaceMeta {
  return {
    conversationType: "group",
    dir: "/fake-ws",
    expert: "general",
    editors: [],
    multimodal: false,
    digestsEnabled: false,
    createdAt: Date.now(),
    greeted: true,
    ...over,
  };
}

/** `noMessageIds` mimics a send whose message id never came back (dws prints
 * no id, or the send response could not be parsed) — the case the old
 * reaction fallback used to serve. */
function makeFakeDws(noMessageIds = false) {
  const sent: { conversationId: string; conversationType: string; text: string }[] = [];
  let n = 0;
  const dws: DwsPort = {
    async startConsuming() {},
    async stopConsuming() {},
    async sendText(conversationId, conversationType, text) {
      sent.push({ conversationId, conversationType, text });
      return noMessageIds ? {} : { messageId: `msg-${++n}` };
    },
    async downloadMedia() {
      return [];
    },
    async exportDoc() {},
    async doctor() {
      return { ok: true, detail: "ok" };
    },
  };
  return { dws, sent };
}

function makeFakeWorkspaces(metas: WorkspaceMeta[] = []) {
  const map = new Map(metas.map((m) => [m.conversationId, m]));
  const kb: KbEntry[] = [];
  const patches: { cid: string; patch: Record<string, unknown> }[] = [];
  const unanswered: { cid: string; question: string; senderId: string }[] = [];
  const escalations: { cid: string; question: string; context: string; senderId: string }[] = [];
  let kbSeq = 0;

  const workspaces = {
    get(cid: string) {
      return map.get(cid);
    },
    list() {
      return [...map.values()];
    },
    async patchMeta(cid: string, patch: Record<string, unknown>) {
      const cur = map.get(cid);
      const updated = { ...cur, ...patch } as WorkspaceMeta;
      map.set(cid, updated);
      patches.push({ cid, patch });
      return updated;
    },
    async kbSave(entry: { question: string; answer: string; scope: "workspace" | "global"; conversationId?: string; injectedBy: string }) {
      const full: KbEntry = { ...entry, id: `kb-${++kbSeq}`, injectedAt: Date.now(), revoked: false };
      kb.push(full);
      return full;
    },
    async kbList(cid: string) {
      return kb.filter((e) => !e.revoked && (e.scope === "global" || e.conversationId === cid));
    },
    async kbPromote(kbId: string) {
      const e = kb.find((k) => k.id === kbId && k.scope !== "global");
      if (!e) return undefined;
      e.scope = "global";
      delete e.conversationId;
      return e;
    },
    async kbRevoke(kbId: string) {
      const e = kb.find((k) => k.id === kbId);
      if (!e) return false;
      e.revoked = true;
      return true;
    },
    async memoryAdmin(_cid: string, op: string): Promise<ToolResponse> {
      return { ok: true, message: `memory ${op} ok` };
    },
    async recordEscalation(cid: string, question: string, context: string, senderId: string) {
      escalations.push({ cid, question, context, senderId });
    },
    async recordUnanswered(cid: string, question: string, senderId: string) {
      unanswered.push({ cid, question, senderId });
    },
  };
  return { workspaces, map, kb, patches, unanswered, escalations };
}

function makeFakeTasks() {
  const created: { id: string; cid: string; requesterId: string; requestText: string }[] = [];
  const retried: string[] = [];
  let seq = 0;
  const tasks = {
    async create(cid: string, requesterId: string, requestText: string) {
      const t = { id: `task-${++seq}`, cid, requesterId, requestText };
      created.push(t);
      return t;
    },
    summary() {
      return { queued: 0, running: 0, done: 0, failed: 0 };
    },
    list(cid?: string) {
      return cid ? created.filter((t) => t.cid === cid) : created;
    },
    async retry(id: string) {
      const found = created.some((t) => t.id === id);
      if (found) retried.push(id);
      return found;
    },
  };
  return { tasks, created, retried };
}

function makeFakeCron() {
  interface Job {
    id: string;
    conversationId: string;
    cronExpr: string;
    description: string;
    prompt: string;
    createdBy: string;
  }
  const jobs: Job[] = [];
  let seq = 0;
  const cron = {
    addJob(input: Omit<Job, "id">): Job {
      const job: Job = { ...input, id: `job-${++seq}` };
      jobs.push(job);
      return job;
    },
    removeJob(cid: string, id: string): boolean {
      const idx = jobs.findIndex((j) => j.conversationId === cid && j.id === id);
      if (idx === -1) return false;
      jobs.splice(idx, 1);
      return true;
    },
    listJobs(cid: string): Job[] {
      return jobs.filter((j) => j.conversationId === cid);
    },
    // Mirrors the real cron: digest jobs are "system"-created and identified
    // by description, so an editor's own jobs are never touched.
    syncDigests(cid: string, enabled: boolean): { added: number; removed: number } {
      const digests = jobs.filter((j) => j.conversationId === cid && j.createdBy === "system" && j.description.startsWith("DIGEST:"));
      if (!enabled) {
        for (const j of digests) this.removeJob(cid, j.id);
        return { added: 0, removed: digests.length };
      }
      if (digests.length > 0) return { added: 0, removed: 0 };
      this.addJob({ conversationId: cid, cronExpr: "0 9 * * 1-5", description: "DIGEST: standup", prompt: "digest", createdBy: "system" });
      return { added: 1, removed: 0 };
    },
  };
  return { cron, jobs };
}

function makeFakeWorktools(affectsOthers = false) {
  const executed: ToolRequest[] = [];
  const worktools = {
    affectsOthers() {
      return affectsOthers;
    },
    async execute(req: ToolRequest): Promise<ToolResponse> {
      executed.push(req);
      return { ok: true, message: "worktool ran" };
    },
  };
  return { worktools, executed };
}

function makeEnqueue() {
  const calls: { cid: string; prompt: string; opts?: Record<string, unknown> }[] = [];
  const enqueueRun = async (cid: string, prompt: string, opts?: Record<string, unknown>) => {
    calls.push({ cid, prompt, opts });
  };
  return { calls, enqueueRun };
}

function makeApi(
  opts: { cfgOverrides?: Record<string, unknown>; metas?: WorkspaceMeta[]; affectsOthers?: boolean; noMessageIds?: boolean } = {},
) {
  const cfg = makeCfg(opts.cfgOverrides);
  const { dws, sent } = makeFakeDws(opts.noMessageIds ?? false);
  const { workspaces, map, kb, patches, unanswered, escalations } = makeFakeWorkspaces(opts.metas ?? []);
  const { tasks, created, retried } = makeFakeTasks();
  const { cron, jobs } = makeFakeCron();
  const { worktools, executed } = makeFakeWorktools(opts.affectsOthers ?? false);
  const enqueue = makeEnqueue();
  const api = createApi({ cfg, dws, workspaces, tasks, cron, worktools, enqueueRun: enqueue.enqueueRun });
  return { api, cfg, dws, sent, workspaces, map, kb, patches, unanswered, escalations, tasks, created, retried, cron, jobs, worktools, executed, enqueue };
}

async function readAudit(): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(paths.auditLog, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function readPendings(): Promise<PendingQuestion[]> {
  const names = await readdir(paths.pending);
  const out: PendingQuestion[] = [];
  for (const name of names) out.push(JSON.parse(await readFile(join(paths.pending, name), "utf8")) as PendingQuestion);
  return out;
}

/** Isolate each test from the last: sweepExpired/tryResolvePending scan
 * *every* open pending, so a leftover from one test would leak into the
 * next test's fake-dws assertions. */
async function clearVar(): Promise<void> {
  await rm(paths.pending, { recursive: true, force: true });
  await rm(paths.auditLog, { force: true });
  await rm(paths.ipcToken, { force: true });
}

beforeEach(async () => {
  await clearVar();
});

// ---------------------------------------------------------------------------
// start / stop / http
// ---------------------------------------------------------------------------

describe("start/stop + http transport", () => {
  test("start writes a 0600 ipc token, health check works, tool requires bearer auth", async () => {
    const { api, sent } = makeApi();
    const { port, token } = await api.start();
    try {
      expect(port).toBeGreaterThan(0);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const mode = statSync(paths.ipcToken).mode & 0o777;
      expect(mode).toBe(0o600);

      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const noAuth = await fetch(`${base}/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "send_message", conversationId: "c1", senderId: "u1", text: "hi" }),
      });
      expect(noAuth.status).toBe(401);

      const badAuth = await fetch(`${base}/tool`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ tool: "send_message", conversationId: "c1", senderId: "u1", text: "hi" }),
      });
      expect(badAuth.status).toBe(401);

      const ok = await fetch(`${base}/tool`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "send_message", conversationId: "c1", senderId: "u1", text: "hi" }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as ToolResponse;
      expect(body.ok).toBe(true);
      expect(sent).toEqual([{ conversationId: "c1", conversationType: "group", text: "hi" }]);
    } finally {
      await api.stop();
    }
  });

  test("honors a pre-generated deps.token instead of minting its own", async () => {
    const cfg = makeCfg();
    const { dws } = makeFakeDws();
    const { workspaces } = makeFakeWorkspaces();
    const { tasks } = makeFakeTasks();
    const { cron } = makeFakeCron();
    const { worktools } = makeFakeWorktools();
    const enqueue = makeEnqueue();
    const api = createApi({ cfg, dws, workspaces, tasks, cron, worktools, enqueueRun: enqueue.enqueueRun, token: "a".repeat(64) });
    const { token } = await api.start();
    try {
      expect(token).toBe("a".repeat(64));
    } finally {
      await api.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Authz matrix (through the real HTTP endpoint)
// ---------------------------------------------------------------------------

describe("authz matrix", () => {
  // Each row runs in a workspace whose expert profile actually carries the
  // tool — otherwise the profile gate would answer first and the tier check
  // under test would never run. dev-mgmt carries set_workspace/ops/
  // memory_admin, qa-cs carries the kb_* family.
  const ws1 = makeMeta({ conversationId: "ws1", expert: "dev-mgmt", editors: ["editor-1"], owner: "owner-1" });
  const wsQa = makeMeta({ conversationId: "ws-qa", expert: "qa-cs", editors: ["editor-1"], owner: "owner-1" });

  async function callAsRow(base: string, token: string, req: ToolRequest): Promise<ToolResponse> {
    const res = await fetch(`${base}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });
    return (await res.json()) as ToolResponse;
  }

  test("editor / admin / random-sender rows resolve as specified", async () => {
    const { api, map } = makeApi({ metas: [ws1, wsQa] });
    const { port, token } = await api.start();
    try {
      const base = `http://127.0.0.1:${port}`;

      // kb_save: editor ok, random denied, admin ok anywhere
      expect((await callAsRow(base, token, { tool: "kb_save", conversationId: "ws-qa", senderId: "editor-1", question: "q", answer: "a" })).ok).toBe(true);
      expect((await callAsRow(base, token, { tool: "kb_save", conversationId: "ws-qa", senderId: "random", question: "q", answer: "a" })).ok).toBe(false);
      expect((await callAsRow(base, token, { tool: "kb_save", conversationId: "ws-qa", senderId: "admin-1", question: "q2", answer: "a2" })).ok).toBe(true);

      // kb_promote: admins only
      expect((await callAsRow(base, token, { tool: "kb_promote", conversationId: "ws-qa", senderId: "editor-1", kbId: "x" })).ok).toBe(false);
      expect((await callAsRow(base, token, { tool: "kb_promote", conversationId: "ws-qa", senderId: "random", kbId: "x" })).ok).toBe(false);

      // memory_admin: editor own-workspace ok, random denied
      expect((await callAsRow(base, token, { tool: "memory_admin", conversationId: "ws1", senderId: "editor-1", op: "list" })).ok).toBe(true);
      expect((await callAsRow(base, token, { tool: "memory_admin", conversationId: "ws1", senderId: "random", op: "list" })).ok).toBe(false);

      // ops: admins only
      expect((await callAsRow(base, token, { tool: "ops", conversationId: "ws1", senderId: "editor-1", op: "status" })).ok).toBe(false);
      expect((await callAsRow(base, token, { tool: "ops", conversationId: "ws1", senderId: "admin-1", op: "status" })).ok).toBe(true);

      // any-sender bucket: random sender may ask_user / send_message / delegate_async / list_jobs
      expect(
        (await callAsRow(base, token, {
          tool: "ask_user",
          conversationId: "ws1",
          senderId: "random",
          question: "pick one",
          options: ["a", "b"],
          defaultOption: -1,
          purpose: "question",
          approverScope: "requester",
        })).ok,
      ).toBe(true);
      expect((await callAsRow(base, token, { tool: "list_jobs", conversationId: "ws1", senderId: "random" })).ok).toBe(true);

      // set_workspace: editor may touch editors/owner/digestsEnabled, not expert/model/multimodal.
      // Last on purpose: the admin row below repoints ws1 at the project
      // profile, which no longer carries ops/set_workspace.
      expect(
        (await callAsRow(base, token, { tool: "set_workspace", conversationId: "ws1", senderId: "editor-1", patch: { digestsEnabled: true } })).ok,
      ).toBe(true);
      expect(
        (await callAsRow(base, token, { tool: "set_workspace", conversationId: "ws1", senderId: "editor-1", patch: { expert: "project" } })).ok,
      ).toBe(false);
      expect(
        (await callAsRow(base, token, { tool: "set_workspace", conversationId: "ws1", senderId: "admin-1", patch: { expert: "project" } })).ok,
      ).toBe(true);
      expect((map.get("ws1") as WorkspaceMeta).expert).toBe("project");
    } finally {
      await api.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Expert profile gate — WHICH tools exist here, asked before WHO may call them
// ---------------------------------------------------------------------------

describe("expert profile gate", () => {
  test("a debug workspace refuses kb_save and worktool, and the attempt is audited", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "debug", editors: ["editor-1"] });
    const { api, kb, executed } = makeApi({ metas: [ws1] });

    const save = await api.handleToolRequest({ tool: "kb_save", conversationId: "ws1", senderId: "editor-1", question: "q", answer: "a" });
    expect(save.ok).toBe(false);
    expect(save.message).toContain("not available");
    expect(save.message).toContain("debug");
    expect(kb).toEqual([]);

    const work = await api.handleToolRequest({
      tool: "worktool",
      conversationId: "ws1",
      senderId: "editor-1",
      action: "doc_read",
      params: { url: "https://example.com/doc" },
    });
    expect(work.ok).toBe(false);
    expect(work.message).toContain("not available");
    expect(executed).toEqual([]);

    const lines = await readAudit();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ actor: "editor-1", action: "kb_save", conversationId: "ws1" });
    expect((lines[0] as { details: { ok: boolean } }).details.ok).toBe(false);
    expect(lines[1]).toMatchObject({ actor: "editor-1", action: "worktool:doc_read" });
    expect((lines[1] as { details: { ok: boolean } }).details.ok).toBe(false);
  });

  test("an admin is gated too — capability is a property of the workspace, not the caller", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "debug" });
    const { api } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({ tool: "kb_save", conversationId: "ws1", senderId: "admin-1", question: "q", answer: "a" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not available");
  });

  test("a qa-cs workspace keeps kb_save", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "qa-cs", editors: ["editor-1"] });
    const { api, kb } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({ tool: "kb_save", conversationId: "ws1", senderId: "editor-1", question: "q", answer: "a" });
    expect(res.ok).toBe(true);
    expect(kb.length).toBe(1);
  });

  test("in-profile but unauthorized still returns the permission error, not the profile one", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "qa-cs", editors: ["editor-1"] });
    const { api } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({ tool: "kb_save", conversationId: "ws1", senderId: "random", question: "q", answer: "a" });
    expect(res).toEqual({ ok: false, message: "not authorized" });
  });

  test("an unknown workspace is not gated — the permission tier still decides", async () => {
    const { api, kb } = makeApi({ metas: [] });
    const res = await api.handleToolRequest({ tool: "kb_save", conversationId: "ghost", senderId: "admin-1", question: "q", answer: "a" });
    expect(res.ok).toBe(true);
    expect(kb.length).toBe(1);
    const denied = await api.handleToolRequest({ tool: "kb_save", conversationId: "ghost", senderId: "random", question: "q", answer: "a" });
    expect(denied).toEqual({ ok: false, message: "not authorized" });
  });

  test("an approved payload still executes after the workspace expert loses the tool (internal is not gated)", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "project" });
    const { api, map, executed } = makeApi({ metas: [ws1], affectsOthers: true });
    const asked = await api.handleToolRequest({
      tool: "worktool",
      conversationId: "ws1",
      senderId: "requester-1",
      action: "todo_create",
      params: { title: "t", executorIds: ["colleague-1"] },
    });
    expect(asked.ok).toBe(true); // awaiting approval
    expect(executed.length).toBe(0);

    // The workspace is re-pointed at an expert without worktool while the
    // approval is still open. The human already approved the deed, so the
    // orchestrator must still carry it out.
    map.set("ws1", makeMeta({ conversationId: "ws1", expert: "debug" }));

    const [pendingFile] = await readdir(paths.pending);
    const pending = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8")) as PendingQuestion;
    const consumed = await api.tryResolvePending({
      kind: "reaction",
      eventId: "ev-1",
      messageId: pending.postedMessageId!,
      conversationId: "ws1",
      operatorId: "requester-1",
      emoji: "thumbsup",
      operation: "add",
      receivedAt: Date.now(),
    });
    expect(consumed).toBe(true);
    expect(executed.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ask_user / pending question creation
// ---------------------------------------------------------------------------

describe("ask_user", () => {
  const ws1 = makeMeta({ conversationId: "ws1" });

  test("rejects out-of-range option counts", async () => {
    const { api } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "?",
      options: ["only-one"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    expect(res.ok).toBe(false);
  });

  test("posts numbered options and captures postedMessageId, then enforces the per-conversation cap", async () => {
    const { api, sent } = makeApi({ metas: [ws1], cfgOverrides: { caps: { pendingQuestionsPerConversation: 2, pendingQuestionTtlHours: 24 } } });
    const ask = (q: string) =>
      api.handleToolRequest({
        tool: "ask_user",
        conversationId: "ws1",
        senderId: "u1",
        question: q,
        options: ["yes", "no"],
        defaultOption: -1,
        purpose: "question",
        approverScope: "requester",
      });
    const r1 = await ask("one?");
    expect(r1.ok).toBe(true);
    expect(sent[0]?.text).toBe("one?\n1. yes\n2. no");
    const r2 = await ask("two?");
    expect(r2.ok).toBe(true);
    const r3 = await ask("three?");
    expect(r3.ok).toBe(false); // cap of 2 hit
  });
});

// ---------------------------------------------------------------------------
// tryResolvePending — reactions
// ---------------------------------------------------------------------------

describe("tryResolvePending reactions", () => {
  function reaction(over: Partial<InboundEvent> & { conversationId: string; operatorId: string; messageId: string }): InboundEvent {
    return {
      kind: "reaction",
      eventId: `ev-${Math.random()}`,
      operation: "add",
      emoji: "thumbsup",
      receivedAt: Date.now(),
      ...over,
    } as InboundEvent;
  }

  test("authorized thumbs-up answers a requester-scoped approval and executes onApprove exactly once (internal bypass)", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, executed } = makeApi({ metas: [ws1], affectsOthers: true });
    const ask = await api.handleToolRequest({
      tool: "worktool",
      conversationId: "ws1",
      senderId: "requester-1",
      action: "todo_create",
      params: { title: "t", executorIds: ["colleague-1"] },
    });
    expect(ask.ok).toBe(true); // awaiting approval, not executed yet
    expect(executed.length).toBe(0);

    const [pendingFile] = await readdir(paths.pending);
    const pending = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));

    const consumed = await api.tryResolvePending(
      reaction({ conversationId: "ws1", operatorId: "requester-1", messageId: pending.postedMessageId, emoji: "thumbsup" }),
    );
    expect(consumed).toBe(true);
    expect(executed.length).toBe(1); // executed exactly once — the approval, not a re-gated request
  });

  test("unauthorized operator is ignored (returns false, pending stays open)", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, executed } = makeApi({ metas: [ws1], affectsOthers: true });
    await api.handleToolRequest({
      tool: "worktool",
      conversationId: "ws1",
      senderId: "requester-1",
      action: "todo_create",
      params: { title: "t", executorIds: ["colleague-1"] },
    });
    const [pendingFile] = await readdir(paths.pending);
    const before = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));
    expect(before.status).toBe("open");

    const consumed = await api.tryResolvePending(
      reaction({ conversationId: "ws1", operatorId: "bystander", messageId: before.postedMessageId, emoji: "thumbsup" }),
    );
    expect(consumed).toBe(false);
    expect(executed.length).toBe(0);
    const after = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));
    expect(after.status).toBe("open");
  });

  test("a 'remove' reaction operation is ignored", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api } = makeApi({ metas: [ws1], cfgOverrides: { caps: { pendingQuestionTtlHours: 24, pendingQuestionsPerConversation: 3 } } });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "?",
      options: ["a", "b"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    const [pendingFile] = await readdir(paths.pending);
    const pending = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));
    const consumed = await api.tryResolvePending(
      reaction({ conversationId: "ws1", operatorId: "u1", messageId: pending.postedMessageId, emoji: "thumbsup", operation: "remove" }),
    );
    expect(consumed).toBe(false);
  });

  test("numeric keycap reaction answers a question and resumes via enqueueRun", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "pick",
      options: ["red", "green", "blue"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    const [pendingFile] = await readdir(paths.pending);
    const pending = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));
    const consumed = await api.tryResolvePending(
      reaction({ conversationId: "ws1", operatorId: "u1", messageId: pending.postedMessageId, emoji: "3" }),
    );
    expect(consumed).toBe(true);
    expect(enqueue.calls.length).toBe(1);
    expect(enqueue.calls[0]?.prompt).toContain("blue");
    // The answerer is named in the prompt text, never handed to the run as an
    // identity — see the "answer never confers authority" tests below.
    expect(enqueue.calls[0]?.prompt).toContain("u1 answered");
    expect(enqueue.calls[0]?.opts?.senderId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tryResolvePending — messages
// ---------------------------------------------------------------------------

describe("tryResolvePending messages", () => {
  function message(over: Partial<InboundEvent> & { conversationId: string; senderId: string; content: string }): InboundEvent {
    return {
      kind: "message",
      eventId: `ev-${Math.random()}`,
      messageId: `m-${Math.random()}`,
      conversationType: "group",
      mention: false,
      receivedAt: Date.now(),
      ...over,
    } as InboundEvent;
  }

  test("exact option number answers the question", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "pick",
      options: ["red", "green"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "u1", content: "2" }));
    expect(consumed).toBe(true);
    expect(enqueue.calls[0]?.prompt).toContain("green");
  });

  test("fuzzy text match answers the question", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "pick",
      options: ["Approve", "Decline"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "u1", content: "approve" }));
    expect(consumed).toBe(true);
    expect(enqueue.calls[0]?.prompt).toContain("Approve");
  });

  test("free text answers a question purpose pending when nothing matches an option", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "when is the deadline?",
      options: ["This week", "Next week", "Other"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "u1", content: "August 30th" }));
    expect(consumed).toBe(true);
    expect(enqueue.calls[0]?.prompt).toContain("August 30th");
  });

  test("a short unrelated reply ('ok') does not fuzzy-match an unrelated option as a mid-string substring", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "what should I book?",
      options: ["Book flights", "Book a hotel", "Neither"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    // normalize("Book flights") === "bookflights", which *contains* "ok" —
    // must not match; "ok" should fall through to the free-text answer.
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "u1", content: "ok" }));
    expect(consumed).toBe(true);
    expect(enqueue.calls[0]?.prompt).toContain('answered: "ok"');
  });

  test("a negated reply ('don't approve') does not fuzzy-match Approve on an approval", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, executed } = makeApi({ metas: [ws1], affectsOthers: true });
    await api.handleToolRequest({
      tool: "worktool",
      conversationId: "ws1",
      senderId: "requester-1",
      action: "todo_create",
      params: { title: "t", executorIds: ["colleague-1"] },
    });
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "requester-1", content: "don't approve this" }));
    expect(consumed).toBe(false);
    expect(executed.length).toBe(0);
  });

  test("a pending this sender may not answer does not abort the scan — a later one they may answer still resolves", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    const ask = (senderId: string, question: string) =>
      api.handleToolRequest({
        tool: "ask_user",
        conversationId: "ws1",
        senderId,
        question,
        options: ["yes", "no"],
        defaultOption: -1,
        purpose: "question",
        approverScope: "requester",
      });
    await ask("alice", "alice asks?");
    // Distinct createdAt values: on a same-millisecond tie the scan order
    // falls back to readdir order (random uuid file names), so alice's
    // pending would not reliably be visited first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ask("bob", "bob asks?");

    // "yes" matches an option of both pendings, but only bob's is bob's to answer.
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "bob", content: "yes" }));
    expect(consumed).toBe(true);
    expect(enqueue.calls.length).toBe(1);
    expect(enqueue.calls[0]?.prompt).toContain("bob asks?");

    const pendings = await readPendings();
    expect(pendings.find((p) => p.requesterId === "bob")?.status).toBe("answered");
    expect(pendings.find((p) => p.requesterId === "alice")?.status).toBe("open");
  });

  test("approving an ask_user approval (no onApprove) resumes the agent instead of declining it", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, sent, enqueue } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "requester-1",
      question: "May I reassign the ticket to a colleague?",
      options: ["Approve", "Decline"],
      defaultOption: -1,
      purpose: "approval",
      approverScope: "requester",
    });
    expect(res.ok).toBe(true);
    const [pending] = await readPendings();
    expect(pending?.purpose).toBe("approval"); // req.purpose is no longer dropped

    sent.length = 0; // clear the initial "posted options" send
    // Approvals are answered ONLY by the message-bound reaction (a tap on the
    // exact options message), never by a loose text reply — that binding is
    // what stops an older approval being farmed by a reply meant for a newer
    // question. A thumbs-up = option 0 = Approve.
    const consumed = await api.tryResolvePending({
      kind: "reaction",
      eventId: "ev-approve",
      operation: "add",
      emoji: "thumbsup",
      receivedAt: Date.now(),
      conversationId: "ws1",
      operatorId: "requester-1",
      messageId: pending!.postedMessageId!,
    } as InboundEvent);
    expect(consumed).toBe(true);
    expect(sent).toEqual([]); // no "Declined.", and nothing was executed to announce
    expect(enqueue.calls.length).toBe(1);
    expect(enqueue.calls[0]?.prompt).toContain("Approve");

    const answered = (await readAudit()).find((l) => l.action === "pending_answered");
    expect((answered as { details: { purpose: string } } | undefined)?.details.purpose).toBe("approval");
  });

  test("a text reply can NOT resolve an approval — only the bound reaction can", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "requester-1",
      question: "May I?",
      options: ["Approve", "Decline"],
      defaultOption: -1,
      purpose: "approval",
      approverScope: "requester",
    });
    // Even the requester, even an exact "Approve", must not resolve it by text.
    const consumed = await api.tryResolvePending(message({ conversationId: "ws1", senderId: "requester-1", content: "Approve" }));
    expect(consumed).toBe(false);
    expect(enqueue.calls.length).toBe(0);
    const [pending] = await readPendings();
    expect(pending?.status).toBe("open");
  });

  test("declining an internal approval (onApprove set) still replies 'Declined.' and neither executes nor resumes", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, sent, executed, enqueue } = makeApi({ metas: [ws1], affectsOthers: true });
    await api.handleToolRequest({
      tool: "worktool",
      conversationId: "ws1",
      senderId: "requester-1",
      action: "todo_create",
      params: { title: "t", executorIds: ["colleague-1"] },
    });
    const [pending] = await readPendings();
    sent.length = 0;
    // Decline via the bound reaction: thumbs-down = option 1 = Decline on a
    // two-option approval.
    const consumed = await api.tryResolvePending({
      kind: "reaction",
      eventId: "ev-decline",
      operation: "add",
      emoji: "thumbsdown",
      receivedAt: Date.now(),
      conversationId: "ws1",
      operatorId: "requester-1",
      messageId: pending!.postedMessageId!,
    } as InboundEvent);
    expect(consumed).toBe(true);
    expect(executed.length).toBe(0);
    expect(enqueue.calls.length).toBe(0);
    expect(sent.map((s) => s.text)).toEqual(["Declined."]);
  });
});

// ---------------------------------------------------------------------------
// schedule_job approval redirect for non-editors
// ---------------------------------------------------------------------------

describe("set_workspace on a general room (deadlock regression)", () => {
  test("an admin can reconfigure a freshly-created general room — set_workspace is not gated by its own expert", async () => {
    // Every room is created `general`, and set_workspace is the only way to
    // change that. If the expert-capability gate applied to set_workspace, no
    // general room could EVER be reconfigured (the tool is absent from its
    // profile) — a deadlock. set_workspace lives in BASE_TOOLS precisely so
    // authority (admin tier), not the room's expert, governs it.
    const ws1 = makeMeta({ conversationId: "ws1", expert: "general" });
    const { api } = makeApi({ metas: [ws1] });

    const res = await api.handleToolRequest({
      tool: "set_workspace",
      conversationId: "ws1",
      senderId: "admin-1",
      patch: { expert: "qa-cs" },
    });
    expect(res.ok).toBe(true);
    expect(res.message).not.toContain("not available"); // not the capability-gate refusal
  });

  test("a non-admin is still refused the admin-only expert field — authority still governs", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "general", editors: ["editor-1"] });
    const { api } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({
      tool: "set_workspace",
      conversationId: "ws1",
      senderId: "editor-1",
      patch: { expert: "qa-cs" },
    });
    expect(res.ok).toBe(false);
  });
});

describe("set_workspace digests", () => {
  test("flipping digestsEnabled materializes and removes the digest jobs", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "dev-mgmt", editors: ["editor-1"] });
    const { api, jobs } = makeApi({ metas: [ws1] });

    const on = await api.handleToolRequest({
      tool: "set_workspace",
      conversationId: "ws1",
      senderId: "editor-1",
      patch: { digestsEnabled: true },
    });
    expect(on.ok).toBe(true);
    expect(jobs.filter((j) => j.createdBy === "system").length).toBeGreaterThan(0);

    const off = await api.handleToolRequest({
      tool: "set_workspace",
      conversationId: "ws1",
      senderId: "editor-1",
      patch: { digestsEnabled: false },
    });
    expect(off.ok).toBe(true);
    expect(jobs.filter((j) => j.createdBy === "system")).toEqual([]);
  });

  test("a patch without digestsEnabled does not touch cron jobs", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "dev-mgmt", editors: ["editor-1"] });
    const { api, jobs } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({
      tool: "set_workspace",
      conversationId: "ws1",
      senderId: "editor-1",
      patch: { owner: "editor-1" },
    });
    expect(res.ok).toBe(true);
    expect(jobs).toEqual([]);
  });
});

describe("schedule_job editor approval redirect", () => {
  test("non-editor request becomes an editors-scoped approval; an editor's approve reaction schedules the job", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "project", editors: ["editor-1"] });
    const { api, jobs } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({
      tool: "schedule_job",
      conversationId: "ws1",
      senderId: "random-user",
      cronExpr: "0 9 * * *",
      description: "daily digest",
      prompt: "post the digest",
    });
    expect(res.ok).toBe(true); // awaiting approval
    expect(jobs.length).toBe(0);

    const [pendingFile] = await readdir(paths.pending);
    const pending = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));
    expect(pending.approverScope).toBe("editors");

    const consumed = await api.tryResolvePending({
      kind: "reaction",
      eventId: "ev-1",
      messageId: pending.postedMessageId,
      conversationId: "ws1",
      operatorId: "editor-1",
      emoji: "thumbsup",
      operation: "add",
      receivedAt: Date.now(),
    });
    expect(consumed).toBe(true);
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.createdBy).toBe("random-user");
  });

  test("editor can schedule directly, no approval needed", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "project", editors: ["editor-1"] });
    const { api, jobs } = makeApi({ metas: [ws1] });
    const res = await api.handleToolRequest({
      tool: "schedule_job",
      conversationId: "ws1",
      senderId: "editor-1",
      cronExpr: "0 9 * * *",
      description: "daily digest",
      prompt: "post the digest",
    });
    expect(res.ok).toBe(true);
    expect(jobs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sweepExpired
// ---------------------------------------------------------------------------

describe("sweepExpired", () => {
  test("defaultOption -1 drops and notifies, without executing or resuming", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, sent, enqueue } = makeApi({ metas: [ws1], cfgOverrides: { caps: { pendingQuestionTtlHours: 0, pendingQuestionsPerConversation: 3 } } });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "pick",
      options: ["a", "b"],
      defaultOption: -1,
      purpose: "question",
      approverScope: "requester",
    });
    sent.length = 0; // clear the initial "posted options" send
    await api.sweepExpired();
    expect(enqueue.calls.length).toBe(0);
    expect(sent.some((s) => s.text.includes("dropped"))).toBe(true);
    const [pendingFile] = await readdir(paths.pending);
    const pending = JSON.parse(await readFile(join(paths.pending, pendingFile!), "utf8"));
    expect(pending.status).toBe("expired");
  });

  test("a real defaultOption is applied on expiry (answeredBy 'system')", async () => {
    const ws1 = makeMeta({ conversationId: "ws1" });
    const { api, enqueue } = makeApi({ metas: [ws1], cfgOverrides: { caps: { pendingQuestionTtlHours: 0, pendingQuestionsPerConversation: 3 } } });
    await api.handleToolRequest({
      tool: "ask_user",
      conversationId: "ws1",
      senderId: "u1",
      question: "pick",
      options: ["red", "green"],
      defaultOption: 0,
      purpose: "question",
      approverScope: "requester",
    });
    await api.sweepExpired();
    expect(enqueue.calls.length).toBe(1);
    expect(enqueue.calls[0]?.prompt).toContain("red");
    expect(enqueue.calls[0]?.prompt).toContain("system answered"); // no human answered — the default was auto-applied
    expect(enqueue.calls[0]?.opts?.senderId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ops console (admin-only)
// ---------------------------------------------------------------------------

describe("ops", () => {
  test("status reports pendings/tasks/cron; retry_task and pause_workspace mutate state", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "dev-mgmt" });
    const { api, tasks, created, retried, patches, map } = makeApi({ metas: [ws1] });
    await tasks.create("ws1", "u1", "do the thing");
    const failingId = created[0]!.id;

    const status = await api.handleToolRequest({ tool: "ops", conversationId: "ws1", senderId: "admin-1", op: "status" });
    expect(status.ok).toBe(true);
    expect((status.data as { cronCount: number }).cronCount).toBe(0);

    const retry = await api.handleToolRequest({ tool: "ops", conversationId: "ws1", senderId: "admin-1", op: "retry_task", target: failingId });
    expect(retry.ok).toBe(true);
    expect(retried).toContain(failingId);

    const pause = await api.handleToolRequest({ tool: "ops", conversationId: "ws1", senderId: "admin-1", op: "pause_workspace", target: "ws1" });
    expect(pause.ok).toBe(true);
    expect(patches.some((p) => p.cid === "ws1" && p.patch.paused === true)).toBe(true);
    expect((map.get("ws1") as unknown as { paused?: boolean }).paused).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

describe("audit log", () => {
  test("every handleToolRequest call appends one JSONL entry with actor/action/cid/ok", async () => {
    const ws1 = makeMeta({ conversationId: "ws1", expert: "qa-cs" });
    const { api } = makeApi({ metas: [ws1] });
    await api.handleToolRequest({ tool: "send_message", conversationId: "ws1", senderId: "u1", text: "hi" });
    await api.handleToolRequest({ tool: "kb_save", conversationId: "ws1", senderId: "random", question: "q", answer: "a" });
    const lines = await readAudit();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ actor: "u1", action: "send_message", conversationId: "ws1" });
    expect((lines[0] as { details: { ok: boolean } }).details.ok).toBe(true);
    expect((lines[1] as { details: { ok: boolean } }).details.ok).toBe(false); // random denied kb_save
  });
});
