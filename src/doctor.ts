/**
 * `node src/index.ts --doctor` — a preflight that turns the eight-step SETUP.md
 * into one command that says exactly which prerequisite is failing. Owned by
 * main. Read-only: it probes, it never changes anything.
 *
 * Exit code is 0 only when nothing FAILED (warnings are allowed), so it is
 * usable in a script or a launchd pre-check.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { paths } from "./shared/paths.ts";
import { EXPERTS } from "./shared/types.ts";
import type { Config } from "./shared/types.ts";

type Status = "ok" | "warn" | "fail";
interface Check {
  status: Status;
  label: string;
  detail: string;
}

const NODE_MIN = [22, 18];

function nodeVersionCheck(): Check {
  const [maj, min] = process.versions.node.split(".").map(Number);
  const ok = (maj ?? 0) > NODE_MIN[0]! || ((maj ?? 0) === NODE_MIN[0] && (min ?? 0) >= NODE_MIN[1]!);
  return {
    status: ok ? "ok" : "fail",
    label: "Node.js >= 22.18",
    detail: ok ? `v${process.versions.node}` : `v${process.versions.node} — too old to run the .ts sources`,
  };
}

function loadConfigCheck(): { check: Check; cfg?: Config } {
  if (!existsSync(paths.config)) {
    return {
      check: {
        status: "warn",
        label: "config/doushabao.json",
        detail: "not found — running on all defaults (copy config/doushabao.example.json)",
      },
    };
  }
  try {
    const cfg = loadConfig();
    return { check: { status: "ok", label: "config/doushabao.json", detail: "parses" }, cfg };
  } catch (err) {
    return {
      check: { status: "fail", label: "config/doushabao.json", detail: `invalid: ${(err as Error).message}` },
    };
  }
}

/** A binary is reachable if `<bin> --version` (or any invocation) does not fail
 * with ENOENT. We don't care about the exit code, only that it ran. */
function binaryCheck(label: string, bin: string, versionArgs: string[]): Check {
  const r = spawnSync(bin, versionArgs, { encoding: "utf8" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: "fail", label, detail: `"${bin}" not found on PATH` };
  }
  return { status: "ok", label, detail: `found (${bin})` };
}

/** `dws auth status` exit 0 = authenticated. Non-zero = installed but not
 * logged in — a warning, since the doctor can't log in for you. */
function dwsAuthCheck(bin: string): Check {
  const found = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (found.error && (found.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: "fail", label: "dws authenticated", detail: `"${bin}" not found — install it first` };
  }
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8" });
  return r.status === 0
    ? { status: "ok", label: "dws authenticated", detail: (r.stdout || "ok").trim().split("\n")[0] ?? "ok" }
    : { status: "warn", label: "dws authenticated", detail: "installed but not logged in — run `dws auth login`" };
}

function modelCheck(cfg: Config | undefined): Check {
  const model = cfg?.models.default;
  return model
    ? { status: "ok", label: "model configured", detail: model }
    : { status: "warn", label: "model configured", detail: "models.default is empty — pi will use its own default" };
}

function portCheck(cfg: Config | undefined): Promise<Check> {
  const host = cfg?.http.host ?? "127.0.0.1";
  const port = cfg?.http.port ?? 8787;
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", (err) => {
      resolve({
        status: (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? "fail" : "warn",
        label: "IPC port free",
        detail: `${host}:${port} — ${(err as Error).message}`,
      });
    });
    srv.listen(port, host, () => srv.close(() => resolve({ status: "ok", label: "IPC port free", detail: `${host}:${port}` })));
  });
}

function expertsCheck(): Check {
  const missing = EXPERTS.filter((e) => !existsSync(join(paths.experts, e, "AGENTS.md")));
  return missing.length === 0
    ? { status: "ok", label: "expert templates", detail: `${EXPERTS.length} present` }
    : { status: "fail", label: "expert templates", detail: `missing: ${missing.join(", ")}` };
}

function extraExtensionsCheck(cfg: Config | undefined): Check | undefined {
  const extras = cfg?.piExtraExtensions ?? [];
  if (extras.length === 0) return undefined; // nothing configured — don't clutter the report
  const missing = extras.filter((e) => !existsSync(e.path));
  return missing.length === 0
    ? { status: "ok", label: "extra pi extensions", detail: `${extras.length} loadable` }
    : { status: "fail", label: "extra pi extensions", detail: `path not found: ${missing.map((e) => e.path).join(", ")}` };
}

const ICON: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

export async function runDoctor(): Promise<number> {
  const { check: configCheck, cfg } = loadConfigCheck();
  const checks: Check[] = [
    nodeVersionCheck(),
    configCheck,
    binaryCheck("pi installed", cfg?.piBin ?? "pi", ["--version"]),
    dwsAuthCheck(cfg?.dwsBin ?? "dws"),
    modelCheck(cfg),
    expertsCheck(),
    await portCheck(cfg),
  ];
  const extras = extraExtensionsCheck(cfg);
  if (extras) checks.push(extras);

  process.stdout.write("\ndoushabao doctor\n\n");
  for (const c of checks) process.stdout.write(`  ${ICON[c.status]}  ${c.label.padEnd(22)} ${c.detail}\n`);

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  process.stdout.write(
    `\n${failed === 0 ? "Ready" : `${failed} blocking problem${failed === 1 ? "" : "s"}`}` +
      `${warned > 0 ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}.` +
      ` See SETUP.md for the steps.\n\n`,
  );
  return failed === 0 ? 0 : 1;
}
