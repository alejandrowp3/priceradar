import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PRICERADAR_PORTS,
  checkPortAvailability,
  FORBIDDEN_PORTS,
  RESERVED_WEB_PORT,
  validatePortPolicy,
} from "./check-port.mjs";
import playwrightConfig, { PRICERADAR_E2E_BASE_URL } from "../playwright.config.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Local port isolation policy & preflight (SC-003)", () => {
  it("reserves port 4178 for web development, preview, and Playwright E2E", () => {
    expect(RESERVED_WEB_PORT).toBe(4178);
    expect(ALLOWED_PRICERADAR_PORTS).toEqual([4178, 6178, 8178]);
    expect(PRICERADAR_E2E_BASE_URL).toBe("http://127.0.0.1:4178");
  });

  it("explicitly rejects all forbidden ports (including 3000, 5173, 8080) and unapproved fallback ports", () => {
    for (const forbidden of FORBIDDEN_PORTS) {
      const verdict = validatePortPolicy(forbidden);
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toContain("explicitly forbidden");
    }

    const arbitraryFallback = validatePortPolicy(4179);
    expect(arbitraryFallback.valid).toBe(false);
    expect(arbitraryFallback.reason).toContain("not an approved PriceRadar port");
  });

  it("detects when an approved port is occupied and fails safely without killing the occupying listener", async () => {
    // Use reserved debug port 8178 to simulate an occupied PriceRadar port deterministically
    const occupiedPort = 8178;
    const dummyServer = net.createServer();

    await new Promise<void>((resolve, reject) => {
      dummyServer.once("error", reject);
      dummyServer.listen(
        { port: occupiedPort, host: "127.0.0.1", exclusive: true },
        () => {
          resolve();
        },
      );
    });

    try {
      const checkResult = await checkPortAvailability({
        port: occupiedPort,
        host: "127.0.0.1",
      });

      expect(checkResult.ok).toBe(false);
      expect(checkResult.code).toBe("EADDRINUSE");
      expect(checkResult.error).toContain("already occupied");
      expect(checkResult.error).toContain("never terminates existing processes");

      // Verify our dummy server is still alive and listening
      expect(dummyServer.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        dummyServer.close(() => resolve());
      });
    }

    // Once closed, the port check should succeed
    const afterClose = await checkPortAvailability({
      port: occupiedPort,
      host: "127.0.0.1",
    });
    expect(afterClose.ok).toBe(true);
  });

  it("verifies apps/web/package.json and playwright.config.ts explicitly enforce port 4178 without fallback", () => {
    const webPkgRaw = fs.readFileSync(
      path.join(rootDir, "apps/web/package.json"),
      "utf8",
    );
    const webPkg = JSON.parse(webPkgRaw) as {
      scripts?: Record<string, string>;
    };

    expect(webPkg.scripts?.dev).toBe("next dev -p 4178 -H 127.0.0.1");
    expect(webPkg.scripts?.start).toBe("next start -p 4178 -H 127.0.0.1");

    const webServer = playwrightConfig.webServer;
    expect(webServer).toBeDefined();
    if (webServer && !Array.isArray(webServer)) {
      expect(webServer.url).toBe("http://127.0.0.1:4178");
      expect(webServer.reuseExistingServer).toBe(false);
      expect(webServer.command).toContain("node scripts/check-port.mjs");
    }
  });

  it("returns exit code 1 from CLI when port 4178 is occupied and preserves the occupying listener", async () => {
    const dummyServer = net.createServer();

    await new Promise<void>((resolve, reject) => {
      dummyServer.once("error", reject);
      dummyServer.listen(
        { port: RESERVED_WEB_PORT, host: "127.0.0.1", exclusive: true },
        () => resolve(),
      );
    });

    try {
      const cliResult = spawnSync(
        process.execPath,
        [path.join(rootDir, "scripts/check-port.mjs")],
        { encoding: "utf8" },
      );

      expect(cliResult.status).toBe(1);
      expect(cliResult.stderr).toContain("[PriceRadar Port Preflight] BLOCKED:");
      expect(cliResult.stderr).toContain("Port 4178 on 127.0.0.1 is already occupied");
      expect(dummyServer.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        dummyServer.close(() => resolve());
      });
    }
  });
});
