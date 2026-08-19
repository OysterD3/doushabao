/**
 * src/dws — adapter around the `dws` binary. The ONLY module that spawns dws.
 * Owns: event consumers (one child per event key), the paced outbound send
 * queue, media download, doc export, and the auth doctor probe.
 *
 * See ARCHITECTURE.md ("dws invocation contract") for the argv shapes and
 * NDJSON field names this file encodes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  Config,
  ConversationType,
  DwsPort,
  InboundEvent,
  InboundMessage,
  InboundReaction,
} from "../shared/types.ts";
import { paths } from "../shared/paths.ts";

// ---------------------------------------------------------------------------
// Event keys (ARCHITECTURE.md "dws invocation contract")
// ---------------------------------------------------------------------------

const EVENT_KEYS = [
  "user_im_message_receive_at",
  "user_im_message_receive_o2o",
  "user_im_message_receive_group_all",
  "user_im_message_reaction_group",
  "user_im_message_reaction_o2o",
] as const;
type EventKey = (typeof EVENT_KEYS)[number];

const MENTION_KEY: EventKey = "user_im_message_receive_at";
/** Window to wait for a sibling `_at` event before flushing a `_group_all`
 * message as a non-mention. Chosen well above the fake's 100ms poll tick;
 * real dws delivers both keys close in wall-clock time (see final report). */
const MENTION_DEBOUNCE_MS = 250;
const DEDUPE_MAX = 8192;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

/** Not in shared/paths.ts (read-only) — request that contract change in the report. */
const gapMarkerPath = join(paths.var, "dws-gap.log");

function isReactionKey(key: EventKey): boolean {
  return key === "user_im_message_reaction_group" || key === "user_im_message_reaction_o2o";
}

function conversationTypeFor(key: EventKey): ConversationType {
  return key.endsWith("_o2o") ? "dm" : "group";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Normalization: raw NDJSON -> InboundEvent
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function normalizeOperation(v: unknown): "add" | "remove" | "unknown" {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.toLowerCase() : "";
  if (s === "1" || s === "add") return "add";
  if (s === "2" || s === "remove") return "remove";
  return "unknown";
}

function normalizeMessage(key: EventKey, raw: Record<string, unknown>): InboundMessage | undefined {
  const eventId = str(raw.event_id);
  const messageId = str(raw.message_id);
  const conversationId = str(raw.conversation_id);
  const senderId = str(raw.sender_open_dingtalk_id);
  if (!eventId || !messageId || !conversationId || !senderId) return undefined;
  return {
    kind: "message",
    eventId,
    messageId,
    conversationId,
    conversationType: conversationTypeFor(key),
    senderId,
    senderName: str(raw.sender),
    content: typeof raw.content === "string" ? raw.content : "",
    mention: key === MENTION_KEY,
    receivedAt: Date.now(),
  };
}

function normalizeReaction(key: EventKey, raw: Record<string, unknown>): InboundReaction | undefined {
  const eventId = str(raw.event_id);
  const messageId = str(raw.message_id);
  const conversationId = str(raw.conversation_id);
  const operatorId = str(raw.operator_open_dingtalk_id);
  if (!eventId || !messageId || !conversationId || !operatorId) return undefined;
  void key;
  return {
    kind: "reaction",
    eventId,
    messageId,
    conversationId,
    operatorId,
    emoji: str(raw.reaction_name) ?? "",
    operation: normalizeOperation(raw.operation_type),
    receivedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Dedupe (eventId+messageId), persisted LRU capped at DEDUPE_MAX
// ---------------------------------------------------------------------------

class DedupeStore {
  private seen = new Map<string, true>();
  // Plain fields, not constructor parameter properties: Node strips types
  // from these sources at load time and cannot transform that syntax.
  private readonly file: string;
  private readonly max: number;

  constructor(file: string, max: number) {
    this.file = file;
    this.max = max;
    this.load();
  }

  private load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) {
        for (const k of raw) if (typeof k === "string") this.seen.set(k, true);
      }
    } catch {
      // missing or corrupt file: start empty
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.seen.keys()]));
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  add(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.set(key, true);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.persist();
  }
}

// ---------------------------------------------------------------------------
// Liveness + gap marker
// ---------------------------------------------------------------------------

function touchLastEventAt(): void {
  mkdirSync(paths.var, { recursive: true });
  writeFileSync(paths.lastEventAt, String(Date.now()));
}

function logGapMarker(key: EventKey): void {
  const detail = `dws consumer (re)start for ${key} — no offline replay, events during downtime are lost`;
  console.error(`[dws] ${detail}`);
  mkdirSync(paths.var, { recursive: true });
  appendFileSync(gapMarkerPath, `${new Date().toISOString()} ${detail}\n`);
}

// ---------------------------------------------------------------------------
// Mention dedupe: same messageId arrives on `_at` and `_group_all`; mention wins
// ---------------------------------------------------------------------------

interface PendingGroupAll {
  timer: ReturnType<typeof setTimeout>;
}

interface MentionState {
  pendingGroupAll: Map<string, PendingGroupAll>;
  recentlyMentioned: Map<string, ReturnType<typeof setTimeout>>;
}

function handleMessageEvent(msg: InboundMessage, onEvent: (ev: InboundEvent) => void, state: MentionState): void {
  if (msg.mention) {
    const pending = state.pendingGroupAll.get(msg.messageId);
    if (pending) {
      clearTimeout(pending.timer);
      state.pendingGroupAll.delete(msg.messageId);
    }
    onEvent(msg);
    const existingCleanup = state.recentlyMentioned.get(msg.messageId);
    if (existingCleanup) clearTimeout(existingCleanup);
    const cleanup = setTimeout(() => state.recentlyMentioned.delete(msg.messageId), MENTION_DEBOUNCE_MS * 4);
    cleanup.unref?.();
    state.recentlyMentioned.set(msg.messageId, cleanup);
    return;
  }

  // DMs (`_o2o`) have no `_at` sibling — never debounce them.
  if (msg.conversationType === "dm") {
    onEvent(msg);
    return;
  }

  // Non-mention group message (`_group_all`). A sibling `_at` event may
  // still be in flight — wait briefly before flushing as a non-mention.
  if (state.recentlyMentioned.has(msg.messageId)) return; // mention already won
  if (state.pendingGroupAll.has(msg.messageId)) return; // already buffered
  const timer = setTimeout(() => {
    state.pendingGroupAll.delete(msg.messageId);
    onEvent(msg);
  }, MENTION_DEBOUNCE_MS);
  timer.unref?.();
  state.pendingGroupAll.set(msg.messageId, { timer });
}

function handleRawLine(
  key: EventKey,
  line: string,
  onEvent: (ev: InboundEvent) => void,
  dedupe: DedupeStore,
  mentionState: MentionState,
): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  touchLastEventAt();

  if (isReactionKey(key)) {
    const reaction = normalizeReaction(key, raw);
    if (!reaction) return;
    const dedupeKey = `${reaction.eventId}:${reaction.messageId}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);
    onEvent(reaction);
    return;
  }

  const msg = normalizeMessage(key, raw);
  if (!msg) return;
  const dedupeKey = `${msg.eventId}:${msg.messageId}`;
  if (dedupe.has(dedupeKey)) return;
  dedupe.add(dedupeKey);
  handleMessageEvent(msg, onEvent, mentionState);
}

// ---------------------------------------------------------------------------
// Consumers: one child per event key, supervised with exponential backoff
// ---------------------------------------------------------------------------

interface ConsumerState {
  stopped: boolean;
  child?: ChildProcess;
  /** Set while the loop waits out its backoff; calling it ends that wait early
   * so shutdown does not block for up to BACKOFF_MAX_MS. */
  wake?: () => void;
}

async function runConsumer(
  cfg: Config,
  key: EventKey,
  onEvent: (ev: InboundEvent) => void,
  state: ConsumerState,
  dedupe: DedupeStore,
  mentionState: MentionState,
): Promise<void> {
  let backoffMs = BACKOFF_MIN_MS;
  while (!state.stopped) {
    logGapMarker(key);
    // Pass process.env explicitly so runtime changes (tests set FAKE_DWS_*
    // env vars after this process started) reach the child.
    const child = spawn(cfg.dwsBin, ["event", "consume", key, "--flatten", "-f", "ndjson"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    state.child = child;
    let sawLine = false;
    if (child.stdout) {
      // readline does the NDJSON line framing, and its internal decoder
      // buffers any multibyte sequence split across a pipe chunk boundary
      // rather than corrupting it — message text is very often CJK.
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line) return;
        handleRawLine(key, line, onEvent, dedupe, mentionState);
        sawLine = true;
        backoffMs = BACKOFF_MIN_MS;
      });
    }
    // "close" fires once the process ended AND stdout drained, so every line
    // above has been handled by then. A missing or unrunnable dws binary
    // surfaces as "error" instead — treat it like a crashed child so the
    // supervisor backs off and retries rather than throwing.
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    state.child = undefined;
    if (state.stopped) break;
    if (!sawLine) backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    // Interruptible backoff: stopConsuming() calls state.wake to end the wait
    // immediately, then the `while` condition stops the loop. The executor
    // runs synchronously, so there is no window where stopConsuming() can
    // miss the hook after the `state.stopped` check above.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs);
      state.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    state.wake = undefined;
  }
}

// ---------------------------------------------------------------------------
// One-shot dws invocations
// ---------------------------------------------------------------------------

async function runOnce(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // See the comment in runConsumer: env must be passed explicitly.
  const [bin, ...rest] = argv;
  return await new Promise((resolve) => {
    const child = spawn(bin ?? "", rest, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (err: Error) => resolve({ exitCode: -1, stdout, stderr: stderr + err.message }));
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function extractMessageId(stdout: string): string | undefined {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] ?? "") as Record<string, unknown>;
      const id = obj.message_id ?? obj.messageId ?? obj.id;
      if (typeof id === "string") return id;
      if (typeof id === "number") return String(id);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** A message id comes from dws — never interpolate it raw into a path. Dots are
 * not in the allowlist, so no id can produce `.`, `..`, or a hidden name. */
function messageDirName(messageId: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  return safe.length > 0 ? safe : "unknown-message";
}

// ---------------------------------------------------------------------------
// Paced global FIFO send queue
// ---------------------------------------------------------------------------

class SendQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private lastSpawnAt = 0;

  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  push<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;
      const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastSpawnAt));
      if (wait > 0) await sleep(wait);
      this.lastSpawnAt = Date.now();
      await task();
    }
    this.processing = false;
  }
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export function createDws(cfg: Config): DwsPort {
  const dedupe = new DedupeStore(paths.dedupe, DEDUPE_MAX);
  const mentionState: MentionState = { pendingGroupAll: new Map(), recentlyMentioned: new Map() };
  const sendQueue = new SendQueue(cfg.pacing.sendIntervalMs);
  const consumers = new Map<EventKey, ConsumerState>();
  let consumerLoops: Promise<void>[] = [];

  return {
    async startConsuming(onEvent) {
      for (const key of EVENT_KEYS) {
        const state: ConsumerState = { stopped: false };
        consumers.set(key, state);
        consumerLoops.push(runConsumer(cfg, key, onEvent, state, dedupe, mentionState));
      }
    },

    async stopConsuming() {
      for (const state of consumers.values()) {
        state.stopped = true;
        state.child?.kill();
        // Wake a loop parked in its backoff wait. `stopped` is already set, so
        // it cannot respawn a child — it just leaves the loop.
        state.wake?.();
      }
      await Promise.allSettled(consumerLoops);
      consumers.clear();
      consumerLoops = [];
      // Drop pending mention-debounce timers so a buffered _group_all
      // message can't fire onEvent after stopConsuming() has resolved.
      for (const pending of mentionState.pendingGroupAll.values()) clearTimeout(pending.timer);
      mentionState.pendingGroupAll.clear();
      for (const cleanup of mentionState.recentlyMentioned.values()) clearTimeout(cleanup);
      mentionState.recentlyMentioned.clear();
    },

    async sendText(conversationId, conversationType, text) {
      return sendQueue.push(async () => {
        const argv =
          conversationType === "group"
            ? [cfg.dwsBin, "chat", "+messages-send", "--as", "user", "--group", conversationId, "--text", text]
            : [
                cfg.dwsBin,
                "chat",
                "+messages-send",
                "--as",
                "user",
                "--open-dingtalk-id",
                conversationId,
                "--text",
                text,
              ];
        const result = await runOnce(argv);
        if (result.exitCode !== 0) {
          throw new Error(`dws sendText failed (exit ${result.exitCode}): ${result.stderr}`);
        }
        return { messageId: extractMessageId(result.stdout) };
      });
    },

    async downloadMedia(conversationId, conversationType, messageId, destDir) {
      mkdirSync(destDir, { recursive: true });
      // Download into a fresh dir so the result is "what this call fetched",
      // not "what was not in destDir already" — otherwise a second fetch in a
      // conversation returns nothing. mkdtemp inside destDir keeps the later
      // rename on one filesystem.
      const staging = mkdtempSync(join(destDir, ".dl-"));
      try {
        const argv = [
          cfg.dwsBin,
          "chat",
          "+chat-messages",
          ...(conversationType === "group" ? ["--group", conversationId] : ["--open-dingtalk-id", conversationId]),
          "--download-resources",
          "--output-dir",
          staging,
        ];
        const result = await runOnce(argv);
        if (result.exitCode !== 0) {
          throw new Error(`dws downloadMedia failed (exit ${result.exitCode}): ${result.stderr}`);
        }
        // HONEST LIMITATION: dws has no per-message download — this fetches the
        // conversation's attachments. messageId only scopes the destination, so
        // the files here may belong to other messages of the conversation.
        const messageDir = join(destDir, messageDirName(messageId));
        mkdirSync(messageDir, { recursive: true });
        return readdirSync(staging).map((name) => {
          const target = join(messageDir, name);
          rmSync(target, { recursive: true, force: true }); // a re-fetch replaces the older copy
          renameSync(join(staging, name), target);
          return target;
        });
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },

    async exportDoc(docUrl, destFile) {
      const argv = [cfg.dwsBin, "doc", "+export", "--node", docUrl, "--export-format", "markdown", "--output", destFile];
      const result = await runOnce(argv);
      if (result.exitCode !== 0) {
        throw new Error(`dws exportDoc failed (exit ${result.exitCode}): ${result.stderr}`);
      }
    },

    async doctor() {
      try {
        const result = await runOnce([cfg.dwsBin, "auth", "status"]);
        if (result.exitCode === 0) {
          return { ok: true, detail: result.stdout.trim() || "ok" };
        }
        return { ok: false, detail: result.stderr.trim() || `exit ${result.exitCode}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
