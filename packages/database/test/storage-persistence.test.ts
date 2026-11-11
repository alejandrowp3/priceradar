import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  verifyStoragePersistenceContract,
  VOLUME_MARKER_FILENAME,
} from "../src/storage-persistence.ts";

describe("Storage Persistence Contract Verification (F7-11)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-storage-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("identifies local workspace storage in non-cloud environment", () => {
    const result = verifyStoragePersistenceContract(tempDir, {});
    expect(result.persistenceVerified).toBe(true);
    expect(result.persistenceTier).toBe("LOCAL_WORKSPACE_STORAGE");
    expect(result.storageDirExists).toBe(true);
    expect(result.storageDirWritable).toBe(true);
    expect(result.volumeMarker).toBeDefined();
    expect(result.volumeMarker?.persistenceTier).toBe("LOCAL_WORKSPACE_STORAGE");
  });

  it("fails closed when storage directory does not exist", () => {
    const nonexistent = path.join(tempDir, "missing-dir");
    const result = verifyStoragePersistenceContract(nonexistent, {});
    expect(result.persistenceVerified).toBe(false);
    expect(result.storageDirExists).toBe(false);
    expect(result.reason).toContain("Storage directory does not exist");
  });

  it("fails closed in cloud mode when running on unverified ephemeral container filesystem", () => {
    // Railway environment set, but no persistent volume variables attached
    const result = verifyStoragePersistenceContract(tempDir, {
      RAILWAY_ENVIRONMENT: "production",
      PRICERADAR_ENV: "cloud",
    });

    expect(result.persistenceVerified).toBe(false);
    expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
    expect(result.storageDirExists).toBe(true);
    expect(result.storageDirWritable).toBe(true);
    expect(result.reason).toContain(
      "Railway deployment detected without attached persistent volume",
    );
    expect(result.reason).toContain("Step 2 (Attach Volume at /data)");
  });

  it("fails closed in generic cloud mode without volume proof", () => {
    const result = verifyStoragePersistenceContract(tempDir, {
      PRICERADAR_ENV: "cloud",
    });

    expect(result.persistenceVerified).toBe(false);
    expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
    expect(result.reason).toContain(
      "Cloud deployment requires verified persistent volume",
    );
  });

  it("verifies Railway persistent volume when RAILWAY_VOLUME_NAME is provided", () => {
    const result = verifyStoragePersistenceContract(tempDir, {
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_NAME: "priceradar-data",
    });

    expect(result.persistenceVerified).toBe(true);
    expect(result.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
    expect(result.volumeMarker).not.toBeNull();
    expect(result.volumeMarker?.volumeName).toBe("priceradar-data");
    expect(result.volumeMarker?.hostEnvironment).toBe("railway:production");
    expect(result.volumeMarker?.volumeId).toMatch(/^vol-[0-9a-f]{12}$/);
    expect(result.isExistingMarker).toBe(false);

    // Verify atomic marker file was written to disk
    const markerFile = path.join(tempDir, VOLUME_MARKER_FILENAME);
    expect(fs.existsSync(markerFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(markerFile, "utf-8"));
    expect(content.volumeId).toBe(result.volumeMarker?.volumeId);
  });

  it("verifies simulated CI volume when PRICERADAR_PERSISTENCE_TIER=SIMULATED_CI_VOLUME is set", () => {
    const result = verifyStoragePersistenceContract(tempDir, {
      PRICERADAR_ENV: "cloud",
      PRICERADAR_PERSISTENCE_TIER: "SIMULATED_CI_VOLUME",
    });

    expect(result.persistenceVerified).toBe(true);
    expect(result.persistenceTier).toBe("SIMULATED_CI_VOLUME");
    expect(result.volumeMarker?.volumeName).toBe("simulated-ci-volume");
  });

  it("re-uses existing volume marker and preserves volumeId across container restart / reconnect", () => {
    // Initial container initialization
    const firstResult = verifyStoragePersistenceContract(tempDir, {
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_NAME: "priceradar-data",
    });
    expect(firstResult.persistenceVerified).toBe(true);
    expect(firstResult.isExistingMarker).toBe(false);
    const originalVolumeId = firstResult.volumeMarker?.volumeId;
    const originalCreatedAt = firstResult.volumeMarker?.createdAt;

    // Simulate container replacement / restart mounting the exact same persistent storage
    const restartResult = verifyStoragePersistenceContract(tempDir, {
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_NAME: "priceradar-data",
    });

    expect(restartResult.persistenceVerified).toBe(true);
    expect(restartResult.isExistingMarker).toBe(true);
    expect(restartResult.volumeMarker?.volumeId).toBe(originalVolumeId);
    expect(restartResult.volumeMarker?.createdAt).toBe(originalCreatedAt);
  });
});
