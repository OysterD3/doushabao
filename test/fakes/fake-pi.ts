#!/usr/bin/env node
/**
 * fake-pi — stands in for the pi binary in tests. READ-ONLY shared contract.
 *
 * Env protocol:
 *   FAKE_PI_SCENARIO  JSON file:
 *     {
 *       "responses": [
 *         { "match": "substring of prompt",
 *           "text": "final assistant text",
 *           "toolCalls": [ { "tool": "ask_user", ...params-without-identity } ] }
 *       ],
 *       "default": { "text": "ok" }
 *     }
 *   FAKE_PI_LOG       JSONL file; every invocation appends {ts, cwd, argv, prompt}.
 *
 * Behavior: picks the first response whose `match` is a substring of the
 * prompt (last non-flag argv), else `default`. Executes toolCalls by POSTing
 * to $DOUSHABAO_API/tool with Authorization: Bearer $DOUSHABAO_TOKEN, injecting
 * conversationId=$DOUSHABAO_CONVERSATION and senderId=$DOUSHABAO_SENDER —
 * mirroring how the real workspace extension injects identity from env.
 * Then prints a pi `--mode json`-shaped JSONL stream; the authoritative line is:
 *   {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const prompt = [...argv].reverse().find((a) => !a.startsWith("-") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true && !a.startsWith("--")) ?? "";

const log = process.env.FAKE_PI_LOG;
if (log) {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, JSON.stringify({ ts: Date.now(), cwd: process.cwd(), argv, prompt }) + "\n");
}

interface Scenario {
  responses?: { match: string; text: string; toolCalls?: Record<string, unknown>[]; delayMs?: number }[];
  default?: { text: string; toolCalls?: Record<string, unknown>[]; delayMs?: number };
}
let scenario: Scenario = {};
try {
  scenario = JSON.parse(readFileSync(process.env.FAKE_PI_SCENARIO ?? "", "utf8")) as Scenario;
} catch {
  /* default below */
}
const picked = scenario.responses?.find((r) => prompt.includes(r.match)) ?? scenario.default ?? { text: "ok" };

// Optional per-response delay so tests can hold a run "in flight" (e.g. to
// kill the daemon mid-task in restart-survival scenarios).
if ("delayMs" in picked && typeof picked.delayMs === "number" && picked.delayMs > 0) {
  await new Promise((r) => setTimeout(r, picked.delayMs));
}

for (const call of picked.toolCalls ?? []) {
  const body = {
    ...call,
    conversationId: process.env.DOUSHABAO_CONVERSATION,
    senderId: process.env.DOUSHABAO_SENDER,
  };
  try {
    await fetch(`${process.env.DOUSHABAO_API}/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.DOUSHABAO_TOKEN ?? ""}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* orchestrator down — e2e asserts on outbox anyway */
  }
}

process.stdout.write(JSON.stringify({ type: "session", id: "fake" }) + "\n");
process.stdout.write(
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: picked.text }] },
  }) + "\n",
);
