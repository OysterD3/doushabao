#!/usr/bin/env node
/**
 * fake-dws — stands in for the dws binary in tests. READ-ONLY shared contract.
 *
 * Protocol (all via env):
 *   FAKE_DWS_EVENTS   NDJSON file of events to emit. Each line must carry a
 *                     `_key` field naming the event key it belongs to
 *                     (e.g. "user_im_message_receive_group_all"); it is
 *                     stripped before printing. `event consume <key>` tails
 *                     the file (100ms poll), printing matching lines from a
 *                     per-key offset file `<events>.offset.<key>` so restarts
 *                     resume where they left off.
 *   FAKE_DWS_OUTBOX   JSONL file; every non-consume invocation appends
 *                     {ts, argv, messageId?} here. Assertions read this.
 *                     `messageId` is set for `+messages-send` and is the same
 *                     id printed on stdout, so a test can react to the exact
 *                     message a send produced.
 *   FAKE_DWS_CRASH_AFTER  If set (N), a consumer exits(1) after emitting N
 *                     lines — for supervision/restart tests.
 *
 * Side effects for specific commands:
 *   chat +chat-messages ... --download-resources --output-dir <dir>
 *       → writes <dir>/fake-attachment.txt
 *   doc +export ... --output <file>
 *       → writes <file> with "# fake doc\n"
 * Everything else just records to the outbox and prints {"ok":true}.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (argv[0] === "event" && argv[1] === "consume") {
  const key = argv[2] ?? "";
  const eventsFile = process.env.FAKE_DWS_EVENTS ?? "";
  const offsetFile = `${eventsFile}.offset.${key}`;
  const crashAfter = process.env.FAKE_DWS_CRASH_AFTER ? Number(process.env.FAKE_DWS_CRASH_AFTER) : Infinity;
  let emitted = 0;
  let offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, "utf8") || "0") : 0;
  const tick = () => {
    if (!existsSync(eventsFile)) return;
    const lines = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
    while (offset < lines.length) {
      const line = lines[offset]!;
      offset++;
      writeFileSync(offsetFile, String(offset));
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj._key !== key) continue;
      const { _key, ...rest } = obj;
      process.stdout.write(JSON.stringify(rest) + "\n");
      emitted++;
      if (emitted >= crashAfter) process.exit(1);
    }
  };
  tick();
  setInterval(tick, 100);
} else {
  const outbox = process.env.FAKE_DWS_OUTBOX;

  // A real dws reports the id of the message it just posted, and the
  // orchestrator binds a pending question to that exact id so a reaction on
  // some OTHER message cannot answer it. The id must therefore be unique per
  // send: a fake that reused one id per conversation would let a
  // wrong-message reaction pass, which is precisely the bug the binding
  // exists to prevent. Sequence off the outbox so it stays deterministic.
  let messageId: string | undefined;
  if (argv.includes("+messages-send")) {
    const sent = outbox && existsSync(outbox) ? readFileSync(outbox, "utf8").split("\n").filter(Boolean).length : 0;
    messageId = `fake-msg-${sent + 1}`;
  }

  if (outbox) {
    mkdirSync(dirname(outbox), { recursive: true });
    // messageId is recorded too, so a test can discover which message a given
    // send became without having to predict the id.
    appendFileSync(outbox, JSON.stringify({ ts: Date.now(), argv, messageId }) + "\n");
  }
  if (argv.includes("--download-resources")) {
    const dir = flagValue("--output-dir");
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/fake-attachment.txt`, "fake attachment content\n");
    }
  }
  if (argv[0] === "doc" && argv.includes("+export")) {
    const out = flagValue("--output");
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, "# fake doc\n\nExported by fake-dws.\n");
    }
  }
  process.stdout.write(JSON.stringify(messageId ? { ok: true, message_id: messageId } : { ok: true }) + "\n");
}
