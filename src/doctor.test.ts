import { describe, expect, test, vi } from "vitest";
import { runDoctor } from "./doctor.ts";

describe("runDoctor", () => {
  test("runs every check and returns 0 (ready) or 1 (a blocking problem), never throws", async () => {
    // It writes a report to stdout; silence it so the suite output stays clean.
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await runDoctor();
      expect([0, 1]).toContain(code);
      // The report was actually produced.
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("doushabao doctor");
      expect(printed).toContain("expert templates");
    } finally {
      out.mockRestore();
    }
  });
});
