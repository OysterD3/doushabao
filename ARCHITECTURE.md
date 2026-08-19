# doushabao — architecture contract

Read this + `src/shared/types.ts` + `src/shared/paths.ts` + the two
`docs/brainstorming/*.content.json` files before writing code. The brainstorm
docs are the product contract; this file is the build contract.

**Shared files are READ-ONLY for module implementers:** `src/shared/*`,
`package.json`, `tsconfig.json`, `test/fakes/*`, this file. If you need a
contract change, say so in your final report — do not edit them.

## Runtime

Node.js (>=22.18) runs the TypeScript sources directly by stripping types at
load time — there is no build step. That means the sources must contain only
erasable syntax (no enums, no namespaces, no constructor parameter
properties), and relative imports must carry their `.ts` extension because
Node does not guess it. `tsconfig.json` makes `tsc` reject both mistakes:
`erasableSyntaxOnly` + `verbatimModuleSyntax` for the syntax, `nodenext`
module resolution for the extensions. Tests use `vitest`. Typecheck is
`tsc --noEmit` (boilerplates/ excluded — pi loads those files itself).
The daemon is `node src/index.ts`, supervised by launchd.

## Module ownership (one implementer per row; stay in your directories)

| Module | Owns | Summary |
|---|---|---|
| dws | `src/dws/` | Adapter around the dws binary: event consumers (one child per event key, NDJSON strict `\n` split, restart w/ backoff, dedupe), paced send queue, media download, doc export, doctor. ONLY module that spawns dws. Fixed argv arrays, never shell strings. |
| pi | `src/pi/`, `boilerplates/` | PiRunner (one-shot `pi -p` runs) + the self-contained workspace extension (`boilerplates/_shared/extensions/doushabao.ts`) + 4 boilerplate templates. ONLY module that spawns pi. |
| router | `src/router/` | InboundEvent → transcript append (all group msgs), trigger rules (mention/DM), per-conversation FIFO lanes (concurrency 1/lane, global cap 3), auto-provision workspace (general + greeting), reply dispatch, quick-ack + milestones. |
| api | `src/api/` | localhost HTTP server: `POST /tool` handling every ToolRequest. Deterministic authz (admins/editors/requester), pending questions + approvals (reply or reaction answers; operator-ID check, add-ops only), audit log, budget/cap enforcement. |
| tasks | `src/tasks/` | Delegated-task registry (var/tasks/*.json), async worker pi runs, completion → announcement prompt to the origin workspace. Survives restarts (rescan on boot). |
| cron | `src/cron/` | Croner scheduler over all workspaces' jobs/, fire-log dedupe, digest recipes, nightly ritual (distill w/ STRONG model + handoff + session reset + retention cleanup), heartbeat watchdog (quiet-stream alert to admin DMs via dws). |
| workspace | `src/workspace/` | Workspace registry (create-from-boilerplate, meta CRUD), KB shared+overlay (+provenance, promote/revoke), memory admin ops, escalation records. |
| worktools | `src/worktools/` | Curated dws work-tool actions behind the `worktool` ToolRequest: todo_create(+executors), calendar_create(+attendees), doc_read (ONLY urls seen in this conversation's transcript), report_create; media pipeline (download→quarantine→extract text: pdf-parse/mammoth/plain); voice→minutes experiment behind `DOUSHABAO_VOICE_SPIKE=1`. Declares which actions are "affects others" → requester confirm via ask_user/approval before execution. |
| main | `src/index.ts`, `src/config.ts`, `scripts/`, `SETUP.md` | Config load, wiring, graceful shutdown, launchd plist, setup doc (dws install/auth, org CLI Access Management, dedicated account, caffeinate/pmset). |
| e2e | `test/e2e/` | Boots the REAL daemon with fake dws + fake pi; asserts: message in → reply out; cron fires → message; ask → reaction answer → resumed run; approval denied for unauthorized operator; restart mid-task → task survives. |

Cross-module imports: only from `src/shared/*` and other modules' `index.ts`
exports typed as the Ports in types.ts. Construct nothing of another module —
`src/index.ts` does all wiring.

## IPC contract (pi extension → orchestrator)

- `POST http://127.0.0.1:8787/tool`, `Authorization: Bearer <var/ipc-token>`
  (token: random hex written by main at boot, mode 0600).
- Body: `ToolRequest`; response: `ToolResponse`. The extension fills
  `conversationId`/`senderId` from env (`DOUSHABAO_CONVERSATION`,
  `DOUSHABAO_SENDER`, plus `DOUSHABAO_API`, `DOUSHABAO_TOKEN`) — tool schemas
  exposed to the model MUST NOT accept identity params.
- The extension is SELF-CONTAINED (no imports from src/) because it is copied
  into each workspace's `.pi/extensions/`.

## pi invocation contract (PiRunner)

`pi -p --mode json --session-id <dailySessionId(cfg.timezone)>-<conversation-slug> <prompt>`
with `cwd = workspace dir`, `--model <override or cfg.models.default>` when set.
The tool surface is locked by three flags on every run — this is the whole
enforcement of the signed-off "no exec in agent workspaces" rule, and the
boilerplate `.pi/settings.json` files (empty) must never be relied on for it:

- `-nbt` — no built-in tools, so no shell/write/edit.
- `-ne` — no extension *discovery*. pi auto-loads every extension in the host
  account's `~/.pi/agent/extensions/` for all projects; without `-ne` a
  workspace inherits whatever is installed there (shell-granting ones
  included) and the no-exec rule silently depends on that directory being empty.
- `-e <workspace>/.pi/extensions/doushabao.ts` — load our own extension by
  path. Auto-discovery of the workspace's own `.pi/extensions/` is NOT enough:
  pi loads project-local extensions only after the project is "trusted", and
  a headless `-p` run can never grant that trust, so the `doushabao_*` tools
  would simply be absent.

Parse the JSONL
event stream; the final assistant message text is the reply. `[SILENT]` prefix
suppresses sending.

## dws invocation contract (facts from research — encode as data, adapter may refine)

- Consume: `dws event consume <eventKey> --flatten -f ndjson` per key:
  `user_im_message_receive_at`, `user_im_message_receive_o2o`,
  `user_im_message_receive_group_all`, `user_im_message_reaction_group`,
  `user_im_message_reaction_o2o`. NDJSON fields include `event_id`,
  `message_id`, `conversation_id`, `sender`, `sender_open_dingtalk_id`,
  `content`; reactions add `operator_open_dingtalk_id`, `reaction_name`,
  `operation_type`. A mention arrives on BOTH `_at` and `_group_all` — dedupe
  by message_id, mention flag wins. No offline replay exists: log a gap marker
  on every consumer (re)start.
- Send (user identity): `dws chat +messages-send --as user --group <conversationId> --text <text>`
  (groups) / `--open-dingtalk-id <userId>` (DMs).
- Media: `dws chat +chat-messages --group <cid> --download-resources --output-dir <dir>`.
- Doc: `dws doc +export --node <url> --export-format markdown --output <file>`.
- Prefer indexed base commands over `+shortcuts` where an indexed form exists
  (shortcut layer has documented param-mapping bugs); shortcuts above are the
  documented exceptions.

## Test strategy (per user CLAUDE.md)

Fakes exist ONLY at boundaries we don't own: `test/fakes/fake-dws.ts` and
`test/fakes/fake-pi.ts` (see file headers for their env-file protocols). Module
tests drive real module entry points against the fakes + tmp dirs. Do not mock
our own modules. The e2e suite is the regression table.

## Gates (definition of done)

`pnpm gate` = typecheck + unit + e2e, all green.
