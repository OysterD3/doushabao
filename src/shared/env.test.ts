import { afterEach, describe, expect, test } from "vitest";
import { allowlistedEnv } from "./env.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
});

describe("allowlistedEnv", () => {
  test("drops the whole DOUSHABAO_* namespace no matter what is allowlisted", () => {
    process.env.DOUSHABAO_TOKEN = "ipc-secret";
    process.env.DOUSHABAO_ROOT = "/somewhere";
    // Even trying to allow it by exact name must not let it through.
    const env = allowlistedEnv(["DOUSHABAO_TOKEN", "PATH"], ["DOUSHABAO_"]);
    expect(env.DOUSHABAO_TOKEN).toBeUndefined();
    expect(env.DOUSHABAO_ROOT).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });

  test("keeps exactly the allowlisted keys and prefixes, nothing else", () => {
    process.env.DWS_FOO = "1";
    process.env.RANDOM_UNRELATED = "2";
    const env = allowlistedEnv(["HOME"], ["DWS_"]);
    expect(env.DWS_FOO).toBe("1");
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.RANDOM_UNRELATED).toBeUndefined();
  });
});
