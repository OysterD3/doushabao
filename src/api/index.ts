/**
 * src/api — localhost HTTP server handling every ToolRequest from the pi
 * workspace extension. Deterministic authz on the authenticated sender ID
 * (never model judgment), pending questions + approvals (reply or reaction
 * answers), audit log.
 *
 * `workspaces`, `tasks`, `cron`, `worktools` arrive as `any` (owned by other
 * modules, wired in src/index.ts). This file casts them to small local
 * interfaces (below) describing exactly the methods this module calls —
 * that surface is the expected contract and is restated in full in the
 * final report.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { z } from "zod";
import { paths } from "../shared/paths.ts";
import type {
  ApproverScope,
  AuditEntry,
  Config,
  CronJob,
  DwsPort,
  Expert,
  InboundEvent,
  KbEntry,
  PendingQuestion,
  ToolRequest,
  ToolResponse,
  WorkspaceMeta,
} from "../shared/types.ts";
import { EXPERTS, expertAllowsTool } from "../shared/types.ts";
import { canApprove, emojiToOption, isAdmin, isEditor, matchReply } from "./authz.ts";
import { listPending, openPendingsFor, savePending } from "./pending.ts";

// ---------------------------------------------------------------------------
// Runtime shape of a ToolRequest
//
// The compile-time union in shared/types.ts is erased at load, so without this
// the JSON body of POST /tool reached every handler unchecked — and that body
// is reachable from anything a person can type in chat or hide in a document
// the bot reads. Validate before dispatch, and dispatch the PARSED value, so
// an unknown field cannot ride along into patchMeta or a worktool.
//
// `senderId` is required but MAY be the empty string: a run resumed from an
// answered pending deliberately carries no identity (see applyAnswer), and
// authz treats "" as unprivileged rather than rejecting the call.
// ---------------------------------------------------------------------------

const common = { conversationId: z.string().min(1), senderId: z.string() };
const approverScope = z.enum(["requester", "editors", "admins"]);

const ToolRequestSchema = z.discriminatedUnion("tool", [
  z.object({ ...common, tool: z.literal("send_message"), text: z.string() }),
  z.object({
    ...common,
    tool: z.literal("ask_user"),
    question: z.string(),
    options: z.array(z.string()),
    defaultOption: z.number().int(),
    purpose: z.enum(["question", "approval"]),
    approverScope,
  }),
  z.object({ ...common, tool: z.literal("delegate_async"), requestText: z.string() }),
  z.object({ ...common, tool: z.literal("schedule_job"), cronExpr: z.string(), description: z.string(), prompt: z.string() }),
  z.object({ ...common, tool: z.literal("cancel_job"), jobId: z.string() }),
  z.object({ ...common, tool: z.literal("list_jobs") }),
  z.object({ ...common, tool: z.literal("kb_save"), question: z.string(), answer: z.string() }),
  z.object({ ...common, tool: z.literal("kb_promote"), kbId: z.string() }),
  z.object({ ...common, tool: z.literal("kb_revoke"), kbId: z.string() }),
  z.object({ ...common, tool: z.literal("flag_unanswered"), question: z.string() }),
  z.object({ ...common, tool: z.literal("escalate"), question: z.string(), context: z.string() }),
  z.object({ ...common, tool: z.literal("worktool"), action: z.string(), params: z.record(z.string(), z.unknown()) }),
  z.object({
    ...common,
    tool: z.literal("set_workspace"),
    // .strict(): an unlisted key is refused loudly, not stripped silently.
    // Only these six fields are a workspace setting — `dir`, for one, is
    // where this workspace's files live.
    patch: z
      .object({
        expert: z.enum(EXPERTS as readonly [Expert, ...Expert[]]).optional(),
        editors: z.array(z.string()).optional(),
        owner: z.string().optional(),
        multimodal: z.boolean().optional(),
        digestsEnabled: z.boolean().optional(),
        modelOverride: z.string().optional(),
      })
      .strict(),
  }),
  z.object({
    ...common,
    tool: z.literal("memory_admin"),
    op: z.enum(["list", "read", "write", "delete"]),
    name: z.string().optional(),
    content: z.string().optional(),
  }),
  z.object({
    ...common,
    tool: z.literal("ops"),
    op: z.enum(["status", "spend", "tasks", "retry_task", "pause_workspace", "resume_workspace"]),
    target: z.string().optional(),
  }),
]) satisfies z.ZodType<ToolRequest, unknown>;

/** Parse an untrusted value into a ToolRequest, or say why not. */
function parseToolRequest(value: unknown): { ok: true; req: ToolRequest } | { ok: false; message: string } {
  const parsed = ToolRequestSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".");
    return { ok: false, message: `invalid tool request${where ? ` at "${where}"` : ""}: ${first?.message ?? "unknown field"}` };
  }
  return { ok: true, req: parsed.data as ToolRequest };
}

// ---------------------------------------------------------------------------
// Expected contract for the other modules' ports (invented here; see report)
// ---------------------------------------------------------------------------

// Aligned against the real src/workspace, src/tasks, src/worktools and
// src/cron implementations (already present in the tree at the time this
// module was built — see final report).
interface WorkspacesPort {
  get(conversationId: string): Promise<WorkspaceMeta | undefined> | WorkspaceMeta | undefined;
  list(): WorkspaceMeta[];
  patchMeta(conversationId: string, patch: Record<string, unknown>): Promise<unknown>;
  kbSave(entry: {
    question: string;
    answer: string;
    scope: "workspace" | "global";
    conversationId?: string;
    injectedBy: string;
  }): Promise<unknown>;
  kbList(conversationId: string): Promise<KbEntry[]>;
  kbPromote(kbId: string, actor: string): Promise<unknown>;
  kbRevoke(kbId: string, actor: string): Promise<boolean>;
  memoryAdmin(conversationId: string, op: string, name?: string, content?: string): Promise<ToolResponse>;
  recordEscalation(conversationId: string, question: string, context: string, senderId: string): Promise<void>;
  recordUnanswered(conversationId: string, question: string, senderId: string): Promise<void>;
}

interface TasksPort {
  create(cid: string, requesterId: string, requestText: string): Promise<unknown>;
  summary(): unknown;
  list(cid?: string): unknown;
  retry(id: string): Promise<boolean>;
}

interface CronPort {
  addJob(input: { conversationId: string; cronExpr: string; description: string; prompt: string; createdBy: string }): CronJob;
  removeJob(conversationId: string, id: string): boolean;
  listJobs(conversationId: string): CronJob[];
  syncDigests(conversationId: string, enabled: boolean): { added: number; removed: number };
}

interface WorktoolsPort {
  affectsOthers(action: string, params: Record<string, unknown>): boolean;
  execute(req: Extract<ToolRequest, { tool: "worktool" }>): Promise<ToolResponse>;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export interface Api {
  start(): Promise<{ port: number; token: string }>;
  stop(): Promise<void>;
  handleToolRequest(req: ToolRequest): Promise<ToolResponse>;
  tryResolvePending(ev: InboundEvent): Promise<boolean>;
  sweepExpired(): Promise<void>;
}

export interface ApiDeps {
  cfg: Config;
  dws: DwsPort;
  workspaces: unknown;
  tasks: unknown;
  cron: unknown;
  worktools: unknown;
  enqueueRun: (cid: string, prompt: string, opts?: { senderId?: string }) => Promise<void>;
  /** Optional pre-generated IPC token (main writes + hands this out to every
   * module that needs it before api exists, to avoid a token/port
   * circularity — see final report). When omitted, start() generates and
   * writes one itself, per this module's original spec. */
  token?: string;
}

// ---------------------------------------------------------------------------
// node:http <-> Web fetch bridge
// ---------------------------------------------------------------------------

/** Adapts one node:http request/response pair onto a Web-standard
 * `(Request) => Response` handler, so the routing code stays platform
 * neutral. Bodies are small JSON tool calls, so buffering them is fine. */
async function serveFetch(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
): Promise<void> {
  try {
    const body = await buffer(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    }
    const request = new Request(new URL(req.url ?? "/", `http://${host}`), {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
    });
    const response = await handler(request);
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(out);
  } catch {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  }
}

export function createApi(deps: ApiDeps): Api {
  const { cfg, dws, enqueueRun } = deps;
  const workspaces = deps.workspaces as WorkspacesPort;
  const tasks = deps.tasks as TasksPort;
  const cron = deps.cron as CronPort;
  const worktools = deps.worktools as WorktoolsPort;

  let server: Server | undefined;
  let token = "";

  // -- audit -----------------------------------------------------------

  function audit(actor: string, action: string, conversationId: string | undefined, details: Record<string, unknown>): void {
    mkdirSync(paths.var, { recursive: true });
    const entry: AuditEntry = { ts: Date.now(), actor, action, conversationId, details };
    appendFileSync(paths.auditLog, `${JSON.stringify(entry)}\n`);
  }

  function actionLabel(req: ToolRequest): string {
    if (req.tool === "worktool") return `worktool:${req.action}`;
    if (req.tool === "ops") return `ops:${req.op}`;
    return req.tool;
  }

  function stripCommon(req: ToolRequest): Record<string, unknown> {
    const { tool: _tool, conversationId: _cid, senderId: _sid, ...rest } = req;
    return rest as Record<string, unknown>;
  }

  function deny(): ToolResponse {
    return { ok: false, message: "not authorized" };
  }

  // -- pending questions / approvals ------------------------------------

  async function createPending(input: {
    conversationId: string;
    question: string;
    options: string[];
    defaultOption: number;
    purpose: "question" | "approval";
    approverScope: ApproverScope;
    requesterId: string;
    onApprove?: ToolRequest;
  }): Promise<{ ok: true; pending: PendingQuestion } | { ok: false; message: string }> {
    const now = Date.now();
    const open = openPendingsFor(input.conversationId, now);
    if (open.length >= cfg.caps.pendingQuestionsPerConversation) {
      return { ok: false, message: "too many open questions in this conversation" };
    }
    const ws = await workspaces.get(input.conversationId);
    const convType = ws?.conversationType ?? "group";
    const lines = input.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    const text = `${input.question}\n${lines}`;
    const { messageId } = await dws.sendText(input.conversationId, convType, text);
    const pending: PendingQuestion = {
      id: randomUUID(),
      conversationId: input.conversationId,
      postedMessageId: messageId,
      question: input.question,
      options: input.options,
      defaultOption: input.defaultOption,
      purpose: input.purpose,
      approverScope: input.approverScope,
      requesterId: input.requesterId,
      onApprove: input.onApprove,
      status: "open",
      createdAt: now,
      expiresAt: now + cfg.caps.pendingQuestionTtlHours * 3_600_000,
    };
    savePending(pending);
    return { ok: true, pending };
  }

  async function requestApproval(input: {
    conversationId: string;
    requesterId: string;
    approverScope: ApproverScope;
    description: string;
    onApprove: ToolRequest;
  }): Promise<ToolResponse> {
    const created = await createPending({
      conversationId: input.conversationId,
      question: `Approval needed: ${input.description}`,
      options: ["Approve", "Decline"],
      defaultOption: -1,
      purpose: "approval",
      approverScope: input.approverScope,
      requesterId: input.requesterId,
      onApprove: input.onApprove,
    });
    if (!created.ok) return created;
    return { ok: true, message: "awaiting approval", data: { id: created.pending.id } };
  }

  async function applyAnswer(
    p: PendingQuestion,
    option: number,
    freeText: string | undefined,
    answeredBy: string,
    status: "answered" | "expired",
  ): Promise<void> {
    audit(answeredBy, "pending_answered", p.conversationId, { id: p.id, option, purpose: p.purpose, status });
    p.status = status;
    p.answer = { option, freeText, answeredBy, at: Date.now() };
    savePending(p);
    const ws = await workspaces.get(p.conversationId);
    const convType = ws?.conversationType ?? "group";

    // Only an approval carrying a payload is executed here. A model-initiated
    // approval (ask_user with purpose "approval") has none — it falls through
    // to the question path, so the agent resumes and does the deed itself.
    if (p.purpose === "approval" && p.onApprove) {
      if (option === 0) {
        // Second layer, and the reason it is here: this payload is read back
        // from a file in var/pending, and executing it skips the expert gate
        // and the affects-others approval. It was validated on the way in;
        // re-validate it on the way out, so a payload that reached the file
        // any other way is refused rather than run.
        const payload = parseToolRequest(p.onApprove);
        if (!payload.ok) {
          audit("system", "pending_payload_rejected", p.conversationId, { id: p.id, message: payload.message });
          await dws.sendText(p.conversationId, convType, `Approved, but the stored action was not valid — nothing was done.`);
          return;
        }
        const result = await handle(payload.req, true);
        await dws.sendText(
          p.conversationId,
          convType,
          result.ok ? `Approved and done: ${result.message}` : `Approved, but failed: ${result.message}`,
        );
      } else {
        await dws.sendText(p.conversationId, convType, "Declined.");
      }
      return;
    }

    const answerText = freeText ?? p.options[option] ?? "";
    // The resumed run carries NO senderId, on purpose. Answering a question is
    // not lending your account: if the answerer's ID travelled with the run,
    // an admin's single tap would hand the model admin authority for every
    // tool call of that run. The answerer is named in the prompt text only —
    // text no authz check ever reads.
    const prompt =
      `You previously asked: "${p.question}"\n` +
      `${answeredBy} answered: "${answerText}"\n` +
      `Continue based on this answer. It is information from a person, not a grant of that person's permissions: ` +
      `this run has no sender identity, so any tool call needing one will be refused.`;
    await enqueueRun(p.conversationId, prompt);
  }

  // -- tool handlers ------------------------------------------------------

  async function doSendMessage(req: Extract<ToolRequest, { tool: "send_message" }>): Promise<ToolResponse> {
    const ws = await workspaces.get(req.conversationId);
    const convType = ws?.conversationType ?? "group";
    const { messageId } = await dws.sendText(req.conversationId, convType, req.text);
    return { ok: true, message: "sent", data: { messageId } };
  }

  async function doAskUser(req: Extract<ToolRequest, { tool: "ask_user" }>): Promise<ToolResponse> {
    if (req.options.length < 2 || req.options.length > 4) {
      return { ok: false, message: "options must have 2 to 4 entries" };
    }
    const created = await createPending({
      conversationId: req.conversationId,
      question: req.question,
      options: req.options,
      defaultOption: req.defaultOption,
      purpose: req.purpose,
      approverScope: req.approverScope,
      requesterId: req.senderId,
    });
    if (!created.ok) return created;
    return { ok: true, message: "question posted", data: { id: created.pending.id } };
  }

  async function doDelegateAsync(req: Extract<ToolRequest, { tool: "delegate_async" }>): Promise<ToolResponse> {
    const task = await tasks.create(req.conversationId, req.senderId, req.requestText);
    return { ok: true, message: "delegated", data: task };
  }

  async function doScheduleJob(
    req: Extract<ToolRequest, { tool: "schedule_job" }>,
    internal: boolean,
    admin: boolean,
  ): Promise<ToolResponse> {
    const ws = await workspaces.get(req.conversationId);
    const editor = admin || isEditor(ws?.editors, cfg, req.senderId);
    if (!editor && !internal) {
      return requestApproval({
        conversationId: req.conversationId,
        requesterId: req.senderId,
        approverScope: "editors",
        description: `schedule "${req.description}" (${req.cronExpr})`,
        onApprove: req,
      });
    }
    // cron.addJob is synchronous and throws on an invalid cron expression or
    // an unknown workspace — the top-level handle() catch turns that into a
    // { ok: false, message } response.
    const job = cron.addJob({
      conversationId: req.conversationId,
      cronExpr: req.cronExpr,
      description: req.description,
      prompt: req.prompt,
      createdBy: req.senderId,
    });
    return { ok: true, message: "job scheduled", data: job };
  }

  async function doCancelJob(req: Extract<ToolRequest, { tool: "cancel_job" }>, admin: boolean): Promise<ToolResponse> {
    const ws = await workspaces.get(req.conversationId);
    if (!admin && !isEditor(ws?.editors, cfg, req.senderId)) return deny();
    const removed = cron.removeJob(req.conversationId, req.jobId);
    return removed ? { ok: true, message: "job cancelled" } : { ok: false, message: "job not found" };
  }

  async function doListJobs(req: Extract<ToolRequest, { tool: "list_jobs" }>): Promise<ToolResponse> {
    return { ok: true, message: "jobs", data: cron.listJobs(req.conversationId) };
  }

  async function doKbSave(req: Extract<ToolRequest, { tool: "kb_save" }>, admin: boolean): Promise<ToolResponse> {
    const ws = await workspaces.get(req.conversationId);
    if (!admin && !isEditor(ws?.editors, cfg, req.senderId)) return deny();
    const saved = await workspaces.kbSave({
      question: req.question,
      answer: req.answer,
      scope: "workspace",
      conversationId: req.conversationId,
      injectedBy: req.senderId,
    });
    return { ok: true, message: "saved to knowledge base", data: saved };
  }

  async function doKbPromote(req: Extract<ToolRequest, { tool: "kb_promote" }>): Promise<ToolResponse> {
    const promoted = await workspaces.kbPromote(req.kbId, req.senderId);
    return promoted
      ? { ok: true, message: "promoted to shared knowledge base", data: promoted }
      : { ok: false, message: "already global or not found" };
  }

  async function doKbRevoke(req: Extract<ToolRequest, { tool: "kb_revoke" }>, admin: boolean): Promise<ToolResponse> {
    if (admin) {
      const revoked = await workspaces.kbRevoke(req.kbId, req.senderId);
      return revoked ? { ok: true, message: "revoked" } : { ok: false, message: "kb entry not found" };
    }
    const ws = await workspaces.get(req.conversationId);
    if (!isEditor(ws?.editors, cfg, req.senderId)) return deny();
    const entries = await workspaces.kbList(req.conversationId);
    const owned = entries.some((e) => e.id === req.kbId && e.scope === "workspace");
    if (!owned) return { ok: false, message: "not found in this workspace" };
    const revoked = await workspaces.kbRevoke(req.kbId, req.senderId);
    return revoked ? { ok: true, message: "revoked" } : { ok: false, message: "kb entry not found" };
  }

  async function doWorktool(req: Extract<ToolRequest, { tool: "worktool" }>, internal: boolean): Promise<ToolResponse> {
    if (!internal && worktools.affectsOthers(req.action, req.params)) {
      return requestApproval({
        conversationId: req.conversationId,
        requesterId: req.senderId,
        approverScope: "requester",
        description: `${req.action} ${JSON.stringify(req.params)}`,
        onApprove: req,
      });
    }
    return worktools.execute(req);
  }

  const EDITOR_FIELDS = new Set(["editors", "owner", "digestsEnabled"]);

  async function doSetWorkspace(req: Extract<ToolRequest, { tool: "set_workspace" }>, admin: boolean): Promise<ToolResponse> {
    const fields = Object.keys(req.patch);
    if (fields.length === 0) return { ok: false, message: "empty patch" };
    if (!admin) {
      const ws = await workspaces.get(req.conversationId);
      if (!isEditor(ws?.editors, cfg, req.senderId)) return deny();
      for (const f of fields) {
        if (!EDITOR_FIELDS.has(f)) return { ok: false, message: `field "${f}" requires admin` };
      }
    }
    await workspaces.patchMeta(req.conversationId, req.patch);
    // digestsEnabled is only a flag on disk; the digest cron jobs have to be
    // created or removed to match, or enabling digests does nothing.
    if (req.patch.digestsEnabled !== undefined) {
      const { added, removed } = cron.syncDigests(req.conversationId, req.patch.digestsEnabled);
      return { ok: true, message: `workspace updated; digest jobs ${added > 0 ? `added: ${added}` : `removed: ${removed}`}` };
    }
    return { ok: true, message: "workspace updated" };
  }

  async function doMemoryAdmin(req: Extract<ToolRequest, { tool: "memory_admin" }>, admin: boolean): Promise<ToolResponse> {
    if (!admin) {
      const ws = await workspaces.get(req.conversationId);
      if (!isEditor(ws?.editors, cfg, req.senderId)) return deny();
    }
    return workspaces.memoryAdmin(req.conversationId, req.op, req.name, req.content);
  }

  /** Q&A gap routing (wave-2 doc): record the gap, then DM every workspace
   * editor so one of them can relay + kb_save the answer. */
  async function doFlagUnanswered(req: Extract<ToolRequest, { tool: "flag_unanswered" }>): Promise<ToolResponse> {
    await workspaces.recordUnanswered(req.conversationId, req.question, req.senderId);
    const ws = await workspaces.get(req.conversationId);
    const editors = ws?.editors ?? [];
    for (const editorId of editors) {
      await dws.sendText(editorId, "dm", `Unanswered question in ${req.conversationId} from ${req.senderId}: "${req.question}"`);
    }
    return { ok: true, message: editors.length > 0 ? "flagged for the workspace editors" : "flagged (no editors configured)" };
  }

  /** Human escalation (wave-2 doc): record it, then DM the named workspace
   * owner with a minimal excerpt. */
  async function doEscalate(req: Extract<ToolRequest, { tool: "escalate" }>): Promise<ToolResponse> {
    await workspaces.recordEscalation(req.conversationId, req.question, req.context, req.senderId);
    const ws = await workspaces.get(req.conversationId);
    if (!ws?.owner) return { ok: true, message: "recorded (no workspace owner configured)" };
    await dws.sendText(
      ws.owner,
      "dm",
      `Escalation from ${req.conversationId} (${req.senderId}): "${req.question}"\nContext: ${req.context}`,
    );
    return { ok: true, message: "escalated to the workspace owner" };
  }

  async function doOps(req: Extract<ToolRequest, { tool: "ops" }>): Promise<ToolResponse> {
    switch (req.op) {
      case "status": {
        let heartbeatAgeMs: number | null = null;
        try {
          const raw = readFileSync(paths.lastEventAt, "utf8").trim();
          const ts = Number(raw);
          if (Number.isFinite(ts)) heartbeatAgeMs = Date.now() - ts;
        } catch {
          /* heartbeat not written yet */
        }
        const openPendings = listPending().filter((p) => p.status === "open" && p.expiresAt > Date.now()).length;
        const tasksSummary = await tasks.summary();
        // No aggregate count on CronPort — sum per-workspace job lists.
        const cronCount = workspaces.list().reduce((n, ws) => n + cron.listJobs(ws.conversationId).length, 0);
        return { ok: true, message: "status", data: { heartbeatAgeMs, openPendings, tasks: tasksSummary, cronCount } };
      }
      case "spend": {
        const tasksSummary = await tasks.summary();
        return {
          ok: true,
          message: "budget limits (per-run usage counters are not wired into api)",
          data: { budgets: cfg.budgets, tasks: tasksSummary },
        };
      }
      case "tasks": {
        const list = await tasks.list(req.target);
        return { ok: true, message: "tasks", data: list };
      }
      case "retry_task": {
        if (!req.target) return { ok: false, message: "target task id required" };
        const retried = await tasks.retry(req.target);
        return { ok: retried, message: retried ? "retry queued" : "task not found or not in failed state" };
      }
      case "pause_workspace":
      case "resume_workspace": {
        if (!req.target) return { ok: false, message: "target conversation id required" };
        const paused = req.op === "pause_workspace";
        await workspaces.patchMeta(req.target, { paused });
        return { ok: true, message: paused ? "workspace paused" : "workspace resumed", data: { target: req.target, paused } };
      }
      default:
        return { ok: false, message: "unknown op" };
    }
  }

  // -- dispatcher -----------------------------------------------------

  async function route(req: ToolRequest, internal: boolean): Promise<ToolResponse> {
    // Expert profile = which tools EXIST in this workspace (capability), asked
    // before the permission tier below (who may call them). Defence in depth
    // behind `pi -t`, which already hides out-of-profile tools from the model.
    // Only model-originated requests are gated: an `internal` request is the
    // orchestrator running a payload a human already approved.
    // An unknown workspace is not gated — the tier checks below still apply,
    // and refusing on missing metadata would lock an admin out of the very
    // tools (ops, set_workspace) needed to repair that workspace.
    if (!internal) {
      const ws = await workspaces.get(req.conversationId);
      if (ws && !expertAllowsTool(ws.expert, req.tool)) {
        return { ok: false, message: `tool "${req.tool}" is not available to the "${ws.expert}" expert in this workspace` };
      }
    }
    const admin = isAdmin(cfg, req.senderId);
    switch (req.tool) {
      case "send_message":
        return doSendMessage(req);
      case "ask_user":
        return doAskUser(req);
      case "delegate_async":
        return doDelegateAsync(req);
      case "schedule_job":
        return doScheduleJob(req, internal, admin);
      case "cancel_job":
        return doCancelJob(req, admin);
      case "list_jobs":
        return doListJobs(req);
      case "kb_save":
        return doKbSave(req, admin);
      case "kb_promote":
        return admin ? doKbPromote(req) : deny();
      case "kb_revoke":
        return doKbRevoke(req, admin);
      case "flag_unanswered":
        return doFlagUnanswered(req);
      case "escalate":
        return doEscalate(req);
      case "worktool":
        return doWorktool(req, internal);
      case "set_workspace":
        return doSetWorkspace(req, admin);
      case "memory_admin":
        return doMemoryAdmin(req, admin);
      case "ops":
        return admin ? doOps(req) : deny();
      default:
        return { ok: false, message: "unknown tool" };
    }
  }

  async function handle(req: ToolRequest, internal: boolean): Promise<ToolResponse> {
    try {
      const res = await route(req, internal);
      audit(req.senderId, actionLabel(req), req.conversationId, { ...stripCommon(req), ok: res.ok, internal });
      return res;
    } catch (err) {
      const message = `error: ${err instanceof Error ? err.message : String(err)}`;
      audit(req.senderId, actionLabel(req), req.conversationId, { ...stripCommon(req), ok: false, internal, error: message });
      return { ok: false, message };
    }
  }

  // -- pending resolution (reactions + replies) ------------------------

  async function tryResolvePendingImpl(ev: InboundEvent): Promise<boolean> {
    const now = Date.now();

    if (ev.kind === "reaction") {
      if (ev.operation !== "add") return false;
      // A reaction answers ONLY the message that posted the question. There is
      // no "oldest open pending" fallback: a thumbs-up on some other message
      // in the room is not consent to this question, and a pending whose
      // postedMessageId never came back cannot be bound to any reaction at
      // all — it waits for a reply, or expires.
      const open = openPendingsFor(ev.conversationId, now);
      const pool = open
        .filter((p) => !!p.postedMessageId && !!ev.messageId && p.postedMessageId === ev.messageId)
        .sort((a, b) => a.createdAt - b.createdAt);
      const pending = pool[0];
      if (!pending) {
        // Audited only when this conversation actually has a question open:
        // that is the case worth a record (a tap that would have answered it
        // under the old, unbound behaviour). Reactions in a room with nothing
        // pending are ordinary chat and stay out of the log.
        if (open.length > 0) {
          audit(ev.operatorId, "reaction_unbound", ev.conversationId, {
            messageId: ev.messageId,
            emoji: ev.emoji,
            openPendings: open.length,
            postedMessageIds: open.map((p) => p.postedMessageId),
          });
        }
        return false;
      }
      const option = emojiToOption(ev.emoji, pending.options.length);
      if (option === undefined) return false;
      const ws = await workspaces.get(pending.conversationId);
      if (!canApprove(pending.approverScope, ev.operatorId, pending.requesterId, ws?.editors, cfg)) return false;
      await applyAnswer(pending, option, undefined, ev.operatorId, "answered");
      return true;
    }

    // message
    const candidates = openPendingsFor(ev.conversationId, now).sort((a, b) => a.createdAt - b.createdAt);
    for (const pending of candidates) {
      // Approvals are NEVER resolved by a text reply. A plain "1" or "Approve"
      // is not bound to any message, so with multiple pendings open an older
      // approval would be answered by a reply meant for a newer question — the
      // "farmed answer" bypass that would run its onApprove write. Consent for
      // an affects-others action requires the message-bound reaction (a tap on
      // the exact options message), handled above. The text path answers
      // questions only, where a wrong match costs a wrong resume, not a write.
      if (pending.purpose === "approval") continue;
      const option = matchReply(ev.content, pending.options);
      if (option === undefined) continue;
      const ws = await workspaces.get(pending.conversationId);
      // Not this sender's to answer — keep scanning: a later pending in the
      // same conversation may well be answerable by them.
      if (!canApprove(pending.approverScope, ev.senderId, pending.requesterId, ws?.editors, cfg)) continue;
      await applyAnswer(pending, option, undefined, ev.senderId, "answered");
      return true;
    }
    const questionPending = candidates.find((p) => p.purpose === "question");
    if (questionPending) {
      const ws = await workspaces.get(questionPending.conversationId);
      if (!canApprove(questionPending.approverScope, ev.senderId, questionPending.requesterId, ws?.editors, cfg)) return false;
      await applyAnswer(questionPending, -1, ev.content, ev.senderId, "answered");
      return true;
    }
    return false;
  }

  async function sweepExpiredImpl(): Promise<void> {
    const now = Date.now();
    for (const p of listPending()) {
      if (p.status !== "open" || p.expiresAt > now) continue;
      if (p.defaultOption === -1) {
        p.status = "expired";
        savePending(p);
        const ws = await workspaces.get(p.conversationId);
        await dws.sendText(p.conversationId, ws?.conversationType ?? "group", `No answer received in time — dropped: "${p.question}"`);
        audit("system", "pending_expired", p.conversationId, { id: p.id, applied: false });
      } else {
        await applyAnswer(p, p.defaultOption, undefined, "system", "expired");
        audit("system", "pending_expired", p.conversationId, { id: p.id, applied: true, defaultOption: p.defaultOption });
      }
    }
  }

  // -- http server ------------------------------------------------------

  return {
    async start() {
      mkdirSync(paths.var, { recursive: true });
      if (deps.token) {
        // Pre-generated by the caller (main writes + hands it to every
        // module that needs it before api exists) — already on disk.
        token = deps.token;
      } else {
        token = randomBytes(32).toString("hex");
        writeFileSync(paths.ipcToken, token, { mode: 0o600 });
        chmodSync(paths.ipcToken, 0o600);
      }
      const fetchHandler = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/tool") {
          const authzHeader = request.headers.get("authorization") ?? "";
          if (authzHeader !== `Bearer ${token}`) {
            return Response.json({ ok: false, message: "unauthorized" }, { status: 401 });
          }
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ ok: false, message: "invalid json" }, { status: 400 });
          }
          const parsed = parseToolRequest(body);
          if (!parsed.ok) {
            return Response.json({ ok: false, message: parsed.message }, { status: 400 });
          }
          const res = await handle(parsed.req, false);
          return Response.json(res);
        }
        return new Response("not found", { status: 404 });
      };
      server = createServer((req, res) => {
        void serveFetch(fetchHandler, req, res, cfg.http.host);
      });
      const listening = server;
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(cfg.http.port, cfg.http.host, resolve);
      });
      const addr = listening.address();
      return { port: typeof addr === "object" && addr !== null ? addr.port : cfg.http.port, token };
    },

    async stop() {
      const listening = server;
      server = undefined;
      if (!listening) return;
      // Force-close keep-alive sockets too, otherwise close() waits for the
      // pi extension's idle connections and the daemon never exits.
      listening.closeAllConnections();
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    },

    handleToolRequest(req: ToolRequest) {
      // Same check as the HTTP path: the type annotation is erased at load,
      // so it stops nothing at runtime.
      const parsed = parseToolRequest(req);
      if (!parsed.ok) return Promise.resolve({ ok: false, message: parsed.message });
      return handle(parsed.req, false);
    },

    tryResolvePending(ev: InboundEvent) {
      return tryResolvePendingImpl(ev);
    },

    sweepExpired() {
      return sweepExpiredImpl();
    },
  };
}
