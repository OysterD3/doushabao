/**
 * e2e — boots the REAL doushabao daemon (node src/index.ts) against the fake
 * dws/pi binaries and drives it through the six product scenarios from
 * ARCHITECTURE.md + docs/brainstorming/*.content.json. This file is the
 * regression table: every assert reads real daemon output (outbox.jsonl,
 * pi.log, var/tasks, var/audit.jsonl) — no mocking of our own modules.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const FAKE_DWS = join(PROJECT_ROOT, "test/fakes/fake-dws.ts");
const FAKE_PI = join(PROJECT_ROOT, "test/fakes/fake-pi.ts");

// Per-test timeout lives in vitest.e2e.config.ts (60s).

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/** Picks a currently-free TCP port by briefly binding to port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("freePort: server did not report a port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function readJsonlLines(path: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface OutboxRecord {
  ts: number;
  argv: string[];
}
interface PiLogRecord {
  ts: number;
  cwd: string;
  argv: string[];
  prompt: string;
}

let eventSeq = 0;
function nextSeq(): number {
  eventSeq += 1;
  return eventSeq;
}

/** Appends one NDJSON event line for the fake dws consumer to emit. */
async function pushEvent(root: string, key: string, fields: Record<string, unknown>): Promise<void> {
  const n = nextSeq();
  const record = {
    _key: key,
    event_id: fields.event_id ?? `evt-${n}`,
    message_id: fields.message_id ?? `msg-${n}`,
    ...fields,
  };
  const file = join(root, "events.ndjson");
  const prev = existsSync(file) ? await readFile(file, "utf8") : "";
  await writeFile(file, prev + JSON.stringify(record) + "\n");
}

async function readOutbox(root: string): Promise<OutboxRecord[]> {
  return (await readJsonlLines(join(root, "outbox.jsonl"))) as unknown as OutboxRecord[];
}

async function readPiLog(root: string): Promise<PiLogRecord[]> {
  return (await readJsonlLines(join(root, "pi.log"))) as unknown as PiLogRecord[];
}

/** Finds +messages-send outbox entries, optionally filtered by target/text. */
function findSends(records: OutboxRecord[], opts: { group?: string; dm?: string; textIncludes?: string }): OutboxRecord[] {
  return records.filter((r) => {
    const argv = r.argv;
    if (!argv.includes("+messages-send")) return false;
    if (opts.group !== undefined) {
      const i = argv.indexOf("--group");
      if (i === -1 || argv[i + 1] !== opts.group) return false;
    }
    if (opts.dm !== undefined) {
      const i = argv.indexOf("--open-dingtalk-id");
      if (i === -1 || argv[i + 1] !== opts.dm) return false;
    }
    if (opts.textIncludes !== undefined) {
      const i = argv.indexOf("--text");
      const text = i === -1 ? undefined : argv[i + 1];
      if (!text || !text.includes(opts.textIncludes)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

interface Daemon {
  proc: ChildProcess;
  stderr: { text: string };
}

function pumpToBuffer(stream: Readable | null, state: { text: string }): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    state.text += chunk;
  });
}

/** Resolves once the daemon process is fully gone. */
function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("close", () => resolve());
    proc.once("error", () => resolve());
  });
}

function spawnDaemon(root: string, port: number): Daemon {
  // process.execPath, not "node" off PATH: the daemon must run under the same
  // Node that runs this suite, since it loads the .ts sources directly.
  const proc = spawn(process.execPath, ["src/index.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DOUSHABAO_ROOT: root,
      FAKE_DWS_EVENTS: join(root, "events.ndjson"),
      FAKE_DWS_OUTBOX: join(root, "outbox.jsonl"),
      FAKE_PI_SCENARIO: join(root, "scenario.json"),
      FAKE_PI_LOG: join(root, "pi.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrState = { text: "" };
  pumpToBuffer(proc.stderr, stderrState);
  pumpToBuffer(proc.stdout, stderrState);
  return { proc, stderr: stderrState };
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, timeoutMs, 100);
}

async function writeConfig(root: string, port: number): Promise<void> {
  const cfg = {
    admins: ["adminU"],
    timezone: "UTC",
    dwsBin: FAKE_DWS,
    piBin: FAKE_PI,
    http: { host: "127.0.0.1", port },
    pacing: { sendIntervalMs: 50 },
  };
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "doushabao.json"), JSON.stringify(cfg, null, 2));
}

async function writeScenario(root: string): Promise<void> {
  // Order matters: "long job" must be checked before "delegate" so that any
  // prompt containing the delegated task's own request text (which is very
  // likely to also mention "delegate") resolves to the worker's plain-text
  // answer instead of re-triggering delegate_async and looping.
  const scenario = {
    responses: [
      {
        match: "ask me",
        text: "on it",
        toolCalls: [
          {
            tool: "ask_user",
            question: "Pick",
            options: ["yes", "no"],
            defaultOption: 0,
            purpose: "question",
            approverScope: "requester",
          },
        ],
      },
      { match: "long job", text: "result ready", delayMs: 2500 },
      { match: "delegate", toolCalls: [{ tool: "delegate_async", requestText: "long job" }] },
      { match: "cron ping", text: "cron says hi" },
    ],
    default: { text: "hello from pi" },
  };
  await writeFile(join(root, "scenario.json"), JSON.stringify(scenario, null, 2));
}

/** paths.boilerplates is ROOT-relative (see src/shared/paths.ts), so the
 * sandbox needs its own copy of the real project's boilerplate templates. */
async function copyBoilerplates(root: string): Promise<void> {
  const src = join(PROJECT_ROOT, "boilerplates");
  if (!existsSync(src)) return;
  await cp(src, join(root, "boilerplates"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let root = "";
let port = 0;
let daemon: Daemon;

async function withDebug<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error("=== daemon stderr+stdout (tail) ===\n" + daemon.stderr.text.slice(-6000));
    throw err;
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "doushabao-e2e-"));
  port = await freePort();
  await writeConfig(root, port);
  await writeScenario(root);
  await copyBoilerplates(root);
  daemon = spawnDaemon(root, port);
  await withDebug(() => waitForHealth(port, 20_000));
});

afterAll(async () => {
  try {
    daemon.proc.kill("SIGKILL");
    await waitForExit(daemon.proc);
  } catch {
    /* already dead */
  }
});

// ---------------------------------------------------------------------------
// Scenario 1: DM in -> reply out (+ first-contact greeting)
// ---------------------------------------------------------------------------

test("scenario 1: DM in -> reply out", () =>
  withDebug(async () => {
    const before = await readOutbox(root);
    const beforeCount = findSends(before, { dm: "userA" }).length;

    await pushEvent(root, "user_im_message_receive_o2o", {
      conversation_id: "userA",
      sender_open_dingtalk_id: "userA",
      content: "hi",
    });

    await waitFor(async () => {
      const sends = findSends(await readOutbox(root), { dm: "userA" });
      return sends.length >= beforeCount + 2;
    }, 15_000);

    const sends = findSends(await readOutbox(root), { dm: "userA" }).slice(beforeCount);
    expect(sends.length).toBeGreaterThanOrEqual(2);

    const reply = findSends(sends, { textIncludes: "hello from pi" });
    expect(reply.length).toBeGreaterThanOrEqual(1);

    // A second, distinct send is the one-time greeting for first contact.
    const nonReply = sends.filter((r) => {
      const i = r.argv.indexOf("--text");
      const text = i === -1 ? "" : r.argv[i + 1] ?? "";
      return !text.includes("hello from pi");
    });
    expect(nonReply.length).toBeGreaterThanOrEqual(1);
  }));

// ---------------------------------------------------------------------------
// Scenario 2: group log-all vs mention
// ---------------------------------------------------------------------------

test("scenario 2: group log-all vs mention", () =>
  withDebug(async () => {
    const piBefore = (await readPiLog(root)).length;

    await pushEvent(root, "user_im_message_receive_group_all", {
      conversation_id: "group2",
      sender_open_dingtalk_id: "userB",
      content: "weather is nice today",
    });

    // No run should fire from ambient group logging.
    await sleep(1_200);
    expect((await readPiLog(root)).length).toBe(piBefore);

    const outboxBefore = await readOutbox(root);
    const groupSendsBefore = findSends(outboxBefore, { group: "group2" }).length;

    await pushEvent(root, "user_im_message_receive_at", {
      conversation_id: "group2",
      sender_open_dingtalk_id: "userB",
      content: "weather is nice today",
    });

    await waitFor(async () => (await readPiLog(root)).length >= piBefore + 1, 15_000);
    expect((await readPiLog(root)).length).toBe(piBefore + 1);

    await waitFor(async () => {
      return findSends(await readOutbox(root), { group: "group2" }).length > groupSendsBefore;
    }, 15_000);
    const reply = findSends(await readOutbox(root), { group: "group2", textIncludes: "hello from pi" });
    expect(reply.length).toBeGreaterThanOrEqual(1);
  }));

// ---------------------------------------------------------------------------
// Scenario 3: ask/approve round-trip
// ---------------------------------------------------------------------------

test("scenario 3: ask/approve round-trip", () =>
  withDebug(async () => {
    const piBefore = (await readPiLog(root)).length;

    await pushEvent(root, "user_im_message_receive_at", {
      conversation_id: "group3",
      sender_open_dingtalk_id: "userC",
      content: "please ask me something",
    });

    await waitFor(async () => (await readPiLog(root)).length >= piBefore + 1, 15_000);

    // Outbox should carry a numbered-options message.
    await waitFor(async () => {
      const sends = findSends(await readOutbox(root), { group: "group3" });
      return sends.some((r) => {
        const i = r.argv.indexOf("--text");
        const text = i === -1 ? "" : r.argv[i + 1] ?? "";
        return text.includes("yes") && text.includes("no") && text.includes("1") && text.includes("2");
      });
    }, 15_000);

    const piAfterAsk = (await readPiLog(root)).length;

    await pushEvent(root, "user_im_message_reaction_group", {
      conversation_id: "group3",
      message_id: "options-msg-group3",
      operator_open_dingtalk_id: "userC",
      reaction_name: "like",
      operation_type: "add",
    });

    // A NEW pi run resumes with the chosen option in its prompt.
    await waitFor(async () => (await readPiLog(root)).length >= piAfterAsk + 1, 10_000);
    const log = await readPiLog(root);
    const resumed = log[log.length - 1]!;
    expect(resumed.prompt.includes("yes") || resumed.prompt.includes("no")).toBe(true);
  }));

// ---------------------------------------------------------------------------
// Scenario 4: unauthorized reaction ignored
// ---------------------------------------------------------------------------

test("scenario 4: unauthorized reaction ignored", () =>
  withDebug(async () => {
    const piBefore = (await readPiLog(root)).length;

    await pushEvent(root, "user_im_message_receive_at", {
      conversation_id: "group4",
      sender_open_dingtalk_id: "userD",
      content: "please ask me something",
    });

    await waitFor(async () => (await readPiLog(root)).length >= piBefore + 1, 15_000);
    const piAfterAsk = (await readPiLog(root)).length;

    await pushEvent(root, "user_im_message_reaction_group", {
      conversation_id: "group4",
      message_id: "options-msg-group4",
      operator_open_dingtalk_id: "stranger",
      reaction_name: "like",
      operation_type: "add",
    });

    // No resume run within 2s from an operator who is not the requester.
    await sleep(2_000);
    expect((await readPiLog(root)).length).toBe(piAfterAsk);
  }));

// ---------------------------------------------------------------------------
// Scenario 5: cron fires
// ---------------------------------------------------------------------------

test("scenario 5: cron fires", () =>
  withDebug(async () => {
    const token = (await readFile(join(root, "var", "ipc-token"), "utf8")).trim();
    const piBefore = (await readPiLog(root)).length;

    const res = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tool: "schedule_job",
        conversationId: "userA",
        senderId: "adminU",
        cronExpr: "* * * * * *",
        description: "e2e cron ping",
        prompt: "cron ping",
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    await waitFor(async () => {
      const log = await readPiLog(root);
      return log.slice(piBefore).some((r) => r.prompt.includes("cron ping"));
    }, 6_000);

    await waitFor(async () => {
      return findSends(await readOutbox(root), { dm: "userA", textIncludes: "cron says hi" }).length > 0;
    }, 6_000);
  }));

// ---------------------------------------------------------------------------
// Scenario 6: task survives restart
// ---------------------------------------------------------------------------

async function readTaskFiles(root: string): Promise<{ status: string }[]> {
  const dir = join(root, "var", "tasks");
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out: { status: string }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as { status: string };
      out.push(parsed);
    } catch {
      /* file mid-write, retry on next poll */
    }
  }
  return out;
}

test("scenario 6: task survives restart", () =>
  withDebug(async () => {
    await pushEvent(root, "user_im_message_receive_at", {
      conversation_id: "group6",
      sender_open_dingtalk_id: "userE",
      content: "delegate please",
    });

    await waitFor(async () => {
      const tasks = await readTaskFiles(root);
      return tasks.some((t) => t.status === "queued" || t.status === "running");
    }, 10_000, 20);

    daemon.proc.kill("SIGKILL");
    await waitForExit(daemon.proc);

    daemon = spawnDaemon(root, port);
    await withDebug(() => waitForHealth(port, 20_000));

    await waitFor(async () => {
      return findSends(await readOutbox(root), { group: "group6", textIncludes: "result ready" }).length > 0;
    }, 20_000);

    const tasks = await readTaskFiles(root);
    expect(tasks.some((t) => t.status === "done" || t.status === "announced")).toBe(true);
  }));

// ---------------------------------------------------------------------------
// Final: audit log is non-empty
// ---------------------------------------------------------------------------

test("audit log is non-empty", () =>
  withDebug(async () => {
    const auditPath = join(root, "var", "audit.jsonl");
    await waitFor(() => existsSync(auditPath), 5_000);
    const text = await readFile(auditPath, "utf8");
    expect(text.trim().length).toBeGreaterThan(0);
  }));
