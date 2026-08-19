import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../shared/types.ts";
import { createPiRunner } from "./index.ts";

const FAKE_PI = join(import.meta.dirname, "../../test/fakes/fake-pi.ts");

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...ConfigSchema.parse({}), ...overrides };
}

/** Writes an executable stand-in for the pi binary. Fixtures are plain-JS
 * `.mjs`, not `.ts`: they land in a tmp dir with no package.json, so the
 * extension is the only thing telling Node they are ESM. The shebang + chmod
 * matter too — createPiRunner execs cfg.piBin directly. */
function writeFixture(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function lastLogEntry(logFile: string): { ts: number; cwd: string; argv: string[]; prompt: string } {
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

describe("createPiRunner", () => {
  let tmp: string;

  afterEach(() => {
    delete process.env.DOUSHABAO_TEST_MARKER;
  });

  test("returns the matched scenario's text on success", async () => {
    tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
    const scenario = join(tmp, "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        responses: [{ match: "weather", text: "It is sunny." }],
        default: { text: "ok" },
      }),
    );
    const cfg = makeConfig({ piBin: FAKE_PI });
    const runner = createPiRunner(cfg);

    const result = await runner.run({
      workspaceDir: tmp,
      sessionId: "2026-08-19-conv1",
      prompt: "what's the weather like",
      env: { FAKE_PI_SCENARIO: scenario },
    });

    expect(result).toEqual({ text: "It is sunny.", ok: true });
  });

  test("falls back to the scenario default when nothing matches", async () => {
    tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
    const scenario = join(tmp, "scenario.json");
    writeFileSync(scenario, JSON.stringify({ responses: [{ match: "never-seen", text: "nope" }], default: { text: "ok" } }));
    const cfg = makeConfig({ piBin: FAKE_PI });
    const runner = createPiRunner(cfg);

    const result = await runner.run({
      workspaceDir: tmp,
      sessionId: "2026-08-19-conv1",
      prompt: "hello there",
      env: { FAKE_PI_SCENARIO: scenario },
    });

    expect(result).toEqual({ text: "ok", ok: true });
  });

  describe("argv construction", () => {
    test.each([
      ["override model wins", "override-model", "cheap-default", ["--model", "override-model"]],
      ["falls back to cfg.models.default", undefined, "cheap-default", ["--model", "cheap-default"]],
      ["omits --model when neither is set", undefined, "", undefined],
    ])("%s", async (_label, optsModel, cfgDefault, expectedModelArgs) => {
      tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
      const scenario = join(tmp, "scenario.json");
      const log = join(tmp, "log.jsonl");
      writeFileSync(scenario, JSON.stringify({ default: { text: "ok" } }));
      const cfg = makeConfig({ piBin: FAKE_PI, models: { ...ConfigSchema.parse({}).models, default: cfgDefault } });
      const runner = createPiRunner(cfg);

      await runner.run({
        workspaceDir: tmp,
        sessionId: "2026-08-19-conv1",
        prompt: "some prompt text",
        model: optsModel,
        env: { FAKE_PI_SCENARIO: scenario, FAKE_PI_LOG: log },
      });

      const entry = lastLogEntry(log);
      // macOS resolves the tmpdir's /var symlink to /private/var by the time
      // the child process reports its cwd, so compare real paths.
      expect(entry.cwd).toBe(realpathSync(tmp));
      const expectedArgv = [
        "-p",
        "--mode",
        "json",
        "--session-id",
        "2026-08-19-conv1",
        ...(expectedModelArgs ?? []),
        "-nbt",
        "-ne",
        "-e",
        join(tmp, ".pi", "extensions", "doushabao.ts"),
        "some prompt text",
      ];
      expect(entry.argv).toEqual(expectedArgv);
      expect(entry.prompt).toBe("some prompt text");
    });

    test("always locks the tool surface: no built-ins, no inherited extensions, ours loaded by path", async () => {
      tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
      const scenario = join(tmp, "scenario.json");
      const log = join(tmp, "log.jsonl");
      writeFileSync(scenario, JSON.stringify({ default: { text: "ok" } }));
      const runner = createPiRunner(makeConfig({ piBin: FAKE_PI }));

      await runner.run({
        workspaceDir: tmp,
        sessionId: "s1",
        prompt: "x",
        env: { FAKE_PI_SCENARIO: scenario, FAKE_PI_LOG: log },
      });

      const { argv } = lastLogEntry(log);
      // -nbt alone is not enough: without -ne the workspace inherits whatever
      // extensions live in the host account's ~/.pi (shell-granting ones
      // included), and without -e ours never loads at all, because pi gates
      // project-local .pi/extensions/ behind project trust.
      expect(argv).toContain("-nbt");
      expect(argv).toContain("-ne");
      expect(argv[argv.indexOf("-e") + 1]).toBe(join(tmp, ".pi", "extensions", "doushabao.ts"));
    });
  });

  test("merges opts.env over inherited process.env", async () => {
    tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
    const fixture = writeFixture(
      tmp,
      "envecho.mjs",
      [
        'const ambient = process.env.DOUSHABAO_TEST_MARKER ?? "";',
        'const foo = process.env.FOO ?? "";',
        'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `ambient=${ambient} foo=${foo}` }] } }));',
      ].join("\n"),
    );
    process.env.DOUSHABAO_TEST_MARKER = "amb1";
    const cfg = makeConfig({ piBin: fixture });
    const runner = createPiRunner(cfg);

    const result = await runner.run({
      workspaceDir: tmp,
      sessionId: "s1",
      prompt: "irrelevant",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({ text: "ambient=amb1 foo=bar", ok: true });
  });

  test("uses the LAST assistant message_end line, tolerating non-JSON and unrelated lines", async () => {
    tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
    const fixture = writeFixture(
      tmp,
      "tolerant.mjs",
      [
        'console.log("not json at all");',
        'console.log(JSON.stringify({ type: "session", id: "x" }));',
        'console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } }));',
        'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }));',
        'console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "1" }));',
        'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }));',
      ].join("\n"),
    );
    const cfg = makeConfig({ piBin: fixture });
    const runner = createPiRunner(cfg);

    const result = await runner.run({ workspaceDir: tmp, sessionId: "s1", prompt: "x", env: {} });

    expect(result).toEqual({ text: "final answer", ok: true });
  });

  test("ok:false with a stderr excerpt on nonzero exit", async () => {
    tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
    const fixture = writeFixture(tmp, "fail.mjs", ['process.stderr.write("boom: something failed\\n");', "process.exit(3);"].join("\n"));
    const cfg = makeConfig({ piBin: fixture });
    const runner = createPiRunner(cfg);

    const result = await runner.run({ workspaceDir: tmp, sessionId: "s1", prompt: "x", env: {} });

    expect(result.ok).toBe(false);
    expect(result.text).toBe("");
    expect(result.error).toContain("code 3");
    expect(result.error).toContain("boom: something failed");
  });

  test("ok:false on timeout, and kills the child", async () => {
    tmp = mkdtempSync(join(tmpdir(), "doushabao-pi-"));
    const fixture = writeFixture(
      tmp,
      "slow.mjs",
      ['await new Promise((r) => setTimeout(r, 30000));', 'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "too late" }] } }));'].join(
        "\n",
      ),
    );
    const cfg = makeConfig({ piBin: fixture });
    const runner = createPiRunner(cfg);

    const result = await runner.run({ workspaceDir: tmp, sessionId: "s1", prompt: "x", env: {}, timeoutMs: 250 });

    expect(result.ok).toBe(false);
    expect(result.text).toBe("");
    expect(result.error).toContain("timed out");
  }, 10000);

  test("ok:false when the binary cannot be spawned", async () => {
    const cfg = makeConfig({ piBin: join(tmpdir(), "doushabao-pi-does-not-exist-xyz") });
    const runner = createPiRunner(cfg);

    const result = await runner.run({ workspaceDir: tmpdir(), sessionId: "s1", prompt: "x", env: {} });

    expect(result.ok).toBe(false);
    expect(result.text).toBe("");
    expect(result.error).toBeDefined();
  });
});
