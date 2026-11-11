import { describe, it, expect } from "vitest";
import { validateCloudStartupConfig } from "../src/cloud-entrypoint";

describe("Cloud Entrypoint Configuration Validation (F7-01 & F7-06)", () => {
  it("allows passwordless configuration on local loopback 127.0.0.1", () => {
    const config = validateCloudStartupConfig({
      HOST: "127.0.0.1",
      PORT: "4178",
    });

    expect(config.isLoopback).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.webPassword).toBeUndefined();
  });

  it("allows passwordless configuration on local loopback localhost", () => {
    const config = validateCloudStartupConfig({
      HOST: "localhost",
      PORT: "4178",
    });

    expect(config.isLoopback).toBe(true);
    expect(config.host).toBe("localhost");
  });

  it("F7-01: fails closed on non-loopback host (0.0.0.0) when PRICERADAR_WEB_PASSWORD is missing", () => {
    expect(() => {
      validateCloudStartupConfig({
        HOST: "0.0.0.0",
        PORT: "4178",
      });
    }).toThrow(/Security violation: PRICERADAR_WEB_PASSWORD must be configured/);
  });

  it("F7-01: fails closed on non-loopback host when PRICERADAR_WEB_PASSWORD is empty or whitespace", () => {
    expect(() => {
      validateCloudStartupConfig({
        HOST: "0.0.0.0",
        PORT: "4178",
        PRICERADAR_WEB_PASSWORD: "   ",
      });
    }).toThrow(/Security violation: PRICERADAR_WEB_PASSWORD must be configured/);
  });

  it("F7-01: succeeds on non-loopback host when valid PRICERADAR_WEB_PASSWORD is provided", () => {
    const config = validateCloudStartupConfig({
      HOST: "0.0.0.0",
      PORT: "4178",
      PRICERADAR_WEB_PASSWORD: "SuperSecureProductionPassword123!",
    });

    expect(config.isLoopback).toBe(false);
    expect(config.host).toBe("0.0.0.0");
    expect(config.webPassword).toBe("SuperSecureProductionPassword123!");
  });

  it("defaults to host 0.0.0.0 and enforces authentication when HOST is omitted", () => {
    expect(() => {
      validateCloudStartupConfig({});
    }).toThrow(/Security violation/);

    const config = validateCloudStartupConfig({
      PRICERADAR_WEB_PASSWORD: "valid-password",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe("4178");
  });

  describe("Persistent Storage Contract Validation (F7-11)", () => {
    it("fails closed in cloud environment when persistent volume is not configured", () => {
      expect(() => {
        validateCloudStartupConfig({
          HOST: "0.0.0.0",
          PRICERADAR_WEB_PASSWORD: "secure-password-123",
          PRICERADAR_ENV: "cloud",
          RAILWAY_ENVIRONMENT: "production",
          PRICERADAR_SQLITE_PATH: "/tmp/priceradar-ephemeral/private-history.sqlite",
        });
      }).toThrow(/Storage configuration violation/);
    });

    it("succeeds in cloud environment when attached Railway volume is configured", () => {
      const config = validateCloudStartupConfig({
        HOST: "0.0.0.0",
        PRICERADAR_WEB_PASSWORD: "secure-password-123",
        PRICERADAR_ENV: "cloud",
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        PRICERADAR_SQLITE_PATH: "/tmp/private-history.sqlite",
      });

      expect(config.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
      expect(config.volumeMarker).toBeDefined();
    });

    it("succeeds in CI environment when SIMULATED_CI_VOLUME is configured", () => {
      const config = validateCloudStartupConfig({
        HOST: "0.0.0.0",
        PRICERADAR_WEB_PASSWORD: "secure-password-123",
        PRICERADAR_ENV: "cloud",
        PRICERADAR_PERSISTENCE_TIER: "SIMULATED_CI_VOLUME",
        PRICERADAR_SQLITE_PATH: "/tmp/private-history.sqlite",
      });

      expect(config.persistenceTier).toBe("SIMULATED_CI_VOLUME");
    });
  });
});
