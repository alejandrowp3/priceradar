import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  verifyStoragePersistenceContract,
  VOLUME_MARKER_FILENAME,
} from "../src/storage-persistence.ts";

describe("Storage Persistence Contract Verification (F7-11, F7-11A, F7-11B)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-storage-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("F7-11A: Platform Configuration Evidence & Mount Path Validation", () => {
    it("identifies local workspace storage in non-cloud environment", () => {
      const result = verifyStoragePersistenceContract(tempDir, {});
      expect(result.persistenceVerified).toBe(true);
      expect(result.persistenceTier).toBe("LOCAL_WORKSPACE_STORAGE");
      expect(result.evidenceType).toBe("LOCAL_DIRECTORY");
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
      const result = verifyStoragePersistenceContract(tempDir, {
        RAILWAY_ENVIRONMENT: "production",
        PRICERADAR_ENV: "cloud",
      });

      expect(result.persistenceVerified).toBe(false);
      expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
      expect(result.evidenceType).toBe("NONE");
      expect(result.reason).toContain(
        "Railway deployment detected without RAILWAY_VOLUME_MOUNT_PATH",
      );
      expect(result.reason).toContain("Step 2 (Attach Volume at /data)");
    });

    it("fails closed in Railway mode when RAILWAY_VOLUME_NAME is set but RAILWAY_VOLUME_MOUNT_PATH is missing", () => {
      const result = verifyStoragePersistenceContract(tempDir, {
        RAILWAY_ENVIRONMENT: "production",
        PRICERADAR_ENV: "cloud",
        RAILWAY_VOLUME_NAME: "priceradar-data",
      });

      expect(result.persistenceVerified).toBe(false);
      expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
      expect(result.reason).toContain(
        "Railway deployment detected without RAILWAY_VOLUME_MOUNT_PATH",
      );
    });

    it("fails closed in Railway mode when storage location does not reside in RAILWAY_VOLUME_MOUNT_PATH", () => {
      const mismatchedMount = path.join(os.tmpdir(), "other-volume-mount");
      const result = verifyStoragePersistenceContract(tempDir, {
        RAILWAY_ENVIRONMENT: "production",
        PRICERADAR_ENV: "cloud",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        RAILWAY_VOLUME_MOUNT_PATH: mismatchedMount,
      });

      expect(result.persistenceVerified).toBe(false);
      expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
      expect(result.reason).toContain("does not reside within Railway volume mount path");
    });

    it("fails closed when arbitrary PRICERADAR_VOLUME_NAME is passed without valid mount path proof", () => {
      const result = verifyStoragePersistenceContract(tempDir, {
        PRICERADAR_ENV: "cloud",
        PRICERADAR_VOLUME_NAME: "my-fake-volume",
      });

      expect(result.persistenceVerified).toBe(false);
      expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
      expect(result.reason).toContain(
        "Cloud deployment requires verified persistent volume with valid mount path",
      );
    });

    it("succeeds in Railway mode when RAILWAY_VOLUME_MOUNT_PATH matches storage directory", () => {
      const result = verifyStoragePersistenceContract(tempDir, {
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        RAILWAY_VOLUME_MOUNT_PATH: tempDir,
      });

      expect(result.persistenceVerified).toBe(true);
      expect(result.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
      expect(result.evidenceType).toBe("RAILWAY_PLATFORM_MOUNT");
      expect(result.volumeMarker).not.toBeNull();
      expect(result.volumeMarker?.volumeName).toBe("priceradar-data");
      expect(result.volumeMarker?.mountPath).toBe(tempDir);
      expect(result.volumeMarker?.volumeId).toMatch(/^vol-[0-9a-f]{12}$/);
      expect(result.isExistingMarker).toBe(false);
      expect(result.restartProofVerified).toBe(false);
    });

    it("succeeds in Railway mode when storage directory is a child of RAILWAY_VOLUME_MOUNT_PATH", () => {
      const subDir = path.join(tempDir, "sqlite-sub");
      fs.mkdirSync(subDir, { recursive: true });

      const result = verifyStoragePersistenceContract(subDir, {
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        RAILWAY_VOLUME_MOUNT_PATH: tempDir,
      });

      expect(result.persistenceVerified).toBe(true);
      expect(result.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
    });

    it("verifies simulated CI volume when PRICERADAR_PERSISTENCE_TIER=SIMULATED_CI_VOLUME is set in CI/test runner", () => {
      const result = verifyStoragePersistenceContract(tempDir, {
        PRICERADAR_ENV: "cloud",
        PRICERADAR_PERSISTENCE_TIER: "SIMULATED_CI_VOLUME",
        CI: "true",
      });

      expect(result.persistenceVerified).toBe(true);
      expect(result.persistenceTier).toBe("SIMULATED_CI_VOLUME");
      expect(result.evidenceType).toBe("CI_SIMULATED_TEST_MOUNT");
      expect(result.volumeMarker?.volumeName).toBe("simulated-ci-volume");
    });

    it("fails closed when SIMULATED_CI_VOLUME is claimed outside CI/test runner", () => {
      const result = verifyStoragePersistenceContract(tempDir, {
        PRICERADAR_ENV: "cloud",
        PRICERADAR_PERSISTENCE_TIER: "SIMULATED_CI_VOLUME",
        CI: "false",
        NODE_ENV: "production",
      });

      expect(result.persistenceVerified).toBe(false);
      expect(result.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
      expect(result.reason).toContain(
        "strictly restricted to automated CI and test environments",
      );
    });
  });

  describe("F7-11B: Volume Marker Reliability & Fail-Closed Integrity", () => {
    it("fails closed when volume marker cannot be written", () => {
      // Create a read-only directory to force write failure
      const readOnlySubdir = path.join(tempDir, "readonly-dir");
      fs.mkdirSync(readOnlySubdir, { mode: 0o500 });

      try {
        const result = verifyStoragePersistenceContract(readOnlySubdir, {});
        expect(result.persistenceVerified).toBe(false);
        expect(result.reason).toMatch(/not writable|Failed to write/);
      } finally {
        fs.chmodSync(readOnlySubdir, 0o700);
      }
    });

    it("fails closed when existing volume marker contains malformed JSON", () => {
      const markerPath = path.join(tempDir, VOLUME_MARKER_FILENAME);
      fs.writeFileSync(markerPath, "{ malformed json content here ...", "utf-8");

      const result = verifyStoragePersistenceContract(tempDir, {});
      expect(result.persistenceVerified).toBe(false);
      expect(result.reason).toContain("Corrupted volume marker detected");
      expect(result.reason).toContain("invalid JSON");

      // Verify the corrupt file was NOT silently overwritten
      const content = fs.readFileSync(markerPath, "utf-8");
      expect(content).toBe("{ malformed json content here ...");
    });

    it("fails closed when existing volume marker is missing required fields", () => {
      const markerPath = path.join(tempDir, VOLUME_MARKER_FILENAME);
      // Missing createdAt and storagePath
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          volumeId: "vol-abcdef123456",
          persistenceTier: "LOCAL_WORKSPACE_STORAGE",
        }),
        "utf-8",
      );

      const result = verifyStoragePersistenceContract(tempDir, {});
      expect(result.persistenceVerified).toBe(false);
      expect(result.reason).toContain("Incomplete or malformed volume marker");
      expect(result.reason).toContain("missing or invalid required fields");
    });

    it("re-uses valid existing volume marker and verifies restart proof", () => {
      // First boot: creates marker
      const firstResult = verifyStoragePersistenceContract(tempDir, {});
      expect(firstResult.persistenceVerified).toBe(true);
      expect(firstResult.isExistingMarker).toBe(false);
      expect(firstResult.restartProofVerified).toBe(false);

      const originalVolumeId = firstResult.volumeMarker?.volumeId;
      const originalCreatedAt = firstResult.volumeMarker?.createdAt;

      // Second boot (restart / replacement): reuses marker
      const secondResult = verifyStoragePersistenceContract(tempDir, {});
      expect(secondResult.persistenceVerified).toBe(true);
      expect(secondResult.isExistingMarker).toBe(true);
      expect(secondResult.restartProofVerified).toBe(true);
      expect(secondResult.volumeMarker?.volumeId).toBe(originalVolumeId);
      expect(secondResult.volumeMarker?.createdAt).toBe(originalCreatedAt);
    });
  });
});
