/**
 * src/gitsnapshot — versions the workspace tree (one dir per group chat) as a
 * git repo, committing coalesced snapshots on a timer and pushing to a private
 * remote.
 *
 * Design decisions, on purpose:
 *  - NEVER commits per message. transcript.jsonl appends on every inbound
 *    message; a commit each time would be thousands of commits a day. Instead
 *    a background loop coalesces whatever changed since the last tick into one
 *    commit. Near-live history, no volume pathology.
 *  - Entirely OFF the message hot path. This module polls `git status`; no
 *    writer signals it, and a git failure can never block a reply. Every git
 *    error is logged and swallowed.
 *  - Commit messages are TEMPLATED — a file count and a timestamp, never chat
 *    content — so the git log cannot be polluted or injection-crafted by a
 *    message.
 *  - The workspace tree holds full transcripts and downloaded attachments, so
 *    `remote` MUST be private. This module does not (cannot) verify that; the
 *    operator owns it. See SETUP.md.
 *
 * git runs with a reduced env (PATH/HOME/SSH so push auth works, plus git's
 * own vars) and the daemon's DOUSHABAO_* secrets excluded.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/types.ts";
import { paths } from "../shared/paths.ts";
import { allowlistedEnv, NET_TRANSPORT_KEYS } from "../shared/env.ts";

export interface GitSnapshotter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Commit-now, for the nightly ritual, tests, or an explicit flush. Returns
   * true if a commit was made. */
  snapshotNow(): Promise<boolean>;
}

/** Env for git children: enough for push auth (HOME/SSH), never the daemon's
 * own secrets. */
// SSH_AUTH_SOCK for key-agent push auth; NET_TRANSPORT_KEYS so `git push`
// works on a host behind a proxy or custom CA (the same reason the dws env
// carries them).
const GIT_ENV_KEYS = ["PATH", "HOME", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "TZ", ...NET_TRANSPORT_KEYS];
function gitEnv(): Record<string, string> {
  return allowlistedEnv(GIT_ENV_KEYS, ["GIT_"]);
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(dir: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.once("error", (err: Error) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const GITIGNORE = [
  "# Managed by doushabao. The workspace tree is DATA; keep code and cruft out.",
  ".pi/", // the (unused) copied extension + settings — code, not data
  "*.tmp",
  ".DS_Store",
  "",
].join("\n");

export function createGitSnapshotter(deps: { cfg: Config; dir?: string }): GitSnapshotter {
  const cfg = deps.cfg;
  const dir = deps.dir ?? paths.workspaces;
  const g = cfg.workspacesGit;
  let commitTimer: ReturnType<typeof setInterval> | undefined;
  let pushTimer: ReturnType<typeof setInterval> | undefined;
  let busy = false; // one git operation at a time — the ops are not reentrant
  let lastPushedHead: string | undefined; // skip no-op pushes on an idle daemon

  async function ensureRepo(): Promise<void> {
    if (!existsSync(join(dir, ".git"))) {
      await runGit(dir, ["init", "-q"]);
    }
    // Local identity so commits have an author without touching global config.
    await runGit(dir, ["config", "user.name", g.authorName]);
    await runGit(dir, ["config", "user.email", g.authorEmail]);
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
    if (g.remote) {
      const has = await runGit(dir, ["remote"]);
      if (!has.stdout.split("\n").includes("origin")) {
        await runGit(dir, ["remote", "add", "origin", g.remote]);
      } else {
        await runGit(dir, ["remote", "set-url", "origin", g.remote]);
      }
    }
    // An empty new repo has no HEAD; make the initial commit if there is
    // anything to commit, so later diffs have a base.
    await commit();
  }

  async function commit(): Promise<boolean> {
    // One `git status` gives both the dirty check and the change count:
    // --porcelain lists a line per changed path whether staged or not, so
    // `add -A` does not alter the count.
    const status = await runGit(dir, ["status", "--porcelain"]);
    if (status.code !== 0) {
      // A failing `git status` (missing/corrupt .git, git not on PATH, spawn
      // error) yields empty stdout — indistinguishable from a clean tree
      // unless we check the code. Log it, so a snapshotter that has silently
      // stopped versioning is visible in the daemon log instead of just going
      // quiet forever.
      console.error(`[gitsnapshot] status failed, skipping this snapshot: ${status.stderr.trim()}`);
      return false;
    }
    const count = status.stdout.split("\n").filter(Boolean).length;
    if (count === 0) return false;
    await runGit(dir, ["add", "-A"]);
    // Templated message ONLY. Never interpolate chat/model content into the
    // git log. The ISO timestamp gives ordering; the count gives a sense of
    // scale. Anything more would be an injection surface.
    const msg = `snapshot: ${count} change(s) at ${new Date().toISOString()}`;
    const res = await runGit(dir, ["commit", "-q", "-m", msg]);
    if (res.code !== 0) {
      console.error(`[gitsnapshot] commit failed: ${res.stderr.trim()}`);
      return false;
    }
    return true;
  }

  async function push(): Promise<void> {
    if (!g.remote) return;
    // Fails soft: an unreachable remote or an auth problem must never take the
    // daemon down or reach a chat. HEAD may not exist yet on a fresh repo.
    const head = await runGit(dir, ["rev-parse", "HEAD"]);
    if (head.code !== 0) return;
    // Skip the network round-trip when nothing new has landed since the last
    // successful push — otherwise an idle daemon pushes every tick for weeks.
    const at = head.stdout.trim();
    if (at === lastPushedHead) return;
    const res = await runGit(dir, ["push", "-q", "origin", "HEAD"]);
    if (res.code === 0) lastPushedHead = at;
    else console.error(`[gitsnapshot] push failed (will retry): ${res.stderr.trim()}`);
  }

  // Serial queue: git ops never overlap. `enqueue` ALWAYS runs its fn (after
  // any in-flight op) — used by stop()'s final flush and snapshotNow(), which
  // must not be dropped. Timer ticks instead SKIP when something is already
  // running, so a slow push can't pile up 20s-apart commit ticks behind it.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    });
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  function tick(fn: () => Promise<unknown>): void {
    if (busy) return; // something already running — the next tick catches up
    void enqueue(fn);
  }

  return {
    async start(): Promise<void> {
      await enqueue(ensureRepo);
      commitTimer = setInterval(() => tick(commit), g.commitIntervalMs);
      pushTimer = setInterval(() => tick(push), g.pushIntervalMs);
      // interval timers must not keep the process alive on their own
      commitTimer.unref?.();
      pushTimer.unref?.();
    },

    async stop(): Promise<void> {
      if (commitTimer) clearInterval(commitTimer);
      if (pushTimer) clearInterval(pushTimer);
      commitTimer = undefined;
      pushTimer = undefined;
      // Final flush WAITS for any in-flight tick (enqueue, not skip) so a
      // change made right before shutdown is committed and pushed.
      await enqueue(async () => {
        await commit();
        await push();
      });
    },

    snapshotNow(): Promise<boolean> {
      return enqueue(commit);
    },
  };
}
