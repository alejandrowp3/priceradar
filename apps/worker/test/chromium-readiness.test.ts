import { describe, it, expect } from "vitest";
import { checkChromiumReadiness } from "../src/chromium-readiness";

describe("Chromium Readiness Diagnostic (F7-04)", () => {
  it("runs the diagnostic check and returns a structured status object", async () => {
    const result = await checkChromiumReadiness();

    expect(typeof result.isReady).toBe("boolean");
    if (result.isReady) {
      expect(result.browserVersion).toBeDefined();
      expect(typeof result.browserVersion).toBe("string");
    } else {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    }
  });
});
