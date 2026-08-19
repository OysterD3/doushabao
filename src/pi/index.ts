/**
 * src/pi — the only module that spawns the `pi` binary.
 *
 * createPiRunner() launches one-shot `pi -p --mode json` runs, one per
 * inbound message, resuming the caller-supplied session id. See
 * ARCHITECTURE.md "pi invocation contract" and types.ts's PiRunnerPort.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Config, PiRunnerPort } from "../shared/types.ts";
import { wsPaths } from "../shared/paths.ts";

export { instantiateBoilerplate } from "./boilerplate.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
/** Cap on how much stderr we keep around for the error message on a nonzero exit. */
const STDERR_EXCERPT_MAX_CHARS = 4000;

/** Build a plain string-keyed env from process.env (dropping undefined values). */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Find the reply: the text content of the LAST `message_end` line whose
 * `message.role === "assistant"`. Unknown line types and non-JSON lines are
 * skipped rather than treated as errors — pi's JSONL stream carries other
 * event types (session, tool_execution_*, etc.) we don't care about here.
 */
function extractReply(stdout: string): string | undefined {
  let last: string | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const event = parsed as Record<string, unknown>;
    if (event.type !== "message_end") continue;
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");
    last = text;
  }
  return last;
}

export function createPiRunner(cfg: Config): PiRunnerPort {
  return {
    run(opts): Promise<{ text: string; ok: boolean; error?: string }> {
      const model = opts.model || cfg.models.default;
      const argv = ["-p", "--mode", "json", "--session-id", opts.sessionId];
      if (model) argv.push("--model", model);
      // Tool surface, locked down in three flags — see ARCHITECTURE.md:
      //  -nbt  no built-in tools (no shell/write/edit) — the no-exec rule.
      //  -ne   no extension DISCOVERY. Without it a workspace inherits every
      //        extension installed in the host account's ~/.pi/agent/
      //        extensions/ (shell-granting ones included), so the no-exec
      //        rule would depend on that directory happening to be empty.
      //  -e    load our own extension by path. Auto-discovery of the
      //        workspace's .pi/extensions/ is NOT enough: pi loads
      //        project-local extensions only after the project is "trusted",
      //        and nothing can grant that trust in a headless -p run.
      argv.push("-nbt", "-ne", "-e", join(wsPaths(opts.workspaceDir).piExtensions, "doushabao.ts"), opts.prompt);

      const env = { ...baseEnv(), ...opts.env };
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let stdout = "";
        let stderr = "";

        const child = spawn(cfg.piBin, argv, { cwd: opts.workspaceDir, env });
        child.stdin?.end();
        // utf8 encoding buffers any multibyte sequence split across a pipe
        // chunk boundary internally, rather than corrupting it — the
        // reply text is very often CJK.
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ text: "", ok: false, error: `failed to spawn ${cfg.piBin}: ${err.message}` });
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (timedOut) {
            resolve({ text: "", ok: false, error: `pi run timed out after ${timeoutMs}ms` });
            return;
          }
          if (code !== 0) {
            const excerpt = stderr.trim().slice(-STDERR_EXCERPT_MAX_CHARS);
            resolve({ text: "", ok: false, error: `pi exited with code ${code}${excerpt ? `: ${excerpt}` : ""}` });
            return;
          }
          const text = extractReply(stdout);
          if (text === undefined) {
            resolve({ text: "", ok: false, error: "no assistant message_end line found in pi's output" });
            return;
          }
          resolve({ text, ok: true });
        });
      });
    },
  };
}
