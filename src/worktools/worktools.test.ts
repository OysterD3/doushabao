import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  type Config,
  type ConversationType,
  type DwsPort,
  type WorkspaceMeta,
} from "../shared/types.ts";
import { wsPaths } from "../shared/paths.ts";
import { createWorktools, type WorkspacesLike } from "./worktools.ts";

const FAKE_DWS_BIN = new URL("../../test/fakes/fake-dws.ts", import.meta.url).pathname;

function makeCfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ dwsBin: FAKE_DWS_BIN, ...overrides });
}

function makeMeta(dir: string, conversationId = "conv1", conversationType: ConversationType = "group"): WorkspaceMeta {
  return {
    conversationId,
    conversationType,
    dir,
    boilerplate: "general",
    editors: [],
    multimodal: false,
    digestsEnabled: false,
    createdAt: Date.now(),
    greeted: true,
  };
}

function makeWorkspaces(meta: WorkspaceMeta, transcript: string): WorkspacesLike {
  const lines = transcript ? [transcript] : [];
  return {
    async get(cid) {
      return cid === meta.conversationId ? meta : undefined;
    },
    async transcriptTail(cid) {
      return cid === meta.conversationId ? lines : [];
    },
  };
}

/** Runs the fake-dws binary to completion, discarding its output. */
function runFake(argv: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(FAKE_DWS_BIN, argv, { stdio: "ignore", env: process.env });
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

/** Real DwsPort stub that shells out to the fake-dws binary using the argv
 * shapes documented in ARCHITECTURE.md's dws invocation contract — lets
 * tests assert on the shared outbox alongside worktools' own runDws calls. */
function fakeBackedDws(): DwsPort {
  return {
    async startConsuming() {},
    async stopConsuming() {},
    async sendText() {
      return {};
    },
    async downloadMedia(conversationId, conversationType, _messageId, destDir) {
      const selector = conversationType === "group" ? "--group" : "--open-dingtalk-id";
      await runFake(["chat", "+chat-messages", selector, conversationId, "--download-resources", "--output-dir", destDir]);
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(destDir);
      return names.map((n) => join(destDir, n));
    },
    async exportDoc(docUrl, destFile) {
      await runFake(["doc", "+export", "--node", docUrl, "--export-format", "markdown", "--output", destFile]);
    },
    async doctor() {
      return { ok: true, detail: "fake" };
    },
  };
}

/** Direct DwsPort stub for media_fetch edge cases that need control over
 * exactly which bytes land in the quarantine dir (oversize / disallowed ext). */
function directDws(seed: (destDir: string) => Promise<string[]>): DwsPort {
  return {
    async startConsuming() {},
    async stopConsuming() {},
    async sendText() {
      return {};
    },
    async downloadMedia(_conversationId, _conversationType, _messageId, destDir) {
      return seed(destDir);
    },
    async exportDoc() {},
    async doctor() {
      return { ok: true, detail: "fake" };
    },
  };
}

async function readOutbox(outboxPath: string): Promise<string[][]> {
  if (!existsSync(outboxPath)) return [];
  const lines = (await readFile(outboxPath, "utf8")).split("\n").filter(Boolean);
  return lines.map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}

let tmpRoot: string;
let wsDir: string;
let outboxPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "worktools-test-"));
  wsDir = join(tmpRoot, "ws1");
  await mkdir(wsDir, { recursive: true });
  outboxPath = join(tmpRoot, "outbox.jsonl");
  process.env.FAKE_DWS_OUTBOX = outboxPath;
});

afterEach(() => {
  delete process.env.FAKE_DWS_OUTBOX;
  delete process.env.DOUSHABAO_VOICE_SPIKE;
});

describe("todo_create", () => {
  test("maps to fixed dws argv, including optional due-time and executors", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Ship the report", dueIso: "2026-08-20T10:00:00+08:00", executorIds: ["u2", "u3"] },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual([
      "todo",
      "task",
      "create",
      "--subject",
      "Ship the report",
      "--due-time",
      "2026-08-20T10:00:00+08:00",
      "--executors",
      "u2,u3",
    ]);
  });

  test("omits optional flags when absent", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Water the plants" },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual(["todo", "task", "create", "--subject", "Water the plants"]);
  });

  test("rejects invalid params without spawning dws", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "" },
    });
    expect(res.ok).toBe(false);
    expect(await readOutbox(outboxPath)).toEqual([]);
  });
});

describe("calendar_create", () => {
  test("maps to fixed dws argv, including optional attendees", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "calendar_create",
      params: {
        summary: "Sprint planning",
        startIso: "2026-08-20T10:00:00+08:00",
        endIso: "2026-08-20T11:00:00+08:00",
        attendeeIds: ["u2"],
      },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual([
      "calendar",
      "event",
      "create",
      "--summary",
      "Sprint planning",
      "--start-time",
      "2026-08-20T10:00:00+08:00",
      "--end-time",
      "2026-08-20T11:00:00+08:00",
      "--attendees",
      "u2",
    ]);
  });
});

describe("report_create", () => {
  test("maps to fixed dws argv (best-effort)", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "report_create",
      params: { content: "Weekly status", templateName: "weekly" },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual(["report", "create", "--content", "Weekly status", "--template", "weekly"]);
  });
});

describe("doc_read", () => {
  test("refuses urls not shared in this conversation", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "no links here") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url: "https://docs.example/secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("doc links must be shared in this conversation first");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("exports and returns doc content when the url was shared in-conversation", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "https://docs.example/plan";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `check this out: ${url}`) });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(res.ok).toBe(true);
    expect(res.data as string).toContain("fake doc");

    const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
    const destFile = join(wsPaths(wsDir).media, `doc-${hash}.md`);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual(["doc", "+export", "--node", url, "--export-format", "markdown", "--output", destFile]);
  });
});

describe("media_fetch", () => {
  test("downloads, extracts text, and marks it untrusted", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "media_fetch",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { files: string[]; excerpts: { file: string; text: string }[] };
    expect(data.files).toHaveLength(1);
    expect(data.files[0]!).toMatch(/fake-attachment\.txt$/);
    expect(data.excerpts).toHaveLength(1);
    expect(data.excerpts[0]!.text).toMatch(/^\[UNTRUSTED CONTENT/);
    expect(data.excerpts[0]!.text).toContain("fake attachment content");

    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual([
      "chat",
      "+chat-messages",
      "--group",
      "conv1",
      "--download-resources",
      "--output-dir",
      wsPaths(wsDir).media,
    ]);
  });

  test("passes the workspace's conversationType, so a DM downloads with the DM selector", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "dm");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "media_fetch",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual([
      "chat",
      "+chat-messages",
      "--open-dingtalk-id",
      "conv1",
      "--download-resources",
      "--output-dir",
      wsPaths(wsDir).media,
    ]);
  });

  test("deletes and refuses oversize files", async () => {
    const cfg = makeCfg({ caps: { mediaMaxBytes: 5 } });
    const meta = makeMeta(wsDir);
    const dws = directDws(async (destDir) => {
      const file = join(destDir, "big.txt");
      await writeFile(file, "way more than five bytes");
      return [file];
    });
    const wt = createWorktools({ cfg, dws, workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "media_fetch",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { files: string[]; excerpts: unknown[] };
    expect(data.files).toEqual([]);
    expect(data.excerpts).toEqual([]);
    expect(res.message).toContain("Refused");
    expect(existsSync(join(wsPaths(wsDir).media, "big.txt"))).toBe(false);
  });

  test("deletes and refuses disallowed file extensions", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const dws = directDws(async (destDir) => {
      const file = join(destDir, "payload.exe");
      await writeFile(file, "binary-ish");
      return [file];
    });
    const wt = createWorktools({ cfg, dws, workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "media_fetch",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { files: string[] };
    expect(data.files).toEqual([]);
    expect(res.message).toContain("not allowed");
    expect(existsSync(join(wsPaths(wsDir).media, "payload.exe"))).toBe(false);
  });
});

describe("voice_transcribe", () => {
  test("returns a polite fallback when the spike flag is unset, with no dws activity", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "voice_transcribe",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Voice messages aren't transcribed yet — could you send that as text instead?");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("attempts the minutes bridge under the spike flag but still returns the polite fallback", async () => {
    process.env.DOUSHABAO_VOICE_SPIKE = "1";
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "voice_transcribe",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Voice messages aren't transcribed yet — could you send that as text instead?");
    const outbox = await readOutbox(outboxPath);
    expect(outbox.some((argv) => argv[0] === "chat")).toBe(true);
    expect(outbox.some((argv) => argv[0] === "minutes" && argv[1] === "upload")).toBe(true);
  });

  test("the spike's download passes the workspace's conversationType too", async () => {
    process.env.DOUSHABAO_VOICE_SPIKE = "1";
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "dm");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "voice_transcribe",
      params: { messageId: "m1" },
    });
    expect(res.ok).toBe(false);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.find((argv) => argv[0] === "chat")).toEqual([
      "chat",
      "+chat-messages",
      "--open-dingtalk-id",
      "conv1",
      "--download-resources",
      "--output-dir",
      wsPaths(wsDir).media,
    ]);
  });
});

describe("affectsOthers", () => {
  const cfg = makeCfg();
  const meta = makeMeta("/unused");
  const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });

  test.each([
    ["todo_create", {}, false],
    ["todo_create", { executorIds: [] }, false],
    ["todo_create", { executorIds: ["u2"] }, true],
    ["calendar_create", {}, false],
    ["calendar_create", { attendeeIds: [] }, false],
    ["calendar_create", { attendeeIds: ["u2"] }, true],
    ["report_create", {}, true],
    ["doc_read", { url: "x" }, false],
    ["media_fetch", { messageId: "m1" }, false],
    ["voice_transcribe", { messageId: "m1" }, false],
  ] as const)("%s %j -> %s", (action, params, expected) => {
    expect(wt.affectsOthers(action, params as Record<string, unknown>)).toBe(expected);
  });
});

describe("writes/hour cap", () => {
  test("blocks mutating actions once the per-workspace budget is exhausted", async () => {
    const cfg = makeCfg({ budgets: { writesPerWorkspacePerHour: 2 } });
    const meta = makeMeta(wsDir);
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const call = () =>
      wt.execute({
        tool: "worktool",
        conversationId: "conv1",
        senderId: "u1",
        action: "todo_create",
        params: { title: "Task" },
      });
    const first = await call();
    const second = await call();
    const third = await call();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    expect(third.message).toContain("budget");
    const outbox = await readOutbox(outboxPath);
    expect(outbox.filter((argv) => argv[0] === "todo")).toHaveLength(2);
  });

  test("tracks budgets per conversation independently", async () => {
    const cfg = makeCfg({ budgets: { writesPerWorkspacePerHour: 1 } });
    const meta1 = makeMeta(wsDir, "conv1");
    const wsDir2 = join(tmpRoot, "ws2");
    await mkdir(wsDir2, { recursive: true });
    const meta2 = makeMeta(wsDir2, "conv2");
    const workspaces: WorkspacesLike = {
      async get(cid) {
        if (cid === "conv1") return meta1;
        if (cid === "conv2") return meta2;
        return undefined;
      },
      async transcriptTail() {
        return [];
      },
    };
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces });
    const res1 = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Task" },
    });
    const res2 = await wt.execute({
      tool: "worktool",
      conversationId: "conv2",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Task" },
    });
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
  });
});
