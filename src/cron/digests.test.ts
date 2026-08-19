import { describe, expect, test } from "vitest";
import { Cron } from "croner";
import { digestJobInput } from "./digests.ts";

describe("digestJobInput", () => {
  test("standup: valid weekday 09:00 cron expression", () => {
    const input = digestJobInput("standup", "conv-1");
    expect(input.conversationId).toBe("conv-1");
    expect(() => new Cron(input.cronExpr, { timezone: "Asia/Shanghai", paused: true })).not.toThrow();

    // From a Saturday, the next run must be Monday 09:00.
    const cron = new Cron(input.cronExpr, { timezone: "Asia/Shanghai" }, () => {});
    const next = cron.nextRun(new Date("2026-08-15T00:00:00.000Z")); // Sat
    cron.stop();
    expect(next).not.toBeNull();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(next!);
    expect(parts.find((p) => p.type === "weekday")?.value).toBe("Mon");
    expect(parts.find((p) => p.type === "hour")?.value).toBe("09");
  });

  test("kb-gaps: valid Monday 10:00 cron expression", () => {
    const input = digestJobInput("kb-gaps", "conv-2");
    expect(input.conversationId).toBe("conv-2");
    const cron = new Cron(input.cronExpr, { timezone: "Asia/Shanghai" }, () => {});
    const next = cron.nextRun(new Date("2026-08-15T00:00:00.000Z")); // Sat
    cron.stop();
    expect(next).not.toBeNull();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(next!);
    expect(parts.find((p) => p.type === "weekday")?.value).toBe("Mon");
    expect(parts.find((p) => p.type === "hour")?.value).toBe("10");
  });

  test("both kinds carry a non-empty description and prompt", () => {
    for (const kind of ["standup", "kb-gaps"] as const) {
      const input = digestJobInput(kind, "conv-1");
      expect(input.description.length).toBeGreaterThan(0);
      expect(input.prompt.length).toBeGreaterThan(0);
      expect(input.createdBy).toBe("system");
    }
  });
});
