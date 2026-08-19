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
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(8787),
    })
    .prefault({}),
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

export type Boilerplate = "general" | "qa-cs" | "project" | "dev-mgmt";

export interface WorkspaceMeta {
  conversationId: string;
  conversationType: ConversationType;
  dir: string; // absolute path under workspaces/
  boilerplate: Boilerplate;
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
  | { tool: "set_workspace"; conversationId: string; senderId: string; patch: Partial<Pick<WorkspaceMeta, "boilerplate" | "editors" | "owner" | "multimodal" | "digestsEnabled" | "modelOverride">> }
  | { tool: "memory_admin"; conversationId: string; senderId: string; op: "list" | "read" | "write" | "delete"; name?: string; content?: string }
  | { tool: "ops"; conversationId: string; senderId: string; op: "status" | "spend" | "tasks" | "retry_task" | "pause_workspace" | "resume_workspace"; target?: string };

export interface ToolResponse {
  ok: boolean;
  /** Human-readable result the agent can relay. */
  message: string;
  data?: unknown;
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
  }): Promise<{ text: string; ok: boolean; error?: string }>;
}

/** Daily session id shared by runner + nightly reset: <YYYY-MM-DD> in cfg.timezone. */
export function dailySessionId(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(date);
}
