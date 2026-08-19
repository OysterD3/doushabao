/**
 * src/router — routes inbound DingTalk events to per-conversation FIFO agent
 * runs, and dispatches replies. See ARCHITECTURE.md's router row + this
 * file's exported types for the module contract.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  dailySessionId,
  type Config,
  type ConversationType,
  type DwsPort,
  type InboundEvent,
  type InboundMessage,
  type PiRunnerPort,
  type WorkspaceMeta,
} from "../shared/types.ts";
import { wsPaths } from "../shared/paths.ts";

/** A single appended transcript line, as the workspace registry stores it. */
export interface WorkspaceTranscriptEntry {
  ts: number;
  senderId: string;
  senderName?: string;
  text: string;
}

/**
 * Shape of the real WorkspaceRegistry (src/workspace/index.ts). createRouter's
 * public deps type `workspaces` as `any` per the module contract, but this is
 * the interface the router actually calls — mirrored (not imported) here
 * because cross-module type imports are restricted to Ports in
 * shared/types.ts, and WorkspaceRegistry isn't one. See the router module's
 * final report for a request to promote this to a shared Port.
 */
export interface WorkspaceRegistryLike {
  /** Creates the workspace (from the "general" boilerplate) on first contact. */
  getOrCreate(conversationId: string, conversationType: ConversationType): Promise<{ meta: WorkspaceMeta; created: boolean }>;
  /** Look up an existing workspace's meta; undefined if none exists yet. */
  get(conversationId: string): WorkspaceMeta | undefined;
  /** Partial meta update (used here to set greeted:true after the greeting send). */
  patchMeta(conversationId: string, patch: Partial<WorkspaceMeta>): Promise<WorkspaceMeta>;
  /** Appends one transcript line. */
  appendTranscript(conversationId: string, entry: WorkspaceTranscriptEntry): Promise<void>;
  /** Last `n` transcript lines, pre-formatted for prompt inclusion. */
  transcriptTail(conversationId: string, n: number): Promise<string[]>;
  /** Shared + workspace-overlay KB, formatted for prompt inclusion. */
  kbDigest(conversationId: string): Promise<string>;
}

export interface RouterDeps {
  cfg: Config;
  dws: DwsPort;
  runner: PiRunnerPort;
  /** WorkspaceRegistry from src/workspace; see WorkspaceRegistryLike above. */
  workspaces: any;
  /** IPC values handed to each pi run's env (DOUSHABAO_API / DOUSHABAO_TOKEN). */
  ipc: { api: string; token: string };
  /** Quick-ack delay override for tests; defaults to 8000ms. */
  quickAckMs?: number;
}

export interface RunOpts {
  senderId?: string;
  model?: string;
  /** Default false. The message-trigger path passes true; cron/tasks omit it (confirmed: src/tasks calls enqueueRun with `{}`), which stays quiet. */
  ack?: boolean;
}

export interface Router {
  handleEvent(ev: InboundEvent): Promise<void>;
  /** Enqueues `prompt` onto conversationId's FIFO lane. Resolves once
   * enqueued, not once the run completes — results are delivered via dws. */
  enqueueRun(conversationId: string, prompt: string, opts?: RunOpts): Promise<void>;
  setPendingResolver(fn: (ev: InboundEvent) => Promise<boolean>): void;
  runCounts(): { workspaceToday: Record<string, number>; userToday: Record<string, number> };
}

const GLOBAL_RUN_CAP = 3;
/** Size cap on the recently-transcribed messageId window. Duplicate
 * deliveries land ~1s apart, so a few hundred ids is ample; the cap is what
 * keeps a process that runs for weeks from growing the set without bound. */
const TRANSCRIBED_MAX = 500;
const QUICK_ACK_TEXT = "On it — I'll post the result here.";
const APOLOGY_TEXT = "Sorry, something went wrong on my end — please try again.";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "conv";
}

function greetingText(cfg: Config): string {
  return (
    "Hi, I'm doushabao — a digital employee here to help in this conversation. " +
    "I read every message for context, but I only act when you DM me or @-mention me. " +
    `I keep this conversation's data for ${cfg.retention.transcriptDays} days, then it's deleted.`
  );
}

/** Small counting semaphore bounding global concurrent runs. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

interface QueuedRun {
  conversationId: string;
  prompt: string;
  opts: RunOpts;
}

export function createRouter(deps: RouterDeps): Router {
  const { cfg, dws, runner, ipc } = deps;
  const workspaces = deps.workspaces as WorkspaceRegistryLike;
  const quickAckMs = deps.quickAckMs ?? 8000;

  let pendingResolver: ((ev: InboundEvent) => Promise<boolean>) | undefined;

  const lanes = new Map<string, QueuedRun[]>();
  const draining = new Set<string>();
  const globalSem = new Semaphore(GLOBAL_RUN_CAP);
  /** Conversations whose greeting we've already started sending this process
   * lifetime — closes the race where two messages hit a brand-new
   * conversation before the first patchMeta(greeted:true) lands. Checked +
   * set synchronously (no await between), so concurrent handleMessage calls
   * can't both pass. Never cleared; the durable `greeted` flag covers restarts. */
  const greetingStarted = new Set<string>();
  /** conversationId:messageId of messages already appended to a transcript,
   * insertion-ordered and capped at TRANSCRIBED_MAX. The two dws consumer
   * keys can deliver one message twice — the `_at` sibling carries its own
   * event_id, so dws's eventId:messageId dedupe cannot pair it with the
   * `_group_all` copy — which would double the transcript line. Only the
   * append is skipped for a repeat; a late mention must still trigger. */
  const transcribed = new Set<string>();

  function markTranscribed(key: string): void {
    transcribed.add(key);
    while (transcribed.size > TRANSCRIBED_MAX) {
      const oldest = transcribed.values().next().value;
      if (oldest === undefined) break;
      transcribed.delete(oldest);
    }
  }

  let dayKey = dailySessionId(new Date(), cfg.timezone);
  let workspaceToday = new Map<string, number>();
  let userToday = new Map<string, number>();

  function rollDayIfNeeded(): void {
    const today = dailySessionId(new Date(), cfg.timezone);
    if (today !== dayKey) {
      dayKey = today;
      workspaceToday = new Map();
      userToday = new Map();
    }
  }

  function bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  function readHandoff(meta: WorkspaceMeta): string {
    const file = wsPaths(meta.dir).handoff;
    if (!existsSync(file)) return "";
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  async function buildPrompt(meta: WorkspaceMeta, triggerText: string): Promise<string> {
    const [kb, tail] = await Promise.all([
      workspaces.kbDigest(meta.conversationId),
      workspaces.transcriptTail(meta.conversationId, cfg.caps.transcriptTailLines),
    ]);
    const handoff = readHandoff(meta);
    return [kb, tail.join("\n"), handoff, triggerText]
      .map((p) => p.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  async function runOne(job: QueuedRun): Promise<void> {
    const meta = workspaces.get(job.conversationId);
    if (!meta) {
      console.error(`router: run requested for unknown workspace ${job.conversationId}, dropping`);
      return;
    }

    const prompt = await buildPrompt(meta, job.prompt);
    const sessionId = `${dailySessionId(new Date(), cfg.timezone)}-${slug(job.conversationId)}`;
    // A per-run model wins, then the workspace's explicit override; a
    // multimodal workspace otherwise runs on the vision model, and an
    // unconfigured (empty) vision model falls through to the default.
    const visionModel = meta.multimodal ? cfg.models.vision : "";
    const model = job.opts.model || meta.modelOverride || visionModel || cfg.models.default || undefined;
    const senderId = job.opts.senderId ?? "";

    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    if (job.opts.ack === true) {
      ackTimer = setTimeout(() => {
        dws.sendText(meta.conversationId, meta.conversationType, QUICK_ACK_TEXT).catch((err) => {
          console.error(`router: quick-ack send failed for ${meta.conversationId}`, err);
        });
      }, quickAckMs);
    }

    try {
      const result = await runner.run({
        workspaceDir: meta.dir,
        sessionId,
        prompt,
        model,
        env: {
          DOUSHABAO_API: ipc.api,
          DOUSHABAO_TOKEN: ipc.token,
          DOUSHABAO_CONVERSATION: job.conversationId,
          DOUSHABAO_SENDER: senderId,
        },
      });
      if (!result.ok) {
        await dws.sendText(meta.conversationId, meta.conversationType, APOLOGY_TEXT);
        return;
      }
      const text = result.text ?? "";
      if (text.startsWith("[SILENT]") || !text.trim()) return;
      await dws.sendText(meta.conversationId, meta.conversationType, text);
    } catch (err) {
      console.error(`router: run failed for ${job.conversationId}`, err);
      try {
        await dws.sendText(meta.conversationId, meta.conversationType, APOLOGY_TEXT);
      } catch (sendErr) {
        console.error(`router: apology send failed for ${job.conversationId}`, sendErr);
      }
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
    }
  }

  function pump(conversationId: string): void {
    if (draining.has(conversationId)) return;
    draining.add(conversationId);
    void (async () => {
      let queue = lanes.get(conversationId);
      while (queue && queue.length > 0) {
        const job = queue.shift()!;
        await globalSem.acquire();
        try {
          await runOne(job);
        } finally {
          globalSem.release();
        }
        queue = lanes.get(conversationId);
      }
      draining.delete(conversationId);
      lanes.delete(conversationId);
    })();
  }

  async function enqueueRun(conversationId: string, prompt: string, opts: RunOpts = {}): Promise<void> {
    rollDayIfNeeded();
    bump(workspaceToday, conversationId);
    if (opts.senderId) bump(userToday, opts.senderId);

    const queue = lanes.get(conversationId) ?? [];
    queue.push({ conversationId, prompt, opts });
    lanes.set(conversationId, queue);
    pump(conversationId);
  }

  async function handleMessage(ev: InboundMessage): Promise<void> {
    const { meta, created } = await workspaces.getOrCreate(ev.conversationId, ev.conversationType);

    if ((created || !meta.greeted) && !greetingStarted.has(ev.conversationId)) {
      greetingStarted.add(ev.conversationId);
      try {
        await dws.sendText(ev.conversationId, ev.conversationType, greetingText(cfg));
      } catch (err) {
        console.error(`router: greeting send failed for ${ev.conversationId}`, err);
      }
      await workspaces.patchMeta(ev.conversationId, { greeted: true });
    }

    // Checked + set synchronously (no await between), so two concurrent
    // deliveries of the same message can't both append.
    const transcriptKey = `${ev.conversationId}:${ev.messageId}`;
    if (!transcribed.has(transcriptKey)) {
      markTranscribed(transcriptKey);
      await workspaces.appendTranscript(ev.conversationId, {
        ts: ev.receivedAt,
        senderId: ev.senderId,
        senderName: ev.senderName,
        text: ev.content,
      });
    }

    // Admin kill switch. The message is recorded above (decision #9 holds for
    // a paused workspace too), but nothing below may start a run — pending
    // resolution included, since answering a pending can run the agent.
    if (meta.paused) return;

    // Binding decision #9: the transcript is logged for every group message;
    // only mentions/DMs are gated on triggering a run — not on being
    // recorded. So pending-answer consumption (which only ever gates
    // triggering, e.g. an open ask/approval's next matching reply) must be
    // checked AFTER the transcript append above, never before it.
    if (pendingResolver) {
      const consumed = await pendingResolver(ev);
      if (consumed) return;
    }

    const shouldTrigger = ev.conversationType === "dm" || ev.mention === true;
    if (!shouldTrigger) return;

    rollDayIfNeeded();
    const wsCount = workspaceToday.get(ev.conversationId) ?? 0;
    const userCount = userToday.get(ev.senderId) ?? 0;
    if (wsCount >= cfg.budgets.perWorkspaceDailyRuns) {
      console.error(`router: workspace ${ev.conversationId} over daily run budget (${wsCount}/${cfg.budgets.perWorkspaceDailyRuns})`);
      await dws.sendText(ev.conversationId, ev.conversationType, "I've hit today's reply budget for this conversation — try again tomorrow.");
      return;
    }
    if (userCount >= cfg.budgets.perUserDailyRuns) {
      console.error(`router: user ${ev.senderId} over daily run budget (${userCount}/${cfg.budgets.perUserDailyRuns})`);
      await dws.sendText(ev.conversationId, ev.conversationType, "You've hit today's reply budget with me — try again tomorrow.");
      return;
    }

    const triggerText = `${ev.senderName || ev.senderId}: ${ev.content}`;
    await enqueueRun(ev.conversationId, triggerText, { senderId: ev.senderId, ack: true });
  }

  async function handleEvent(ev: InboundEvent): Promise<void> {
    if (ev.kind === "reaction") {
      // Reactions are never transcribed, so pending resolution can run
      // directly — there's no transcript append to sequence it after.
      if (pendingResolver) await pendingResolver(ev);
      return;
    }
    await handleMessage(ev);
  }

  return {
    handleEvent,
    enqueueRun,
    setPendingResolver(fn) {
      pendingResolver = fn;
    },
    runCounts() {
      rollDayIfNeeded();
      return {
        workspaceToday: Object.fromEntries(workspaceToday),
        userToday: Object.fromEntries(userToday),
      };
    },
  };
}
