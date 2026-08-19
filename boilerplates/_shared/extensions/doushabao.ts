/**
 * doushabao — the workspace extension that gives every pi agent run its
 * orchestrator-facing tools.
 *
 * SELF-CONTAINED: this file has no imports from doushabao's src/, because it
 * is copied verbatim into every workspace's `.pi/extensions/` directory
 * (see src/pi/boilerplate.ts) and loaded there by pi itself, which resolves
 * `typebox` and `@earendil-works/pi-coding-agent` from its own install, not
 * from the workspace. The `ExtensionAPI`/`ExtensionContext` import below is
 * `import type` only, so it is erased at runtime and never needs resolving.
 *
 * Every tool here POSTs a `ToolRequest` (see doushabao's src/shared/types.ts
 * for the authoritative shape) to `${DOUSHABAO_API}/tool`, authenticated with
 * `Authorization: Bearer ${DOUSHABAO_TOKEN}`. `conversationId` and `senderId`
 * are read from `DOUSHABAO_CONVERSATION`/`DOUSHABAO_SENDER` and injected last,
 * after the model-supplied params are spread in — no tool below accepts an
 * identity parameter from the model, by design: the orchestrator's authz
 * decisions run on the sender/operator ID it captured itself off the
 * DingTalk event, never on anything the model could be talked into sending.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

interface ToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/** POST one ToolRequest body to the orchestrator and return its ToolResponse. */
async function callTool(request: Record<string, unknown>): Promise<ToolResult> {
  const api = process.env.DOUSHABAO_API;
  if (!api) return { ok: false, message: "DOUSHABAO_API is not set in this workspace's environment." };

  const body = {
    ...request,
    conversationId: process.env.DOUSHABAO_CONVERSATION,
    senderId: process.env.DOUSHABAO_SENDER,
  };

  let res: Response;
  try {
    res = await fetch(`${api}/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.DOUSHABAO_TOKEN ?? ""}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, message: `Could not reach the orchestrator: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, message: `Orchestrator returned a non-JSON response (status ${res.status}).` };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok === "boolean" && typeof record.message === "string") {
    return { ok: record.ok, message: record.message, data: record.data };
  }
  return { ok: false, message: `Orchestrator returned an unexpected response (status ${res.status}).` };
}

interface ToolSpec {
  /** Name the model calls, e.g. "doushabao_send". */
  name: string;
  label: string;
  description: string;
  /** The ToolRequest["tool"] discriminator this forwards to. */
  toolName: string;
  parameters: TSchema;
}

const TOOLS: ToolSpec[] = [
  {
    name: "doushabao_send",
    label: "Send message",
    toolName: "send_message",
    description:
      "Send an extra message into this conversation, beyond your normal reply text (which is sent automatically). Use this for a proactive or follow-up message in the middle of your work, e.g. a milestone update on a long task.",
    parameters: Type.Object({
      text: Type.String({ description: "The message text to send." }),
    }),
  },
  {
    name: "doushabao_ask",
    label: "Ask a question",
    toolName: "ask_user",
    description:
      "Post a numbered-options question and end your turn waiting for an answer (a reply or an emoji reaction). Use purpose \"approval\" for a write that affects a colleague, and set approverScope to who may answer it: \"requester\" (only the person who asked), \"editors\" (this workspace's editors), or \"admins\" (global admins). The question is held for up to 24h; defaultOption (index into options, or -1 to drop) applies if nobody answers in time.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask, ending in a question mark." }),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 4, description: "2 to 4 short answer choices." }),
      defaultOption: Type.Integer({ description: "Index into options applied on expiry, or -1 to drop the question unanswered." }),
      purpose: Type.Union([Type.Literal("question"), Type.Literal("approval")], {
        description: "\"question\" for an open decision, \"approval\" to gate a write on a colleague's or admin's consent.",
      }),
      approverScope: Type.Union([Type.Literal("requester"), Type.Literal("editors"), Type.Literal("admins")], {
        description: "Who is allowed to answer/approve this.",
      }),
    }),
  },
  {
    name: "doushabao_delegate",
    label: "Delegate as async task",
    toolName: "delegate_async",
    description:
      "Hand a complex or slow request off to an async worker instead of finishing it in this turn. The orchestrator tracks it durably and prompts you to announce the result in this conversation when it completes, even across a restart.",
    parameters: Type.Object({
      requestText: Type.String({ description: "The request verbatim, self-contained enough to complete with no other context." }),
    }),
  },
  {
    name: "doushabao_schedule_job",
    label: "Schedule a cron job",
    toolName: "schedule_job",
    description: "Schedule a recurring prompt to run in this conversation on a cron schedule.",
    parameters: Type.Object({
      cronExpr: Type.String({ description: "A standard 5- or 6-field cron expression." }),
      description: Type.String({ description: "Short natural-language description shown to users, e.g. \"daily standup digest at 9am\"." }),
      prompt: Type.String({ description: "The prompt to run in this workspace each time the job fires." }),
    }),
  },
  {
    name: "doushabao_cancel_job",
    label: "Cancel a cron job",
    toolName: "cancel_job",
    description: "Cancel a previously scheduled cron job in this conversation.",
    parameters: Type.Object({
      jobId: Type.String({ description: "The id of the job to cancel." }),
    }),
  },
  {
    name: "doushabao_list_jobs",
    label: "List cron jobs",
    toolName: "list_jobs",
    description: "List the cron jobs currently scheduled in this conversation.",
    parameters: Type.Object({}),
  },
  {
    name: "doushabao_kb_save",
    label: "Save a knowledge-base draft",
    toolName: "kb_save",
    description:
      "Draft a question/answer pair into this workspace's knowledge base overlay. Nothing is public knowledge until an editor taps to approve it — use this to record what you just learned, not to auto-publish an offhand reply.",
    parameters: Type.Object({
      question: Type.String({ description: "The question this answers." }),
      answer: Type.String({ description: "The confirmed answer." }),
    }),
  },
  {
    name: "doushabao_kb_promote",
    label: "Promote a KB entry to global",
    toolName: "kb_promote",
    description: "Promote a workspace knowledge-base entry to the company-wide shared KB. Privileged; the orchestrator enforces who may do this.",
    parameters: Type.Object({
      kbId: Type.String({ description: "The id of the knowledge-base entry to promote." }),
    }),
  },
  {
    name: "doushabao_kb_revoke",
    label: "Revoke a KB entry",
    toolName: "kb_revoke",
    description: "Revoke a knowledge-base entry (workspace or global) that turned out to be wrong or outdated.",
    parameters: Type.Object({
      kbId: Type.String({ description: "The id of the knowledge-base entry to revoke." }),
    }),
  },
  {
    name: "doushabao_flag_unanswered",
    label: "Flag an unanswered question",
    toolName: "flag_unanswered",
    description:
      "Flag a question you cannot answer confidently from the knowledge base. This tells the asker you're checking and routes the question to this workspace's editors for an answer, which you'll then relay back. Never invent an answer instead of calling this.",
    parameters: Type.Object({
      question: Type.String({ description: "The question you could not answer." }),
    }),
  },
  {
    name: "doushabao_escalate",
    label: "Escalate to the workspace owner",
    toolName: "escalate",
    description:
      "Escalate to this workspace's named human owner when editors can't resolve something either. The owner is DMed and taps to release the relayed answer back into this conversation.",
    parameters: Type.Object({
      question: Type.String({ description: "The question or issue to escalate." }),
      context: Type.String({ description: "Relevant context the owner needs to answer it." }),
    }),
  },
  {
    name: "doushabao_worktool",
    label: "Run a work-tool action",
    toolName: "worktool",
    description:
      "Run a curated DingTalk work-tool action, e.g. \"todo_create\", \"calendar_create\", \"doc_read\", \"report_create\" (availability depends on this workspace's boilerplate). doc_read only works on links shared in this conversation. Any write that affects a colleague needs their one-tap confirm first via doushabao_ask (purpose \"approval\", approverScope \"requester\") before you call this.",
    parameters: Type.Object({
      action: Type.String({ description: "The curated action name, e.g. \"todo_create\"." }),
      params: Type.Any({ description: "Action-specific parameters, per the action's own documented shape." }),
    }),
  },
  {
    name: "doushabao_set_workspace",
    label: "Update workspace settings",
    toolName: "set_workspace",
    description: "Update this workspace's settings (boilerplate, editors, owner, multimodal, digestsEnabled, modelOverride). Privileged; the orchestrator enforces who may do this.",
    parameters: Type.Object({
      patch: Type.Object({
        boilerplate: Type.Optional(
          Type.Union([Type.Literal("general"), Type.Literal("qa-cs"), Type.Literal("project"), Type.Literal("dev-mgmt")]),
        ),
        editors: Type.Optional(Type.Array(Type.String(), { description: "open_dingtalk_ids of this workspace's editors." })),
        owner: Type.Optional(Type.String({ description: "open_dingtalk_id of the named human owner for escalation." })),
        multimodal: Type.Optional(Type.Boolean()),
        digestsEnabled: Type.Optional(Type.Boolean()),
        modelOverride: Type.Optional(Type.String()),
      }),
    }),
  },
  {
    name: "doushabao_memory",
    label: "Manage workspace memory",
    toolName: "memory_admin",
    description: "List, read, write, or delete this workspace's admin-visible memory notes.",
    parameters: Type.Object({
      op: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("write"), Type.Literal("delete")]),
      name: Type.Optional(Type.String({ description: "The memory note name. Required for read/write/delete." })),
      content: Type.Optional(Type.String({ description: "The note's new content. Required for write." })),
    }),
  },
  {
    name: "doushabao_ops",
    label: "Ops console",
    toolName: "ops",
    description:
      "Global-admin ops console: check deterministic status/spend/pending-task/cron info, or retry a failed task and pause/resume a workspace. Only available to global admins.",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("status"),
        Type.Literal("spend"),
        Type.Literal("tasks"),
        Type.Literal("retry_task"),
        Type.Literal("pause_workspace"),
        Type.Literal("resume_workspace"),
      ]),
      target: Type.Optional(Type.String({ description: "The task id or conversationId this op targets, when applicable." })),
    }),
  },
];

export default function (pi: ExtensionAPI) {
  for (const spec of TOOLS) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId, params) {
        const result = await callTool({ ...(params as Record<string, unknown>), tool: spec.toolName });
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
          isError: !result.ok,
        };
      },
    });
  }
}
