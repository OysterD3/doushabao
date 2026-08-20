import { describe, expect, test } from "vitest";
import { checkDocHost } from "./dochost.ts";

const HOSTS = ["alidocs.dingtalk.com", "docs.dingtalk.com"];

describe("checkDocHost", () => {
  test("allows an https URL on an allowlisted host", () => {
    const r = checkDocHost(HOSTS, "https://alidocs.dingtalk.com/i/nodes/abc");
    expect(r.ok).toBe(true);
  });

  test("rejects http — no downgrade from the single source of truth", () => {
    const r = checkDocHost(HOSTS, "http://alidocs.dingtalk.com/x");
    expect(r.ok).toBe(false);
  });

  test("rejects a host not on the allowlist", () => {
    const r = checkDocHost(HOSTS, "https://evil.example.com/x");
    expect(r.ok).toBe(false);
  });

  test("rejects a non-URL", () => {
    expect(checkDocHost(HOSTS, "not a url").ok).toBe(false);
  });

  test("host match is case-insensitive", () => {
    expect(checkDocHost(HOSTS, "https://AliDocs.DingTalk.com/x").ok).toBe(true);
  });
});
