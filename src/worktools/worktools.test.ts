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
  type Expert,
  type WorkspaceMeta,
} from "../shared/types.ts";
import { wsPaths } from "../shared/paths.ts";
import { createWorktools, type WorkspacesLike } from "./worktools.ts";

const FAKE_DWS_BIN = new URL("../../test/fakes/fake-dws.ts", import.meta.url).pathname;

function makeCfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ dwsBin: FAKE_DWS_BIN, ...overrides });
}

function makeMeta(
  dir: string,
  conversationId = "conv1",
  conversationType: ConversationType = "group",
  expert: Expert = "general",
): WorkspaceMeta {
  return {
    conversationId,
    conversationType,
    dir,
    expert,
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
    const meta = makeMeta(wsDir, "conv1", "group", "project");
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
    const meta = makeMeta(wsDir, "conv1", "group", "project");
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
    const meta = makeMeta(wsDir, "conv1", "group", "project");
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
    const meta = makeMeta(wsDir, "conv1", "group", "project");
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
    const meta = makeMeta(wsDir, "conv1", "group", "project");
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

describe("option injection", () => {
  const ISO_A = "2026-08-20T10:00:00+08:00";
  const ISO_B = "2026-08-20T11:00:00+08:00";

  // `--output=/tmp/x` is ONE argv token, so a single model-chosen value that
  // starts with "-" sets a dws flag. STRUCTURED fields (ids, template) never
  // legitimately start with "-", so they are refused before any process
  // starts: the outbox is the proof, not the ok:false. Prose fields (title /
  // summary / content) are handled by the adaptation test below instead.
  test.each([
    ["todo_create", { title: "Ship it", executorIds: ["u2", "--output=/tmp/pwned"] }, "executorIds"],
    [
      "calendar_create",
      { summary: "Sprint planning", startIso: ISO_A, endIso: ISO_B, attendeeIds: ["--output=/tmp/pwned"] },
      "attendeeIds",
    ],
    ["report_create", { content: "Weekly status", templateName: "--output=/tmp/pwned" }, "templateName"],
  ] as const)("%s refuses an option-like value in a structured field (%#)", async (action, params, field) => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "group", "project");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action,
      params: params as Record<string, unknown>,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain(field);
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  // Prose fields adapt rather than refuse: an option-like title still runs,
  // but is neutralised (leading space) so dws reads it as the --subject VALUE,
  // never as a separate --output token. The security property — no injected
  // flag — holds without failing a benign markdown bullet.
  test("todo_create adapts an option-like prose title instead of injecting a flag", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "group", "project");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "--output=/tmp/pwned" },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    const argv = outbox.at(-1)!;
    expect(argv).not.toContain("--output=/tmp/pwned"); // never a standalone token
    const subject = argv[argv.indexOf("--subject") + 1];
    expect(subject).toBe(" --output=/tmp/pwned"); // the value, space-neutralised
  });

  test.each([
    ["todo_create", { title: "Ship it", dueIso: "tomorrow" }],
    ["todo_create", { title: "Ship it", dueIso: "--due-time=x" }],
    ["calendar_create", { summary: "Sprint planning", startIso: "whenever", endIso: ISO_B }],
    ["calendar_create", { summary: "Sprint planning", startIso: ISO_A, endIso: "--end-time=x" }],
  ] as const)("%s refuses a timestamp that is not a timestamp (%#)", async (action, params) => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "group", "project");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action,
      params: params as Record<string, unknown>,
    });
    expect(res.ok).toBe(false);
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("a refusal costs no write budget, and a legitimate todo still works after one", async () => {
    const cfg = makeCfg({ budgets: { writesPerWorkspacePerHour: 1 } });
    const meta = makeMeta(wsDir, "conv1", "group", "project");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const refused = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      // A structured field (executorIds) still refuses — that is the no-write path.
      params: { title: "Ship it", executorIds: ["--output=/tmp/pwned"] },
    });
    expect(refused.ok).toBe(false);
    expect(await readOutbox(outboxPath)).toEqual([]);

    const ok = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Ship the report", dueIso: ISO_A, executorIds: ["u2", "u3"] },
    });
    expect(ok.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual([
      "todo",
      "task",
      "create",
      "--subject",
      "Ship the report",
      "--due-time",
      ISO_A,
      "--executors",
      "u2,u3",
    ]);
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
      params: { url: "https://alidocs.dingtalk.com/secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("doc links must be shared in this conversation first");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  // The transcript gate cannot help against these: the attacker types the
  // message, so the attacker also chooses the string it "was shared" as. Each
  // url below IS seeded into the transcript, so only the destination check can
  // refuse it — and the outbox must show no dws process was ever spawned.
  test("refuses an off-allowlist host even when the url is in the transcript", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "https://evil.tld/exfil?q=secrets";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `read this: ${url}`) });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("evil.tld");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("refuses a non-https url on an allowed host, even when in the transcript", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "http://alidocs.dingtalk.com/plan";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `read this: ${url}`) });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("https");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("refuses a host that only embeds an allowed one (userinfo trick)", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "https://alidocs.dingtalk.com@evil.tld/exfil";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `read this: ${url}`) });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("evil.tld");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("refuses a url that is not a url at all", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "--output=/tmp/pwned";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `read this: ${url}`) });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(res.ok).toBe(false);
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("exports and returns doc content when the url was shared in-conversation", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "https://alidocs.dingtalk.com/plan";
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

  // A downloaded filename is chosen by whoever uploaded the file. If it can
  // name a path outside the media dir, the allowed-extension branch reads a
  // host file into chat and the refusal branch DELETES a host file.
  test("refuses paths outside the media dir, reading nothing and deleting nothing", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const outsideTxt = join(tmpRoot, "outside.txt");
    const outsideExe = join(tmpRoot, "outside.exe");
    const dws = directDws(async () => {
      await writeFile(outsideTxt, "host secret");
      await writeFile(outsideExe, "binary-ish");
      return [outsideTxt, outsideExe];
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
    const data = res.data as { files: string[]; excerpts: { text: string }[] };
    expect(data.files).toEqual([]);
    expect(data.excerpts).toEqual([]);
    expect(res.message).toContain("outside");
    expect(existsSync(outsideTxt)).toBe(true);
    expect(existsSync(outsideExe)).toBe(true);
  });

  test("refuses a messageId that could climb out of the media dir, without downloading", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    let downloaded = false;
    const dws = directDws(async () => {
      downloaded = true;
      return [];
    });
    const wt = createWorktools({ cfg, dws, workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "media_fetch",
      params: { messageId: "../../../etc" },
    });
    expect(res.ok).toBe(false);
    expect(downloaded).toBe(false);
    expect(await readOutbox(outboxPath)).toEqual([]);
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

  test("the spike never uploads a file from outside the workspace media dir", async () => {
    process.env.DOUSHABAO_VOICE_SPIKE = "1";
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const outside = join(tmpRoot, "outside.txt");
    const dws = directDws(async () => {
      await writeFile(outside, "host secret");
      return [outside];
    });
    const wt = createWorktools({ cfg, dws, workspaces: makeWorkspaces(meta, "") });
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
    expect(outbox.filter((argv) => argv[0] === "minutes")).toEqual([]);
    expect(existsSync(outside)).toBe(true);
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

describe("expert profile gate", () => {
  test("a debug workspace is refused doc_read even for a url shared in-conversation", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "group", "debug");
    const url = "https://alidocs.dingtalk.com/plan";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `here: ${url}`) });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("doc_read");
    expect(res.message).toContain("debug");
    expect(await readOutbox(outboxPath)).toEqual([]);
  });

  test("a general workspace keeps doc_read but is refused todo_create", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir);
    const url = "https://alidocs.dingtalk.com/plan";
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, `here: ${url}`) });
    const allowed = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "doc_read",
      params: { url },
    });
    expect(allowed.ok).toBe(true);

    const refused = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Ship it" },
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("todo_create");
    expect(refused.message).toContain("general");
    const outbox = await readOutbox(outboxPath);
    expect(outbox.filter((argv) => argv[0] === "todo")).toEqual([]);
  });

  test("a project workspace is allowed todo_create", async () => {
    const cfg = makeCfg();
    const meta = makeMeta(wsDir, "conv1", "group", "project");
    const wt = createWorktools({ cfg, dws: fakeBackedDws(), workspaces: makeWorkspaces(meta, "") });
    const res = await wt.execute({
      tool: "worktool",
      conversationId: "conv1",
      senderId: "u1",
      action: "todo_create",
      params: { title: "Ship it" },
    });
    expect(res.ok).toBe(true);
    const outbox = await readOutbox(outboxPath);
    expect(outbox.at(-1)).toEqual(["todo", "task", "create", "--subject", "Ship it"]);
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
    const meta = makeMeta(wsDir, "conv1", "group", "project");
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
    const meta1 = makeMeta(wsDir, "conv1", "group", "project");
    const wsDir2 = join(tmpRoot, "ws2");
    await mkdir(wsDir2, { recursive: true });
    const meta2 = makeMeta(wsDir2, "conv2", "group", "project");
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
