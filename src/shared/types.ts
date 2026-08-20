/**
 * Shared contracts for doushabao. READ-ONLY for module implementers:
 * if a contract change is needed, request it in your final report — do not edit.
 *
 * Binding decisions from docs/brainstorming/*.content.json are encoded here as
 * types and config defaults so they cannot be silently dropped:
 *  - no shell/exec tools in agent workspaces (tools are curated, fixed-argv)
 *  - deterministic authz on DingTalk sender/operator IDs, never model judgment
 *  - requester one-tap confirm on writes affecting colleagues
 *  - reaction approvals count only from authorized operator IDs, add-ops only
 *  - doc reads scoped to links shared in the same conversation
 *  - fresh-daily sessions; nightly distillation uses the STRONG model (the one
 *    exception to cheap-everywhere)
 *  - paced outbound sends; per-workspace daily budgets; 30-day retention
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config (config/doushabao.json). Everything has a default; file may be sparse.
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  /** open_dingtalk_ids of global admins (can do everything everywhere). */
  admins: z.array(z.string()).default([]),
  timezone: z.string().default("Asia/Shanghai"),
  dwsBin: z.string().default("dws"),
  piBin: z.string().default("pi"),
  models: z
    .object({
      /** Cheap default for all workspace runs (pi --model pattern). */
      default: z.string().default(""),
      /** Strong model for nightly distillation/handoff. Empty = use default. */
      distillation: z.string().default(""),
      /** Vision-capable model for multimodal-enabled workspaces. */
      vision: z.string().default(""),
    })
    .prefault({}),
  http: z
    .object({
      /** Loopback ONLY, and enforced rather than merely defaulted: the /tool
       * endpoint is the agent's whole authority surface. A config typo of
       * "0.0.0.0" would put it on the LAN behind nothing but a bearer token. */
      host: z
        .string()
        .default("127.0.0.1")
        .refine((h) => ["127.0.0.1", "::1", "localhost"].includes(h), {
          message: 'http.host must be loopback ("127.0.0.1", "::1" or "localhost") — the tool API is never exposed off-box',
        }),
      port: z.number().int().default(8787),
    })
    .prefault({}),
  /** Hosts `doc_read` may fetch from. An empty list means "no doc reading".
   * doc_read hands a URL to the dws binary, so an unconstrained host here is
   * an outbound fetch to anywhere, with the response echoed back into chat. */
  docHosts: z.array(z.string()).default(["alidocs.dingtalk.com", "docs.dingtalk.com"]),
  pacing: z
    .object({
      /** Minimum ms between outbound sends (global queue). */
      sendIntervalMs: z.number().int().default(3500),
    })
    .prefault({}),
  budgets: z
    .object({
      perWorkspaceDailyRuns: z.number().int().default(200),
      perUserDailyRuns: z.number().int().default(60),
      writesPerWorkspacePerHour: z.number().int().default(20),
      /** How many delegated background tasks run at once across all
       * conversations. Foreground message replies are on a separate path, so
       * this only bounds background work — raise it for busy deployments. */
      maxConcurrentTasks: z.number().int().default(3),
    })
    .prefault({}),
  caps: z
    .object({
      pendingQuestionsPerConversation: z.number().int().default(3),
      pendingQuestionTtlHours: z.number().int().default(24),
      mediaMaxBytes: z.number().int().default(20 * 1024 * 1024),
      transcriptTailLines: z.number().int().default(80),
    })
    .prefault({}),
  retention: z
    .object({
      transcriptDays: z.number().int().default(30),
      mediaDays: z.number().int().default(7),
    })
    .prefault({}),
  heartbeat: z
    .object({
      /** Alert if zero inbound events for this many minutes inside work hours. */
      quietMinutes: z.number().int().default(90),
      workHours: z
        .object({
          start: z.number().int().default(9),
          end: z.number().int().default(19),
          /** 0=Sun..6=Sat */
          days: z.array(z.number().int()).default([1, 2, 3, 4, 5]),
        })
        .prefault({}),
    })
    .prefault({}),
  nightly: z
    .object({
      /** Local hour for distillation + session reset + retention cleanup. */
      hour: z.number().int().default(3),
    })
    .prefault({}),
  /** Extra pi extensions to load into every workspace agent — web search, MCP,
   * etc. Each is loaded by explicit `path` (never inherited via discovery), and
   * ONLY the tool names listed in `tools` are allowed through the fail-closed
   * `-t` allowlist. MCP tool names are dynamic per server, so you must list the
   * exact ones you want exposed. SECURITY: every tool here is reachable by a
   * prompt-injected, chat-facing agent — web tools are an egress channel, MCP
   * tools are whatever the server exposes. Empty by default. */
  piExtraExtensions: z
    .array(
      z.object({
        path: z.string(),
        tools: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** Version the workspace tree (one dir per group chat) as its own git repo.
   * The daemon commits coalesced snapshots on a timer — NEVER per message —
   * off the message path, and pushes to `remote` on a slower timer. Commit
   * messages are templated, never chat content. */
  workspacesGit: z
    .object({
      enabled: z.boolean().default(false),
      /** Private remote to push to. Empty = commit locally, never push.
       * MUST be a private repo: the tree contains full chat transcripts and
       * downloaded attachments. */
      remote: z.string().default(""),
      /** How often to check for changes and commit them, in ms. */
      commitIntervalMs: z.number().int().default(20_000),
      /** How often to push accumulated commits, in ms. */
      pushIntervalMs: z.number().int().default(300_000),
      authorName: z.string().default("doushabao"),
      authorEmail: z.string().default("doushabao@localhost"),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Inbound events (normalized from dws NDJSON; adapter owns raw parsing)
// ---------------------------------------------------------------------------

export type ConversationType = "dm" | "group";

export interface InboundMessage {
  kind: "message";
  eventId: string;
  messageId: string;
  conversationId: string;
  conversationType: ConversationType;
  senderId: string; // sender_open_dingtalk_id
  senderName?: string;
  content: string; // plain text; media events carry only a description
  /** True when this arrived on the @-mention event key. */
  mention: boolean;
  quoted?: string;
  receivedAt: number;
}

export interface InboundReaction {
  kind: "reaction";
  eventId: string;
  messageId: string; // message that was reacted to
  conversationId: string;
  operatorId: string; // operator_open_dingtalk_id — authz uses THIS
  emoji: string; // reaction_name
  /** Only "add" operations may answer questions/approvals. */
  operation: "add" | "remove" | "unknown";
  receivedAt: number;
}

export type InboundEvent = InboundMessage | InboundReaction;

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type Expert = "general" | "qa-cs" | "project" | "dev-mgmt" | "debug";

export const EXPERTS: readonly Expert[] = ["general", "qa-cs", "project", "dev-mgmt", "debug"];

export interface WorkspaceMeta {
  conversationId: string;
  conversationType: ConversationType;
  dir: string; // absolute path under workspaces/
  expert: Expert;
  title?: string;
  /** Per-workspace editors: may inject KB answers, manage this workspace's cron. */
  editors: string[];
  /** Named human owner for escalation (open_dingtalk_id). */
  owner?: string;
  /** Multimodal (vision model) enabled for this workspace. */
  multimodal: boolean;
  digestsEnabled: boolean;
  modelOverride?: string;
  createdAt: number;
  greeted: boolean;
  /** Admin kill switch: transcripts are still recorded, but no run is started
   * for this workspace (messages, cron jobs, delegated tasks). */
  paused?: boolean;
}

// ---------------------------------------------------------------------------
// Durable orchestrator state (JSON files under var/ — inspectable)
// ---------------------------------------------------------------------------

export interface DelegatedTask {
  id: string;
  conversationId: string;
  requesterId: string;
  /** Original request verbatim — completion must be composable after the
   * midnight session reset with no other context. */
  requestText: string;
  status: "queued" | "running" | "done" | "failed" | "announced";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  error?: string;
}

export interface CronJob {
  id: string;
  conversationId: string;
  /** Standard 5/6-field cron expression, validated by croner at creation. */
  cronExpr: string;
  /** Natural-language description shown to users. */
  description: string;
  /** Prompt run in the owning workspace when the job fires. */
  prompt: string;
  createdBy: string;
  createdAt: number;
  enabled: boolean;
  lastFiredAt?: number;
}

export type ApproverScope = "requester" | "editors" | "admins";

export interface PendingQuestion {
  id: string;
  conversationId: string;
  /** messageId of the posted options message, once sent (reactions target it). */
  postedMessageId?: string;
  question: string;
  options: string[]; // 2..4
  /** Applied when the question expires unanswered. Index into options, or -1 = drop. */
  defaultOption: number;
  purpose: "question" | "approval";
  approverScope: ApproverScope;
  /** For approverScope "requester": the only ID allowed to answer. */
  requesterId: string;
  /** Action payload executed on approval (approval purpose only). */
  onApprove?: ToolRequest;
  status: "open" | "answered" | "expired";
  answer?: { option: number; freeText?: string; answeredBy: string; at: number };
  createdAt: number;
  expiresAt: number;
}

export interface KbEntry {
  id: string;
  question: string;
  answer: string;
  scope: "workspace" | "global";
  conversationId?: string; // set when scope=workspace
  injectedBy: string;
  injectedAt: number;
  revoked: boolean;
}

export interface AuditEntry {
  ts: number;
  actor: string; // open_dingtalk_id or "system"
  action: string;
  conversationId?: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// IPC: pi workspace extension -> orchestrator HTTP API
// POST http://127.0.0.1:<port>/tool  Authorization: Bearer <var/ipc-token>
// The extension injects senderId/conversationId from env vars set by the
// runner (DOUSHABAO_CONVERSATION, DOUSHABAO_SENDER) — the model cannot forge
// them because the tool schemas do not accept identity parameters.
// ---------------------------------------------------------------------------

export type ToolRequest =
  | { tool: "send_message"; conversationId: string; senderId: string; text: string }
  | {
      tool: "ask_user";
      conversationId: string;
      senderId: string;
      question: string;
      options: string[];
      defaultOption: number;
      purpose: "question" | "approval";
      approverScope: ApproverScope;
    }
  | { tool: "delegate_async"; conversationId: string; senderId: string; requestText: string }
  | {
      tool: "schedule_job";
      conversationId: string;
      senderId: string;
      cronExpr: string;
      description: string;
      prompt: string;
    }
  | { tool: "cancel_job"; conversationId: string; senderId: string; jobId: string }
  | { tool: "list_jobs"; conversationId: string; senderId: string }
  | { tool: "kb_save"; conversationId: string; senderId: string; question: string; answer: string }
  | { tool: "kb_promote"; conversationId: string; senderId: string; kbId: string }
  | { tool: "kb_revoke"; conversationId: string; senderId: string; kbId: string }
  | { tool: "flag_unanswered"; conversationId: string; senderId: string; question: string }
  | { tool: "escalate"; conversationId: string; senderId: string; question: string; context: string }
  | {
      tool: "worktool";
      conversationId: string;
      senderId: string;
      /** Curated action name, e.g. "todo_create", "calendar_create", "doc_read". */
      action: string;
      params: Record<string, unknown>;
    }
  | { tool: "set_workspace"; conversationId: string; senderId: string; patch: Partial<Pick<WorkspaceMeta, "expert" | "editors" | "owner" | "multimodal" | "digestsEnabled" | "modelOverride">> }
  | { tool: "memory_admin"; conversationId: string; senderId: string; op: "list" | "read" | "write" | "delete"; name?: string; content?: string }
  | { tool: "ops"; conversationId: string; senderId: string; op: "status" | "spend" | "tasks" | "retry_task" | "pause_workspace" | "resume_workspace"; target?: string };

export interface ToolResponse {
  ok: boolean;
  /** Human-readable result the agent can relay. */
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Expert profiles — WHICH tools exist in a workspace.
//
// This is capability, not authority. The permission tier (admins / editors /
// requester) is enforced separately in src/api and applies on top: a tool can
// be present in the profile and still be refused to the caller. Both checks
// run, because they answer different questions — "does this room have this
// tool at all" vs "may you use it".
//
// Enforced in two places on purpose:
//  1. src/pi passes `-t <names>` so the model never SEES an out-of-profile
//     tool. That is the real boundary; it also shortens every prompt.
//  2. src/api re-checks each request against the workspace's expert, so the
//     audit log is honest even if something reached the socket another way.
// ---------------------------------------------------------------------------

export type ToolVerb = ToolRequest["tool"];

/** IPC verb → the pi tool name the workspace extension registers for it. */
export const TOOL_NAMES: Record<ToolVerb, string> = {
  send_message: "doushabao_send",
  ask_user: "doushabao_ask",
  delegate_async: "doushabao_delegate",
  schedule_job: "doushabao_schedule_job",
  cancel_job: "doushabao_cancel_job",
  list_jobs: "doushabao_list_jobs",
  kb_save: "doushabao_kb_save",
  kb_promote: "doushabao_kb_promote",
  kb_revoke: "doushabao_kb_revoke",
  flag_unanswered: "doushabao_flag_unanswered",
  escalate: "doushabao_escalate",
  worktool: "doushabao_worktool",
  set_workspace: "doushabao_set_workspace",
  memory_admin: "doushabao_memory",
  ops: "doushabao_ops",
};

export interface ExpertProfile {
  tools: ToolVerb[];
  /** Curated `worktool` actions this expert may run. Empty = none, and then
   * `worktool` should not appear in `tools` either. */
  worktools: string[];
}

/** The safety valves every expert keeps, whatever else it is for: it must
 * always be able to answer, ask a human, escalate, and admit a gap. */
// Safety valves + management. `set_workspace` and `ops` are here, in EVERY
// profile, on purpose: they are how a room is reconfigured or repaired, so
// gating them by the room's own expert would deadlock — every room is created
// `general`, and set_workspace is the only way to change that. They are
// AUTHORITY operations, governed by the admin/editor tier check in src/api,
// not by the capability profile. The profile still governs the persona tools
// below (delegate, kb, schedule, worktool actions).
const BASE_TOOLS: ToolVerb[] = ["send_message", "ask_user", "escalate", "flag_unanswered", "list_jobs", "memory_admin", "set_workspace", "ops"];
/** Read-only DingTalk actions; safe enough to be near-universal. */
const READ_WORKTOOLS = ["doc_read", "media_fetch"];

export const EXPERT_PROFILES: Record<Expert, ExpertProfile> = {
  general: {
    tools: [...BASE_TOOLS, "delegate_async", "worktool"],
    worktools: [...READ_WORKTOOLS],
  },
  "qa-cs": {
    tools: [...BASE_TOOLS, "delegate_async", "worktool", "kb_save", "kb_promote", "kb_revoke"],
    worktools: [...READ_WORKTOOLS],
  },
  project: {
    tools: [...BASE_TOOLS, "delegate_async", "worktool", "schedule_job", "cancel_job"],
    worktools: [...READ_WORKTOOLS, "todo_create", "calendar_create", "report_create"],
  },
  "dev-mgmt": {
    tools: [...BASE_TOOLS, "delegate_async", "worktool", "schedule_job", "cancel_job"],
    worktools: [...READ_WORKTOOLS, "todo_create", "calendar_create", "report_create"],
  },
  // Diagnosis must not have side effects: no kb writes, no todos, no invites,
  // no delegated work — read-only over the ops/status surface.
  debug: {
    tools: [...BASE_TOOLS],
    worktools: [],
  },
};

/** Falls back to `general` for anything unrecognised, because `expert` is read
 * from workspace.json on disk and may predate a rename. */
export function expertProfile(expert: Expert | string | undefined): ExpertProfile {
  return EXPERT_PROFILES[expert as Expert] ?? EXPERT_PROFILES.general;
}

/** pi tool names for this expert — pass straight to `pi -t <names>`. */
export function expertToolNames(expert: Expert | string | undefined): string[] {
  return expertProfile(expert).tools.map((verb) => TOOL_NAMES[verb]);
}

export function expertAllowsTool(expert: Expert | string | undefined, verb: ToolVerb): boolean {
  return expertProfile(expert).tools.includes(verb);
}

export function expertAllowsAction(expert: Expert | string | undefined, action: string): boolean {
  return expertProfile(expert).worktools.includes(action);
}

// ---------------------------------------------------------------------------
// Ports (module boundaries; implementations live in the owning module)
// ---------------------------------------------------------------------------

/** src/dws — the only module that spawns the dws binary. Always fixed argv arrays. */
export interface DwsPort {
  /** Start consumers (one child per event key), invoke onEvent for each
   * normalized event, supervise and restart with backoff, dedupe by eventId+messageId. */
  startConsuming(onEvent: (ev: InboundEvent) => void): Promise<void>;
  stopConsuming(): Promise<void>;
  /** Send text/markdown as the logged-in user. Callers go through the paced queue. */
  sendText(conversationId: string, conversationType: ConversationType, text: string): Promise<{ messageId?: string }>;
  /** Download a conversation's attachments into destDir. conversationType
   * picks the dws selector (--group vs --open-dingtalk-id), exactly as
   * sendText does. NOTE: dws has no per-message download, so messageId only
   * scopes/labels the destination — the fetch itself is conversation-wide. */
  downloadMedia(conversationId: string, conversationType: ConversationType, messageId: string, destDir: string): Promise<string[]>;
  /** Export a DingTalk doc URL to markdown. */
  exportDoc(docUrl: string, destFile: string): Promise<void>;
  /** Health probe (auth ok / reachable). */
  doctor(): Promise<{ ok: boolean; detail: string }>;
}

/** src/pi — the only module that spawns the pi binary. */
export interface PiRunnerPort {
  /** One-shot run in the workspace dir, resuming the given session id.
   * Returns the agent's final text. env carries DOUSHABAO_* identity vars. */
  run(opts: {
    workspaceDir: string;
    sessionId: string;
    prompt: string;
    model?: string;
    env: Record<string, string>;
    timeoutMs?: number;
    /** pi tool names (see TOOL_NAMES) this run may use. REQUIRED and
     * fail-closed: a non-empty list becomes `-t a,b,c`; an empty list becomes
     * `-nt` (no tools at all). Pass `expertToolNames(meta.expert)` for a normal
     * run, or `[]` for a deliberately tool-less one (e.g. nightly distillation)
     * — never omit it, so "no value" can never mean "all tools". */
    tools: string[];
  }): Promise<{ text: string; ok: boolean; error?: string }>;
}

/** Daily session id shared by runner + nightly reset: <YYYY-MM-DD> in cfg.timezone. */
export function dailySessionId(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(date);
}
