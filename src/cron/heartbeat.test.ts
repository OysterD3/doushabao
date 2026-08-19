import { describe, expect, test } from "vitest";
import { ConfigSchema, type ConversationType, type DwsPort } from "../shared/types.ts";
import { checkQuiet, runHeartbeatCheck, type HeartbeatState } from "./heartbeat.ts";

const cfg = ConfigSchema.parse({
  admins: ["admin-1", "admin-2"],
  timezone: "Asia/Shanghai",
  heartbeat: { quietMinutes: 90, workHours: { start: 9, end: 19, days: [1, 2, 3, 4, 5] } },
});

// Tue 2026-08-18 12:00 Asia/Shanghai (UTC+8) = 2026-08-18T04:00:00Z
const TUE_NOON = Date.parse("2026-08-18T04:00:00Z");
// Sat 2026-08-15 12:00 Asia/Shanghai
const SAT_NOON = Date.parse("2026-08-15T04:00:00Z");
// Tue 2026-08-18 08:00 Asia/Shanghai — before work hours start
const TUE_BEFORE_HOURS = Date.parse("2026-08-18T00:00:00Z");
// Tue 2026-08-18 19:00 Asia/Shanghai — exactly at work hours end (exclusive)
const TUE_AT_END = Date.parse("2026-08-18T11:00:00Z");

describe("checkQuiet", () => {
  test("false when the stream is fresh, inside work hours", () => {
    expect(checkQuiet(TUE_NOON, TUE_NOON - 1_000, cfg)).toBe(false);
  });

  test("true when quiet past the threshold, inside work hours", () => {
    const lastEventAt = TUE_NOON - 91 * 60_000;
    expect(checkQuiet(TUE_NOON, lastEventAt, cfg)).toBe(true);
  });

  test("false right at the threshold boundary (not yet over)", () => {
    const lastEventAt = TUE_NOON - 90 * 60_000;
    expect(checkQuiet(TUE_NOON, lastEventAt, cfg)).toBe(false);
  });

  test("false outside work-hour days even if quiet", () => {
    expect(checkQuiet(SAT_NOON, SAT_NOON - 200 * 60_000, cfg)).toBe(false);
  });

  test("false before the work-hours start", () => {
    expect(checkQuiet(TUE_BEFORE_HOURS, TUE_BEFORE_HOURS - 200 * 60_000, cfg)).toBe(false);
  });

  test("false at/after the work-hours end (exclusive)", () => {
    expect(checkQuiet(TUE_AT_END, TUE_AT_END - 200 * 60_000, cfg)).toBe(false);
  });

  test("NaN lastEventAt (missing file) never triggers an alert", () => {
    expect(checkQuiet(TUE_NOON, NaN, cfg)).toBe(false);
  });
});

function fakeDws(): DwsPort & { sent: { conversationId: string; type: ConversationType; text: string }[] } {
  const sent: { conversationId: string; type: ConversationType; text: string }[] = [];
  return {
    sent,
    async startConsuming() {},
    async stopConsuming() {},
    async sendText(conversationId, conversationType, text) {
      sent.push({ conversationId, type: conversationType, text });
      return {};
    },
    async downloadMedia() {
      return [];
    },
    async exportDoc() {},
    async doctor() {
      return { ok: true, detail: "" };
    },
  };
}

describe("runHeartbeatCheck", () => {
  test("alerts every admin by DM when quiet", async () => {
    const dws = fakeDws();
    const state: HeartbeatState = { lastAlertAt: 0 };
    const lastEventAt = TUE_NOON - 91 * 60_000;
    const fired = await runHeartbeatCheck({ cfg, dws }, state, TUE_NOON, lastEventAt);
    expect(fired).toBe(true);
    expect(dws.sent).toHaveLength(2);
    expect(dws.sent.map((s) => s.conversationId)).toEqual(["admin-1", "admin-2"]);
    expect(dws.sent[0]?.type).toBe("dm");
  });

  test("does not alert when not quiet", async () => {
    const dws = fakeDws();
    const state: HeartbeatState = { lastAlertAt: 0 };
    const fired = await runHeartbeatCheck({ cfg, dws }, state, TUE_NOON, TUE_NOON - 1_000);
    expect(fired).toBe(false);
    expect(dws.sent).toHaveLength(0);
  });

  test("throttles to one alert per 6h", async () => {
    const dws = fakeDws();
    const state: HeartbeatState = { lastAlertAt: 0 };
    const lastEventAt = TUE_NOON - 91 * 60_000;
    await runHeartbeatCheck({ cfg, dws }, state, TUE_NOON, lastEventAt);
    expect(dws.sent).toHaveLength(2);

    // Still quiet 5 minutes later — throttled, no new sends.
    const fired = await runHeartbeatCheck({ cfg, dws }, state, TUE_NOON + 5 * 60_000, lastEventAt);
    expect(fired).toBe(false);
    expect(dws.sent).toHaveLength(2);

    // 6h+1min later — alert again.
    const fired2 = await runHeartbeatCheck({ cfg, dws }, state, TUE_NOON + (6 * 60 + 1) * 60_000, lastEventAt);
    expect(fired2).toBe(true);
    expect(dws.sent).toHaveLength(4);
  });

  test("one admin's failed send does not block the rest", async () => {
    const dws = fakeDws();
    dws.sendText = async (conversationId, conversationType, text) => {
      if (conversationId === "admin-1") throw new Error("dws down");
      dws.sent.push({ conversationId, type: conversationType, text });
      return {};
    };
    const state: HeartbeatState = { lastAlertAt: 0 };
    const lastEventAt = TUE_NOON - 91 * 60_000;
    const fired = await runHeartbeatCheck({ cfg, dws }, state, TUE_NOON, lastEventAt);
    expect(fired).toBe(true);
    expect(dws.sent).toHaveLength(1);
    expect(dws.sent[0]?.conversationId).toBe("admin-2");
  });
});
