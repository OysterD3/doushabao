# Setup

Doushabao is a DingTalk digital employee: an always-on daemon that listens on
a dedicated DingTalk account, thinks in per-conversation `pi` agent
workspaces, and replies as that account. This doc covers everything to get
it running on the target Mac. See `ARCHITECTURE.md` for the build contract
and `docs/brainstorming/*.content.json` for the product decisions behind it.

## Prerequisites: Node.js + project dependencies

The daemon runs on **Node.js >= 22.18**. That version runs the TypeScript
sources directly — it strips the types as it loads each file — so there is
no build step and nothing to compile before starting. Check with `node -v`.

Install the dependencies once, in the repo:

```sh
pnpm install
```

Any npm-compatible client produces the same `node_modules` (`npm install`,
`yarn`); only the lockfile differs. The `package.json` scripts call `tsc`,
`vitest` and `node` directly, so they work the same either way.

## 1. Dedicated macOS user + dedicated DingTalk account

Create a **separate, limited-access macOS user** on the Mac for this daemon
(do not run it under your personal login). It hosts the messaging OAuth
token and model API keys outside every workspace path; rotation is
re-login plus a daemon restart.

Provision a **dedicated DingTalk account** for the employee (its own phone
number/seat, not a shared or personal one). Decide who custodies its login
credentials — this is a company decision, not a technical one; record the
answer wherever the company keeps secrets-ownership notes.

## 2. Install `dws` (DingTalk workspace CLI)

Install `dws` under the dedicated macOS user, via the official install
script or Homebrew (whichever the `dws` project currently documents — check
its README, this changes over time). Then authenticate as the dedicated
DingTalk account:

```sh
dws auth login
```

Follow its prompts. Confirm success with `dws` doctor/health command if one
exists (the `src/dws` module also exposes a `doctor()` check the daemon can
run at boot).

### Hard prerequisite: CLI Access Management

Before any work-tool action (todo creation, calendar invites, doc reads,
report creation — see `src/worktools`) will work, **your DingTalk org admin
must enable CLI Access Management** for the dedicated account. This is a
hard prerequisite, not optional configuration — without it, `dws` work-tool
commands fail even though messaging still works. Ask the org admin to
enable it before relying on any worktool feature.

## 3. Install `pi`

Install `pi` (the agent runtime `src/pi` shells out to) under the same
dedicated macOS user. Confirm `pi --version` runs before starting the
daemon — `PiRunner` spawns it as a one-shot process per conversation turn.

## 4. Configure `config/doushabao.json`

Copy the example and edit it:

```sh
cp config/doushabao.example.json config/doushabao.json
```

`config/doushabao.json` is gitignored, because it holds real DingTalk admin
IDs. The daemon reads it through `ConfigSchema` (`src/shared/types.ts`) —
every field has a default, so the file can be sparse or absent. Example:

```json
{
  "admins": ["<open_dingtalk_id of a trusted human admin>"],
  "timezone": "Asia/Shanghai",
  "dwsBin": "dws",
  "piBin": "pi",
  "models": {
    "default": "<cheap model id, e.g. a low-cost Chinese-language-capable model>",
    "distillation": "<stronger model id — used ONLY for the nightly distillation/handoff pass>",
    "vision": "<vision-capable model id — used only for multimodal-enabled workspaces>"
  },
  "http": { "host": "127.0.0.1", "port": 8787 },
  "pacing": { "sendIntervalMs": 3500 },
  "budgets": {
    "perWorkspaceDailyRuns": 200,
    "perUserDailyRuns": 60,
    "writesPerWorkspacePerHour": 20
  },
  "caps": {
    "pendingQuestionsPerConversation": 3,
    "pendingQuestionTtlHours": 24,
    "mediaMaxBytes": 20971520,
    "transcriptTailLines": 80
  },
  "retention": { "transcriptDays": 30, "mediaDays": 7 },
  "heartbeat": {
    "quietMinutes": 90,
    "workHours": { "start": 9, "end": 19, "days": [1, 2, 3, 4, 5] }
  },
  "nightly": { "hour": 3 }
}
```

Notes:

- `models.default` is the cheap-everywhere model for ordinary workspace
  runs. `models.distillation` is the **one signed-off exception** to
  cheap-first: the nightly ritual (distill durable facts to memory, write a
  handoff note, then reset to a fresh session) runs on the strong model
  because it is unattended and hard to correct after the fact. Leave it
  empty to fall back to `models.default`.
- `pacing.sendIntervalMs` is the minimum gap between outbound sends on the
  global queue — this keeps a programmatic account under platform
  anti-spam heuristics. The value above is a starting point; it needs
  empirical tuning against real usage (see the wave-1 open question) —
  watch for throttling/rate-limit responses from `dws` and raise it if seen.
- `retention.transcriptDays` (default 30) is the company's current privacy
  posture default; revisit whether DMs deserve a shorter retention window
  once real usage exists.
- `admins` (open_dingtalk_ids) can do everything everywhere — set this to
  a small, trusted set of humans.

## 5. Install as a launchd LaunchAgent

```sh
./scripts/install-launchd.sh
```

This copies `scripts/com.doushabao.daemon.plist` to
`~/Library/LaunchAgents/` and loads it (`launchctl load -w`). launchd runs
with a minimal PATH of its own, so the script bakes two things into the copy:
the absolute `node` path, and your current PATH (which is how the daemon finds
`dws` and `pi`, since `dwsBin`/`piBin` default to those bare names). **Run it
from a normal login shell of the dedicated user**, so the PATH it captures is
the one where you installed `dws` and `pi`. It warns if either is missing.
For belt and braces, put absolute paths in `config/doushabao.json` instead —
then PATH stops mattering at all. The daemon
then starts at login and restarts automatically if it exits (`KeepAlive`).
Logs go to `var/daemon.log`. Re-running the script is safe — it unloads
the previous copy first.

## 6. Keep the Mac awake

No offline replay exists for missed DingTalk events (see
`ARCHITECTURE.md`), so the Mac must stay awake and network-connected at all
times the daemon should be listening. The signed-off approach is **lid open
on power** (or clamshell mode with an external display, keyboard, and
power). Run:

```sh
./scripts/keepawake.sh
```

This is informational — it never changes system settings itself. It prints
the current `pmset` state and the exact `sudo pmset -c sleep 0` command to
stop idle sleep on AC power, plus a `caffeinate -ims` alternative you can
run long-lived without sudo. Pick one and set it up before relying on the
daemon unattended.

## 7. What works before `dws` and `pi` exist on the Mac

You do not need real `dws`/`pi` installed to exercise the wiring. Point
`config/doushabao.json` (or a throwaway copy under a scratch
`DOUSHABAO_ROOT`) at the test fakes instead:

```json
{ "dwsBin": "test/fakes/fake-dws.ts", "piBin": "test/fakes/fake-pi.ts" }
```

Then run the module test suites and the gate:

```sh
pnpm typecheck
pnpm test   # unit tests, including each module's colocated *.test.ts
pnpm e2e    # test/e2e boots the real daemon against the fakes
pnpm gate   # typecheck + test + e2e
```

`pnpm gate` is the project's definition of done — all three must be green
before anything ships.

## 8. Starting the daemon manually (without launchd)

```sh
DOUSHABAO_ROOT="$PWD" node src/index.ts
```

Watch `var/daemon.log` (or stdout, if run in a foreground terminal) for the
startup banner. `SIGINT`/`SIGTERM` trigger a graceful stop (dws consumers
stop, cron stops, the HTTP API stops, then exit).
