/**
 * src/dws tests. Sets DOUSHABAO_ROOT to a tmp dir *before* the first
 * (dynamic) import of anything that touches src/shared/paths.ts, since that
 * module bakes `ROOT`/`paths` from the env var once, at first import. All
 * tests in this file share that one ROOT (and therefore one var/dedupe.json,
 * var/last-event-at, var/dws-gap.log) — fixtures use unique event/message
 * ids per test so dedupe state never collides across tests.
 *
 * cfg.dwsBin points directly at test/fakes/fake-dws.ts (chmod +x, shebang
 * `#!/usr/bin/env node`). FAKE_DWS_EVENTS / FAKE_DWS_OUTBOX / FAKE_DWS_CRASH_AFTER
 * are read by the fake from process.env at spawn time (see its header).
 */
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "doushabao-dws-"));
process.env.DOUSHABAO_ROOT = root;

const { createDws } = await import("./index.ts");
const { paths } = await import("../shared/paths.ts");
const { ConfigSchema } = await import("../shared/types.ts");
import type { Config, InboundEvent } from "../shared/types.ts";

const FAKE_DWS = join(import.meta.dirname, "..", "..", "test", "fakes", "fake-dws.ts");

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let fixtureCounter = 0;
async function nextFixtureDir(): Promise<string> {
  fixtureCounter += 1;
  const dir = join(root, `fixture-${fixtureCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function readOutbox(outbox: string): Promise<string[][]> {
  const raw = await readFile(outbox, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}

function makeCfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ dwsBin: FAKE_DWS, pacing: { sendIntervalMs: 60 }, ...overrides });
}

// Active dws instances get stopped in afterEach so no consumer child leaks
// across tests.
let activeDws: ReturnType<typeof createDws> | undefined;

afterEach(async () => {
  await activeDws?.stopConsuming();
  activeDws = undefined;
  delete process.env.FAKE_DWS_EVENTS;
  delete process.env.FAKE_DWS_OUTBOX;
  delete process.env.FAKE_DWS_CRASH_AFTER;
  delete process.env.DOUSHABAO_TOKEN;
});

/**
 * A stand-in "dws binary" that appends its whole environment to `dumpFile`.
 * The env the child actually receives is only observable from inside the
 * child, so the assertion has to come from the child itself.
 */
async function writeEnvDumpBin(dir: string, dumpFile: string): Promise<string> {
  const bin = join(dir, "env-dump-dws");
  await writeFile(bin, `#!/bin/sh\nenv >> '${dumpFile}'\necho '{"ok":true}'\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe("event normalization", () => {
  test("dm message, group message, and reaction operation_type variants", async () => {
    const dir = await nextFixtureDir();
    const eventsFile = join(dir, "events.ndjson");
    await writeFile(
      eventsFile,
      [
        JSON.stringify({
          _key: "user_im_message_receive_o2o",
          event_id: "e1",
          message_id: "norm-m1",
          conversation_id: "u_alice",
          sender: "Alice",
          sender_open_dingtalk_id: "u_alice",
          content: "hi dm",
        }),
        JSON.stringify({
          _key: "user_im_message_receive_group_all",
          event_id: "e2",
          message_id: "norm-m2",
          conversation_id: "g1",
          sender: "Bob",
          sender_open_dingtalk_id: "u_bob",
          content: "hello group",
        }),
        JSON.stringify({
          _key: "user_im_message_reaction_group",
          event_id: "e3",
          message_id: "norm-m2",
          conversation_id: "g1",
          operator_open_dingtalk_id: "u_carol",
          reaction_name: "+1",
          operation_type: 1,
        }),
        JSON.stringify({
          _key: "user_im_message_reaction_o2o",
          event_id: "e4",
          message_id: "norm-m1",
          conversation_id: "u_alice",
          operator_open_dingtalk_id: "u_dave",
          reaction_name: "-1",
          operation_type: "remove",
        }),
        JSON.stringify({
          _key: "user_im_message_reaction_group",
          event_id: "e5",
          message_id: "norm-m2",
          conversation_id: "g1",
          operator_open_dingtalk_id: "u_erin",
          reaction_name: "heart",
          operation_type: 99,
        }),
      ].join("\n") + "\n",
    );
    process.env.FAKE_DWS_EVENTS = eventsFile;

    const events: InboundEvent[] = [];
    const dws = createDws(makeCfg());
    activeDws = dws;
    await dws.startConsuming((ev) => events.push(ev));

    await waitUntil(() => events.length >= 5, 3000);

    const dm = events.find((e) => e.messageId === "norm-m1" && e.kind === "message");
    expect(dm?.kind).toBe("message");
    if (dm?.kind === "message") {
      expect(dm.conversationType).toBe("dm");
      expect(dm.mention).toBe(false);
      expect(dm.senderId).toBe("u_alice");
      expect(dm.senderName).toBe("Alice");
      expect(dm.content).toBe("hi dm");
    }

    const groupMsg = events.find((e) => e.messageId === "norm-m2" && e.kind === "message");
    expect(groupMsg?.kind).toBe("message");
    if (groupMsg?.kind === "message") {
      expect(groupMsg.conversationType).toBe("group");
      expect(groupMsg.mention).toBe(false);
      expect(groupMsg.content).toBe("hello group");
    }

    const reactAdd = events.find((e) => e.kind === "reaction" && e.eventId === "e3");
    expect(reactAdd?.kind).toBe("reaction");
    if (reactAdd?.kind === "reaction") {
      expect(reactAdd.operation).toBe("add");
      expect(reactAdd.operatorId).toBe("u_carol");
      expect(reactAdd.emoji).toBe("+1");
    }

    const reactRemove = events.find((e) => e.kind === "reaction" && e.eventId === "e4");
    expect(reactRemove?.kind).toBe("reaction");
    if (reactRemove?.kind === "reaction") expect(reactRemove.operation).toBe("remove");

    const reactUnknown = events.find((e) => e.kind === "reaction" && e.eventId === "e5");
    expect(reactUnknown?.kind).toBe("reaction");
    if (reactUnknown?.kind === "reaction") expect(reactUnknown.operation).toBe("unknown");
  });
});

describe("mention dedupe", () => {
  test("same messageId on _at and _group_all -> exactly one event, mention wins", async () => {
    const dir = await nextFixtureDir();
    const eventsFile = join(dir, "events.ndjson");
    await writeFile(
      eventsFile,
      [
        JSON.stringify({
          _key: "user_im_message_receive_group_all",
          event_id: "ga1",
          message_id: "mention-m1",
          conversation_id: "g1",
          sender: "Bob",
          sender_open_dingtalk_id: "u_bob",
          content: "@doushabao hi",
        }),
        JSON.stringify({
          _key: "user_im_message_receive_at",
          event_id: "at1",
          message_id: "mention-m1",
          conversation_id: "g1",
          sender: "Bob",
          sender_open_dingtalk_id: "u_bob",
          content: "@doushabao hi",
        }),
        JSON.stringify({
          _key: "user_im_message_receive_group_all",
          event_id: "ga2",
          message_id: "mention-m2",
          conversation_id: "g1",
          sender: "Carol",
          sender_open_dingtalk_id: "u_carol",
          content: "plain message",
        }),
      ].join("\n") + "\n",
    );
    process.env.FAKE_DWS_EVENTS = eventsFile;

    const events: InboundEvent[] = [];
    const dws = createDws(makeCfg());
    activeDws = dws;
    await dws.startConsuming((ev) => events.push(ev));

    // Wait well past the mention-debounce window so both messageIds settle.
    await new Promise((r) => setTimeout(r, 800));

    const m1Events = events.filter((e) => e.messageId === "mention-m1");
    expect(m1Events.length).toBe(1);
    expect(m1Events[0]?.kind).toBe("message");
    if (m1Events[0]?.kind === "message") expect(m1Events[0].mention).toBe(true);

    const m2Events = events.filter((e) => e.messageId === "mention-m2");
    expect(m2Events.length).toBe(1);
    expect(m2Events[0]?.kind).toBe("message");
    if (m2Events[0]?.kind === "message") expect(m2Events[0].mention).toBe(false);
  });
});

describe("consumer crash-restart", () => {
  test("respawns after crash, delivers all events, logs a gap marker per restart", async () => {
    const dir = await nextFixtureDir();
    const eventsFile = join(dir, "events.ndjson");
    // Only the group_all key has events, so only that consumer ever crashes
    // (FAKE_DWS_CRASH_AFTER applies per-process emit count to every consumer).
    await writeFile(
      eventsFile,
      [
        JSON.stringify({
          _key: "user_im_message_receive_group_all",
          event_id: "c1",
          message_id: "crash-m1",
          conversation_id: "g1",
          sender: "Bob",
          sender_open_dingtalk_id: "u_bob",
          content: "one",
        }),
        JSON.stringify({
          _key: "user_im_message_receive_group_all",
          event_id: "c2",
          message_id: "crash-m2",
          conversation_id: "g1",
          sender: "Bob",
          sender_open_dingtalk_id: "u_bob",
          content: "two",
        }),
      ].join("\n") + "\n",
    );
    process.env.FAKE_DWS_EVENTS = eventsFile;
    process.env.FAKE_DWS_CRASH_AFTER = "1";

    const events: InboundEvent[] = [];
    const dws = createDws(makeCfg());
    activeDws = dws;
    await dws.startConsuming((ev) => events.push(ev));

    // First event arrives quickly; the crash + 1s backoff + respawn delays
    // the second past the mention-debounce window.
    await waitUntil(() => events.filter((e) => e.conversationId === "g1").length >= 2, 5000);

    const ids = events.filter((e) => e.kind === "message").map((e) => e.messageId);
    expect(ids).toContain("crash-m1");
    expect(ids).toContain("crash-m2");

    const gapLog = await readFile(join(paths.var, "dws-gap.log"), "utf8");
    const restartsForKey = gapLog.split("\n").filter((l) => l.includes("user_im_message_receive_group_all")).length;
    expect(restartsForKey).toBeGreaterThanOrEqual(2); // initial start + at least one restart
  }, 8000);
});

describe("shutdown during backoff", () => {
  test("stopConsuming resolves promptly while consumers wait out their backoff", async () => {
    const dir = await nextFixtureDir();
    // A missing binary makes every spawn fail immediately, so each consumer
    // ends up parked in its backoff wait (>= 2s after one doubling).
    const dws = createDws(makeCfg({ dwsBin: join(dir, "does-not-exist-binary") }));
    activeDws = dws;
    await dws.startConsuming(() => {});

    await new Promise((r) => setTimeout(r, 300));

    const start = Date.now();
    await dws.stopConsuming();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("sendText pacing and argv", () => {
  test("paces spawns by sendIntervalMs, FIFO order, correct argv for group vs dm", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;

    const cfg = makeCfg({ pacing: { sendIntervalMs: 200 } });
    const dws = createDws(cfg);
    activeDws = dws;

    const results = await Promise.all([
      dws.sendText("group-1", "group", "first"),
      dws.sendText("user-2", "dm", "second"),
      dws.sendText("group-1", "group", "third"),
    ]);
    expect(results).toHaveLength(3);

    const raw = await readFile(outbox, "utf8");
    const lines = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { ts: number; argv: string[] });
    expect(lines.length).toBe(3);

    // FIFO order preserved.
    expect(lines[0]?.argv).toContain("first");
    expect(lines[1]?.argv).toContain("second");
    expect(lines[2]?.argv).toContain("third");

    // Paced: each spawn at least ~sendIntervalMs after the previous. The `ts`
    // is recorded by the child itself, so allow slack for process cold-start
    // jitter; the invariant under test is "meaningfully paced", not exact ms.
    expect((lines[1]?.ts ?? 0) - (lines[0]?.ts ?? 0)).toBeGreaterThanOrEqual(150);
    expect((lines[2]?.ts ?? 0) - (lines[1]?.ts ?? 0)).toBeGreaterThanOrEqual(150);

    // Group argv uses --group, not --open-dingtalk-id.
    const groupArgv = lines[0]?.argv ?? [];
    expect(groupArgv).toContain("--group");
    expect(groupArgv).toContain("group-1");
    expect(groupArgv).not.toContain("--open-dingtalk-id");

    // DM argv uses --open-dingtalk-id, not --group.
    const dmArgv = lines[1]?.argv ?? [];
    expect(dmArgv).toContain("--open-dingtalk-id");
    expect(dmArgv).toContain("user-2");
    expect(dmArgv).not.toContain("--group");
  });
});

describe("media, doc export, doctor", () => {
  test("downloadMedia scopes files under the message and uses --group", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destDir = join(dir, "media-dest");

    const dws = createDws(makeCfg());
    activeDws = dws;
    const created = await dws.downloadMedia("g1", "group", "msg-1", destDir);

    expect(created.length).toBe(1);
    expect(created[0]).toBe(join(destDir, "msg-1", "fake-attachment.txt"));
    expect(existsSync(created[0]!)).toBe(true);

    const argv = (await readOutbox(outbox))[0] ?? [];
    expect(argv).toContain("--group");
    expect(argv).toContain("g1");
    expect(argv).not.toContain("--open-dingtalk-id");
  });

  test("downloadMedia in a DM selects by --open-dingtalk-id", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destDir = join(dir, "media-dest");

    const dws = createDws(makeCfg());
    activeDws = dws;
    await dws.downloadMedia("u_alice", "dm", "msg-1", destDir);

    const argv = (await readOutbox(outbox))[0] ?? [];
    expect(argv).toContain("--open-dingtalk-id");
    expect(argv).toContain("u_alice");
    expect(argv).not.toContain("--group");
  });

  test("downloadMedia: a second fetch in the same conversation still returns files", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destDir = join(dir, "media-dest");

    const dws = createDws(makeCfg());
    activeDws = dws;
    const first = await dws.downloadMedia("g1", "group", "msg-1", destDir);
    const second = await dws.downloadMedia("g1", "group", "msg-2", destDir);

    expect(first).toEqual([join(destDir, "msg-1", "fake-attachment.txt")]);
    expect(second).toEqual([join(destDir, "msg-2", "fake-attachment.txt")]);
    expect(existsSync(second[0]!)).toBe(true);

    // Re-fetching the same message is idempotent, not empty.
    const again = await dws.downloadMedia("g1", "group", "msg-1", destDir);
    expect(again).toEqual(first);
  });

  test("downloadMedia sanitizes the messageId into the destination path", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destDir = join(dir, "media-dest");

    const dws = createDws(makeCfg());
    activeDws = dws;
    const created = await dws.downloadMedia("g1", "group", "../../evil", destDir);

    expect(created.length).toBe(1);
    expect(created[0]?.startsWith(join(destDir, "_"))).toBe(true);
    expect(created[0]).not.toContain("..");
    expect(existsSync(join(dir, "evil"))).toBe(false);
  });

  test("exportDoc writes the exported file", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destFile = join(dir, "exported.md");

    const dws = createDws(makeCfg());
    activeDws = dws;
    // Host must be in cfg.docHosts (schema default covers alidocs.dingtalk.com).
    await dws.exportDoc("https://alidocs.dingtalk.com/doc/abc", destFile);

    const content = await readFile(destFile, "utf8");
    expect(content).toContain("# fake doc");
  });

  test("doctor: ok:true against the fake, ok:false for a missing binary", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;

    const okDws = createDws(makeCfg());
    activeDws = okDws;
    const okResult = await okDws.doctor();
    expect(okResult.ok).toBe(true);

    const missingDws = createDws(makeCfg({ dwsBin: join(dir, "does-not-exist-binary") }));
    const badResult = await missingDws.doctor();
    expect(badResult.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Option injection. Every value slot is caller data; dws parses any argv
// element starting with "-" as an option. The load-bearing assertion on a
// refusal is that NOTHING was spawned — the outbox file never appears.
// ---------------------------------------------------------------------------

describe("option injection at the dws argv boundary", () => {
  test("reply text starting with '-' is delivered whole, prefixed with a newline", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;

    const dws = createDws(makeCfg());
    activeDws = dws;
    const bullets = "- first\n- second";
    await dws.sendText("g1", "group", bullets);
    await dws.sendText("g1", "group", "plain reply");

    const sent = await readOutbox(outbox);
    expect(sent.length).toBe(2);
    const bulletArgv = sent[0] ?? [];
    const plainArgv = sent[1] ?? [];

    // The reply reached dws, and every byte the model wrote is still there.
    const sentText = bulletArgv[bulletArgv.indexOf("--text") + 1];
    expect(sentText).toBe(`\n${bullets}`);
    expect(sentText?.slice(1)).toBe(bullets);
    // A text that cannot be mistaken for an option is passed through untouched.
    expect(plainArgv[plainArgv.indexOf("--text") + 1]).toBe("plain reply");
  });

  test("a '--flag'-shaped reply cannot become an option", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;

    const dws = createDws(makeCfg());
    activeDws = dws;
    await dws.sendText("g1", "group", "--output-dir=/tmp/pwned --as admin");

    const argv = (await readOutbox(outbox))[0] ?? [];
    expect(argv).not.toContain("--output-dir=/tmp/pwned --as admin");
    expect(argv[argv.indexOf("--text") + 1]).toBe("\n--output-dir=/tmp/pwned --as admin");
    // Exactly one --as, still "user": nothing in the text slot added an option.
    expect(argv.filter((a) => a === "--as")).toEqual(["--as"]);
    expect(argv[argv.indexOf("--as") + 1]).toBe("user");
  });

  test("a NUL in the text is refused and nothing is spawned", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;

    const dws = createDws(makeCfg());
    activeDws = dws;
    await expect(dws.sendText("g1", "group", "hello --as admin")).rejects.toThrow(/NUL/);
    expect(existsSync(outbox)).toBe(false);
  });

  test("option-shaped ids and doc urls are refused, and nothing is spawned", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destFile = join(dir, "never-written.md");

    const dws = createDws(makeCfg());
    activeDws = dws;

    // conversationId in the selector slot
    await expect(dws.sendText("--output=/tmp/pwned", "group", "hi")).rejects.toThrow(/starts with "-"/);
    await expect(dws.sendText("-x", "dm", "hi")).rejects.toThrow(/starts with "-"/);
    // conversationId in downloadMedia's selector slot
    await expect(dws.downloadMedia("--output-dir=/tmp/pwned", "group", "m1", join(dir, "media"))).rejects.toThrow(
      /starts with "-"/,
    );
    // docUrl: not even a URL, so the host allowlist refuses it first
    await expect(dws.exportDoc("--output=/tmp/pwned", destFile)).rejects.toThrow(/exportDoc refused/);

    expect(existsSync(outbox)).toBe(false);
    expect(existsSync(destFile)).toBe(false);
  });

  test("exportDoc refuses any host outside cfg.docHosts", async () => {
    const dir = await nextFixtureDir();
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    const destFile = join(dir, "never-written.md");

    const dws = createDws(makeCfg());
    activeDws = dws;

    for (const url of [
      "https://evil.example/steal", // exfiltration target
      "https://alidocs.dingtalk.com.evil.example/doc", // suffix lookalike
      "https://alidocs.dingtalk.com@evil.example/doc", // userinfo lookalike
      "file:///etc/passwd", // local file read
      "http://127.0.0.1:8787/tool", // the daemon's own IPC socket
    ]) {
      await expect(dws.exportDoc(url, destFile)).rejects.toThrow(/exportDoc refused/);
    }
    expect(existsSync(outbox)).toBe(false);
    expect(existsSync(destFile)).toBe(false);

    // The same host IS allowed once config says so — the refusal is the
    // allowlist, not a blanket ban.
    const openDws = createDws(makeCfg({ docHosts: ["evil.example"] }));
    await openDws.exportDoc("https://evil.example/steal", destFile);
    expect(existsSync(destFile)).toBe(true);
  });
});

describe("media path containment", () => {
  test("no messageId can place a file outside destDir", async () => {
    const dir = await nextFixtureDir();
    process.env.FAKE_DWS_OUTBOX = join(dir, "outbox.jsonl");
    const destDir = join(dir, "media-dest");

    const dws = createDws(makeCfg());
    activeDws = dws;

    for (const messageId of ["../../evil", "/etc/passwd", "....//....//evil", "..\\..\\evil", ".", "..", ""]) {
      const created = await dws.downloadMedia("g1", "group", messageId, destDir);
      expect(created.length).toBe(1);
      for (const file of created) {
        expect(file.startsWith(destDir + "/")).toBe(true);
        expect(file).not.toContain("..");
        expect(existsSync(file)).toBe(true);
      }
    }
    expect(existsSync(join(dir, "evil"))).toBe(false);
    expect(existsSync(join(destDir, "..", "evil"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Child environment. The daemon holds the IPC bearer token that authorizes
// every tool call; dws authenticates itself and must not see it.
// ---------------------------------------------------------------------------

describe("reduced child environment", () => {
  test("one-shot invocations hand dws PATH + FAKE_DWS_*, never DOUSHABAO_*", async () => {
    const dir = await nextFixtureDir();
    const dump = join(dir, "env-dump.txt");
    const outbox = join(dir, "outbox.jsonl");
    process.env.FAKE_DWS_OUTBOX = outbox;
    process.env.DOUSHABAO_TOKEN = "ipc-bearer-token-must-not-leak";

    const dws = createDws(makeCfg({ dwsBin: await writeEnvDumpBin(dir, dump) }));
    activeDws = dws;
    const result = await dws.doctor();
    expect(result.ok).toBe(true);

    const env = await readFile(dump, "utf8");
    // Positive controls: an empty dump must not be able to pass this test.
    expect(env).toMatch(/^PATH=/m);
    expect(env).toContain(`FAKE_DWS_OUTBOX=${outbox}`);
    // The secrets.
    expect(env).not.toContain("DOUSHABAO_TOKEN");
    expect(env).not.toContain("ipc-bearer-token-must-not-leak");
    expect(env).not.toContain("DOUSHABAO_ROOT");
  });

  test("consumer children get the same reduced environment", async () => {
    const dir = await nextFixtureDir();
    const dump = join(dir, "env-dump.txt");
    process.env.FAKE_DWS_EVENTS = join(dir, "events.ndjson");
    process.env.DOUSHABAO_TOKEN = "ipc-bearer-token-must-not-leak";

    const dws = createDws(makeCfg({ dwsBin: await writeEnvDumpBin(dir, dump) }));
    activeDws = dws;
    await dws.startConsuming(() => {});
    // Wait for CONTENT, not just for the file to exist: the child creates the
    // dump before it finishes writing it, so `existsSync` alone races and the
    // assertions below then read an empty string.
    await waitUntil(() => existsSync(dump) && readFileSync(dump, "utf8").includes("PATH="));
    await dws.stopConsuming();
    activeDws = undefined;

    const env = await readFile(dump, "utf8");
    expect(env).toMatch(/^PATH=/m);
    expect(env).toContain(`FAKE_DWS_EVENTS=${join(dir, "events.ndjson")}`);
    expect(env).not.toContain("DOUSHABAO_TOKEN");
    expect(env).not.toContain("ipc-bearer-token-must-not-leak");
    expect(env).not.toContain("DOUSHABAO_ROOT");
  });
});
