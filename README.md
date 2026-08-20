# doushabao — a DingTalk digital employee

An always-on daemon that listens on a dedicated DingTalk account, thinks in an
isolated [pi](https://github.com/earendil-works/pi) agent workspace per
conversation, and replies as that account — paced, audited, and unable to run a
shell.

Messages arrive over the DingTalk `dws` CLI. Every group message is recorded;
only @mentions and DMs wake the agent. Long jobs run in the background and
survive restarts. Each conversation has its own memory, knowledge base, and
natural-language cron jobs. Runs on a Mac, self-hosted — you hold your own keys.

> **Status:** compile-green and fully fake-tested (238 unit tests + 7
> end-to-end scenarios that boot the real daemon against stand-in `dws`/`pi`
> binaries). It has **not** yet been run against a live DingTalk — that needs
> the prerequisites below. Treat it as ready to stand up, not battle-tested.

## What it can do

- **Answer, ask, and escalate** in chat. It has no buttons under this setup, so
  it asks by posting numbered options you answer with a reply or an emoji tap.
- **Learn** — a whitelisted editor confirms an answer once and it reuses it;
  local answers win over the company-wide knowledge base.
- **Curated DingTalk actions** — create todos, calendar events, reports; read a
  doc that was shared in the conversation. Anything affecting a colleague needs
  a one-tap confirm from the requester first.
- **Experts** — five profiles (general, qa-cs, project, dev-mgmt, debug), each
  granting a *different set of tools*, switchable by an admin.
- **Keep its own time** — nightly distillation into a handoff note, a dead-man
  watchdog that DMs admins if the event stream goes quiet in work hours.
- **Version its own memory** (optional) — the workspace tree can be its own
  private git repo, auto-committed and pushed.

See `docs/index.html` for a visual, bilingual (EN / 中文) walkthrough.

## The honest part: prerequisites

This is self-hostable by a technical operator, but two of the steps are not
things any script can do for you:

1. A **dedicated DingTalk account** for the employee (its own seat).
2. Your **org admin enabling "CLI Access Management"** — without it the `dws`
   CLI cannot subscribe to messages. This is the long pole.
3. Install and authenticate `dws` and `pi` under the account running the daemon.
4. A model API key for `pi`.

Full walkthrough in [SETUP.md](SETUP.md).

## Quick start

```sh
# Requires Node.js >= 22.18 (runs the TypeScript sources directly, no build step).
pnpm install                       # or npm install
cp config/doushabao.example.json config/doushabao.json   # then edit it

node src/index.ts --doctor         # checks every prerequisite, tells you what's missing
DOUSHABAO_ROOT="$PWD" node src/index.ts                  # run it
# or install as a launchd agent:
./scripts/install-launchd.sh
```

`pnpm gate` (tsc + unit + e2e) is the definition of done.

## How it's built

- **Node.js, no build step** — the `.ts` sources run directly via type
  stripping. `tsconfig.json` forbids anything non-erasable.
- **One orchestrator daemon**, one-shot `pi` run per message, localhost IPC.
- **Security is deliberate and mechanical**, never the model's judgement:
  no shell, loopback-only tool API, per-workspace path containment, an argv
  allowlist, secrets kept out of child processes, and identity injected from
  the DingTalk event so a message can't make the agent claim to be someone else.
  See the "Security model" section of [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout

| Path | What |
|---|---|
| `src/dws` | the DingTalk CLI adapter (the only thing that spawns `dws`) |
| `src/router` | trigger rules, per-conversation lanes, reply dispatch |
| `src/pi` + `experts/` | one-shot agent runs + the five expert templates |
| `src/api` | localhost IPC, authz, questions/approvals, audit log |
| `src/tasks` `src/cron` | delegated work, schedules, nightly ritual, watchdog |
| `src/workspace` `src/worktools` | per-conversation state; curated DingTalk actions |
| `src/gitsnapshot` | optional git versioning of the workspace tree |
| `ARCHITECTURE.md` `SETUP.md` | the build contract and the go-live steps |
