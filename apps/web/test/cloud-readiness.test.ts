import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { checkSystemReadiness, checkStorageReadiness } from "../src/lib/db";
import { GET as healthRoute } from "../src/app/api/health/route";
import { GET as telemetryRoute } from "../src/app/api/telemetry/route";
import { middleware, isCloudMode } from "../src/middleware";
import {
  SqlitePrivateHistoryRepository,
  isRailwayEnvironment,
  isCloudDeployment,
} from "@priceradar/database";
import { validateCloudStartupConfig } from "../../worker/src/cloud-entrypoint";
import type { DiscoveredListing } from "@priceradar/domain";
import { createCopAmount } from "@priceradar/domain";

const VALID_CTX_HASH = "ctx-88be5762563932c5";

describe("Cloud Readiness & Health Probes (F7-10 & F7-11)", () => {
  let tempDir: string;
  let dbPath: string;
  let statusFilePath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-cloud-readiness-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
    statusFilePath = path.join(tempDir, "scheduler-status.json");
    process.env.PRICERADAR_SQLITE_PATH = dbPath;
    process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("F7-10: Positive Scheduler Evidence Verification in Cloud Mode", () => {
    const getCloudEnv = (): NodeJS.ProcessEnv => ({
      PRICERADAR_ENV: "cloud",
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_VOLUME_NAME: "priceradar-data",
      RAILWAY_VOLUME_MOUNT_PATH: tempDir,
    });

    it("Case 1: Actively running scheduler with fresh heartbeat reports healthy (ready: true, HTTP 200)", async () => {
      // Create fresh valid scheduler status file
      const now = Date.now();
      fs.writeFileSync(
        statusFilePath,
        JSON.stringify({
          isRunning: true,
          totalScansExecuted: 3,
          lastHeartbeatAt: new Date(now - 10_000).toISOString(),
          intervalMinutes: 60,
          activeProvider: "fixture-catalog",
        }),
        "utf-8",
      );

      const readiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        nowMs: now,
      });

      expect(readiness.ready).toBe(true);
      expect(readiness.schedulerReady).toBe(true);
      expect(readiness.storage.ready).toBe(true);
      expect(readiness.reason).toBeUndefined();

      // Test HTTP /api/health endpoint
      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        status: "healthy",
        ready: true,
      });
    });

    it("Case 2: Missing status file / no scheduler reports unhealthy after initialization policy (HTTP 503)", async () => {
      // Ensure no status file exists
      if (fs.existsSync(statusFilePath)) {
        fs.unlinkSync(statusFilePath);
      }

      // Beyond startup grace period
      const readiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        uptimeMs: 30_000,
        startupGracePeriodMs: 10_000,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.schedulerReady).toBe(false);
      expect(readiness.reason).toContain(
        "Missing scheduler status: no active scheduler process found",
      );

      // Verify HTTP /api/health returns 503
      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.status).toBe("unhealthy");
      expect(json.ready).toBe(false);
    });

    it("Case 3: Explicitly stopped scheduler (isRunning: false) reports unhealthy (HTTP 503)", async () => {
      const now = Date.now();
      fs.writeFileSync(
        statusFilePath,
        JSON.stringify({
          isRunning: false,
          totalScansExecuted: 5,
          lastHeartbeatAt: new Date(now - 5_000).toISOString(),
          intervalMinutes: 60,
          activeProvider: "fixture-catalog",
        }),
        "utf-8",
      );

      const readiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        nowMs: now,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.schedulerReady).toBe(false);
      expect(readiness.reason).toContain("Scheduler is explicitly stopped or inactive");

      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(503);
    });

    it("Case 4: Stale heartbeat (heartbeatAgeMs > 90s) reports unhealthy (HTTP 503)", async () => {
      const now = Date.now();
      const staleHeartbeatTime = new Date(now - 120_000).toISOString(); // 2 minutes ago
      fs.writeFileSync(
        statusFilePath,
        JSON.stringify({
          isRunning: true,
          totalScansExecuted: 2,
          lastHeartbeatAt: staleHeartbeatTime,
          intervalMinutes: 60,
          activeProvider: "fixture-catalog",
        }),
        "utf-8",
      );

      const readiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        nowMs: now,
        freshnessThresholdMs: 90_000,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.schedulerReady).toBe(false);
      expect(readiness.reason).toContain("Scheduler heartbeat is stale or inactive");

      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(503);
    });

    it("Case 5: Corrupted status file (invalid JSON) reports unhealthy (HTTP 503)", async () => {
      fs.writeFileSync(statusFilePath, "NOT_VALID_JSON{{{ corrupted content", "utf-8");

      const readiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        uptimeMs: 30_000,
        startupGracePeriodMs: 10_000,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.schedulerReady).toBe(false);
      expect(readiness.reason).toContain(
        "Missing scheduler status: no active scheduler process found",
      );

      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(503);
    });

    it("Case 6: Future heartbeat timestamp (> now + 5s) reports unhealthy (HTTP 503)", async () => {
      const now = Date.now();
      const futureHeartbeatTime = new Date(now + 60_000).toISOString(); // 1 minute in the future
      fs.writeFileSync(
        statusFilePath,
        JSON.stringify({
          isRunning: true,
          totalScansExecuted: 1,
          lastHeartbeatAt: futureHeartbeatTime,
          intervalMinutes: 60,
          activeProvider: "fixture-catalog",
        }),
        "utf-8",
      );

      const readiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        nowMs: now,
        maxFutureToleranceMs: 5_000,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.schedulerReady).toBe(false);
      expect(readiness.reason).toContain("future-dated (clock skew or invalid state)");

      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(503);
    });

    it("Case 7: Initial startup window behavior and prevention of readiness deadlock", async () => {
      // 7a. Within startup grace window when scheduler is still booting (no status file yet)
      const bootingReadiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        uptimeMs: 3_000, // Process just booted 3s ago
        startupGracePeriodMs: 10_000,
      });

      expect(bootingReadiness.ready).toBe(false);
      expect(bootingReadiness.reason).toContain(
        "Scheduler is initializing during startup grace window",
      );

      // 7b. Scheduler has just started: 0 scans executed yet, but running with fresh heartbeat on first-time DB
      const now = Date.now();
      fs.writeFileSync(
        statusFilePath,
        JSON.stringify({
          isRunning: true,
          totalScansExecuted: 0,
          lastHeartbeatAt: new Date(now - 1_000).toISOString(),
          intervalMinutes: 60,
          activeProvider: "fixture-catalog",
        }),
        "utf-8",
      );

      const initialStartupReadiness = checkSystemReadiness({
        env: { ...process.env, ...getCloudEnv() },
        nowMs: now,
      });

      expect(initialStartupReadiness.ready).toBe(true);
      expect(initialStartupReadiness.isInitialStartup).toBe(true);
      expect(initialStartupReadiness.storage.isFirstTimeInit).toBe(true);
      expect(initialStartupReadiness.schedulerReady).toBe(true);

      // Verify HTTP /api/health succeeds without deadlock on initial startup
      Object.assign(process.env, getCloudEnv());
      const res = await healthRoute();
      expect(res.status).toBe(200);
    });
  });

  describe("F7-11: Verified Persistent Storage Contract & Data Survivability", () => {
    it("fails closed in cloud mode when running on unverified ephemeral container filesystem", async () => {
      const ephemeralEnv = {
        ...process.env,
        PRICERADAR_ENV: "cloud",
        RAILWAY_ENVIRONMENT: "production",
      };
      delete ephemeralEnv.RAILWAY_VOLUME_NAME;
      delete ephemeralEnv.RAILWAY_VOLUME_MOUNT_PATH;
      delete ephemeralEnv.PRICERADAR_VOLUME_NAME;
      delete ephemeralEnv.PRICERADAR_VOLUME_MOUNT_PATH;
      delete ephemeralEnv.PRICERADAR_PERSISTENCE_TIER;

      const storageResult = checkStorageReadiness({ env: ephemeralEnv });
      expect(storageResult.ready).toBe(false);
      expect(storageResult.persistenceVerified).toBe(false);
      expect(storageResult.persistenceTier).toBe("UNVERIFIED_EPHEMERAL_FILESYSTEM");
      expect(storageResult.reason).toContain(
        "Railway deployment detected without RAILWAY_VOLUME_MOUNT_PATH",
      );

      const systemResult = checkSystemReadiness({ env: ephemeralEnv });
      expect(systemResult.ready).toBe(false);
      expect(systemResult.reason).toContain(
        "Railway deployment detected without RAILWAY_VOLUME_MOUNT_PATH",
      );

      // HTTP /api/health must reject unverified ephemeral storage with HTTP 503
      Object.assign(process.env, ephemeralEnv);
      const res = await healthRoute();
      expect(res.status).toBe(503);
    });

    it("verifies Railway persistent volume and surfaces telemetry to authenticated operators", async () => {
      const railwayEnv = {
        ...process.env,
        PRICERADAR_ENV: "cloud",
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        RAILWAY_VOLUME_MOUNT_PATH: tempDir,
      };

      const storageResult = checkStorageReadiness({ env: railwayEnv });
      expect(storageResult.ready).toBe(true);
      expect(storageResult.persistenceVerified).toBe(true);
      expect(storageResult.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
      expect(storageResult.evidenceType).toBe("RAILWAY_PLATFORM_MOUNT");
      expect(storageResult.volumeMarker?.volumeName).toBe("priceradar-data");

      // Verify telemetry endpoint exposes persistenceTier, evidenceType, and volumeMarker
      Object.assign(process.env, railwayEnv);
      const res = await telemetryRoute();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.storageReadiness.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
      expect(json.storageReadiness.evidenceType).toBe("RAILWAY_PLATFORM_MOUNT");
      expect(json.storageReadiness.persistenceVerified).toBe(true);
      expect(json.storageReadiness.volumeMarker.volumeId).toBeDefined();
    });

    it("proves observation, scan run, and product data survivability across container replacement using same volume", () => {
      const volumeEnv = {
        ...process.env,
        PRICERADAR_ENV: "cloud",
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        RAILWAY_VOLUME_MOUNT_PATH: tempDir,
      };

      // --- Container 1 Lifecycle ---
      const initStorage = checkStorageReadiness({ env: volumeEnv });
      expect(initStorage.persistenceVerified).toBe(true);
      const volumeMarkerId = initStorage.volumeMarker?.volumeId;
      expect(volumeMarkerId).toBeDefined();
      expect(initStorage.isExistingMarker).toBe(false);
      expect(initStorage.restartProofVerified).toBe(false);

      const repo1 = new SqlitePrivateHistoryRepository(dbPath);
      const listing: DiscoveredListing = {
        providerId: "fixture-catalog",
        store: {
          providerId: "fixture-catalog",
          externalStoreId: "store-001",
          name: "Test Store",
          categorySlug: "test",
        },
        variant: {
          externalProductId: "prod-cloud-survive-001",
          externalVariantId: "var-001",
          name: "Durable Cloud Product",
          brand: "Test Brand",
          categorySlug: "test",
          categoryName: "Test Category",
          packagingLabel: "1 unidad",
          unitQuantity: 1,
          unitType: "unit",
          productUrl: "https://example.com/test",
        },
        geographicContext: {
          countryCode: "CO",
          citySlug: "bogota",
          cityName: "Bogota",
          fulfillmentContextHash: VALID_CTX_HASH,
        },
        observedPriceCop: createCopAmount(25000),
        availability: "IN_STOCK",
        provenance: "DEMO_FIXTURE",
        sourceObservedAt: "2026-11-11T12:00:00.000Z",
      };

      const scanResult1 = repo1.persistApprovedInspectionBatch(
        {
          scanRunId: "scan-container-1",
          observedAtIso: "2026-11-11T12:00:00.000Z",
          gateStatus: "VERIFIED_ACTIVE_SELECTION",
          hasSecurityChallenge: false,
          isLoginRequired: false,
          isDeliveryContextVerified: true,
          citySlug: "bogota",
          cityName: "Bogota",
          fulfillmentContextHash: VALID_CTX_HASH,
          activeAddressSelection: "VERIFIED_ACTIVE_SELECTION",
          cityAndNeighborhoodMetadata: "VERIFIED_FROM_ACTIVE_CONTEXT",
          servingStoreBranch: "VERIFIED_ACTIVE_BRANCH",
          productCatalogContext: "HYDRATED_FROM_ACTIVE_PAGE",
          pricingVerificationVerdict: "CONFIRMED_DELIVERY_CONTEXT",
          navigationStates: {
            ADDRESS_SELECTED: true,
            STORE_OPENED_FROM_ADDRESS_CONTEXT: true,
            CATALOG_VISIBLE_IN_SESSION: true,
            ADDRESS_SPECIFIC_PRICING_VERIFIED: true,
          },
          candidatesDiscoveredCount: 1,
          skippedMalformedCount: 0,
          duplicateSuppressedCount: 0,
          listings: [listing],
        },
        { ownerConfirmed: true },
      );

      expect(scanResult1.persisted).toBe(true);
      expect(scanResult1.observationsInserted).toBe(1);
      expect(scanResult1.newProductsDiscovered).toBe(1);

      const summary1 = repo1.getDashboardSummary();
      expect(summary1.counts.totalDistinctProducts).toBe(1);
      expect(summary1.counts.totalActiveObservations).toBe(1);

      // Record exact identities, counts, and prices before replacement
      const recordedIdentity = {
        externalProductId: "prod-cloud-survive-001",
        externalVariantId: "var-001",
        productName: "Durable Cloud Product",
        brand: "Test Brand",
        observedPriceCop: 25000,
        observationCount: 1,
      };

      // Simulate Container 1 termination: close SQLite connection and discard instance
      repo1.close();

      // --- Container 2 Lifecycle (Replacement Container Attaching Same Persistent Volume) ---
      const reconnectedStorage = checkStorageReadiness({ env: volumeEnv });
      expect(reconnectedStorage.persistenceVerified).toBe(true);
      expect(reconnectedStorage.isExistingMarker).toBe(true);
      expect(reconnectedStorage.restartProofVerified).toBe(true);
      // Volume marker was preserved with exact same volumeId
      expect(reconnectedStorage.volumeMarker?.volumeId).toBe(volumeMarkerId);

      // Container 2 opens SQLite on the volume
      const repo2 = new SqlitePrivateHistoryRepository(dbPath, { readOnly: true });
      const summary2 = repo2.getDashboardSummary();

      // Verify exact persisted counts survived container replacement
      expect(summary2.counts.totalDistinctProducts).toBe(
        recordedIdentity.observationCount,
      );
      expect(summary2.counts.totalActiveObservations).toBe(
        recordedIdentity.observationCount,
      );
      // F7-11C: Confirm the replacement process did NOT silently recreate an empty database!
      expect(summary2.counts.totalActiveObservations).toBeGreaterThan(0);

      const { items: products } = repo2.listCatalogProducts();
      expect(products).toHaveLength(1);
      expect(products[0]?.externalProductId).toBe(recordedIdentity.externalProductId);
      expect(products[0]?.externalVariantId).toBe(recordedIdentity.externalVariantId);
      expect(products[0]?.productName).toBe(recordedIdentity.productName);
      expect(products[0]?.brand).toBe(recordedIdentity.brand);
      expect(products[0]?.latestPriceCop).toBe(recordedIdentity.observedPriceCop);

      const productKey = products[0]?.productVariantKey ?? "";
      expect(productKey).not.toBe("");
      const productDetail = repo2.getProductDetail(productKey);
      expect(productDetail).toBeDefined();
      expect(productDetail?.observations).toHaveLength(1);
      expect(productDetail?.observations[0]?.observedPriceCop).toBe(
        recordedIdentity.observedPriceCop,
      );

      // F7-11C: Confirm storage readiness remains healthy
      expect(reconnectedStorage.ready).toBe(true);

      repo2.close();
    });
  });

  describe("F7-12: Realistic Railway Environment Compatibility & Fail-Closed Lifecycle", () => {
    it("verifies realistic Railway environment detection, volume mounting, startup config, healthy scheduler, and fail-closed protections", async () => {
      // 1. Realistic Railway environment object (F7-12 specification)
      const realisticRailwayEnv: NodeJS.ProcessEnv = {
        PRICERADAR_ENV: "cloud",
        RAILWAY_ENVIRONMENT_NAME: "production",
        RAILWAY_ENVIRONMENT_ID: "test-environment-id",
        RAILWAY_SERVICE_ID: "test-service-id",
        RAILWAY_VOLUME_NAME: "priceradar-data",
        RAILWAY_VOLUME_MOUNT_PATH: tempDir,
        PRICERADAR_SQLITE_PATH: path.join(tempDir, "private-history.sqlite"),
        PRICERADAR_ALLOWED_HOSTS: "priceradar-production.up.railway.app",
      };

      // Expected 1: Cloud mode detected
      expect(isRailwayEnvironment(realisticRailwayEnv)).toBe(true);
      expect(isCloudDeployment(realisticRailwayEnv)).toBe(true);
      Object.assign(process.env, realisticRailwayEnv);
      expect(isCloudMode()).toBe(true);

      // Expected 2: Valid mounted volume accepted
      const storageResult = checkStorageReadiness({ env: realisticRailwayEnv });
      expect(storageResult.ready).toBe(true);
      expect(storageResult.persistenceVerified).toBe(true);
      expect(storageResult.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
      expect(storageResult.evidenceType).toBe("RAILWAY_PLATFORM_MOUNT");
      expect(storageResult.volumeMarker?.volumeName).toBe("priceradar-data");
      expect(storageResult.volumeMarker?.hostEnvironment).toBe("railway:production");

      // Expected 3: Cloud startup configuration accepted
      const startupConfig = validateCloudStartupConfig({
        ...realisticRailwayEnv,
        PRICERADAR_WEB_PASSWORD: "SuperSecureCloudPassword2026!",
      });
      expect(startupConfig.persistenceTier).toBe("RAILWAY_PERSISTENT_VOLUME");
      expect(startupConfig.isLoopback).toBe(false);
      expect(startupConfig.webPassword).toBe("SuperSecureCloudPassword2026!");

      // Expected 4: Healthy scheduler produces HTTP 200
      const now = Date.now();
      fs.writeFileSync(
        statusFilePath,
        JSON.stringify({
          isRunning: true,
          totalScansExecuted: 5,
          lastHeartbeatAt: new Date(now - 5000).toISOString(),
          intervalMinutes: 60,
          consecutiveErrors: 0,
        }),
        "utf-8",
      );
      const systemResult = checkSystemReadiness({ env: realisticRailwayEnv, nowMs: now });
      expect(systemResult.ready).toBe(true);
      expect(systemResult.schedulerReady).toBe(true);
      const healthResponse = await healthRoute();
      expect(healthResponse.status).toBe(200);
      const healthJson = await healthResponse.json();
      expect(healthJson).toEqual({ status: "healthy", ready: true });

      // Expected 5: Missing or mismatched volume fails closed
      // 5a. Missing RAILWAY_VOLUME_MOUNT_PATH
      const missingMountEnv: NodeJS.ProcessEnv = {
        ...realisticRailwayEnv,
      };
      delete missingMountEnv.RAILWAY_VOLUME_MOUNT_PATH;
      const missingMountStorage = checkStorageReadiness({ env: missingMountEnv });
      expect(missingMountStorage.ready).toBe(false);
      expect(missingMountStorage.persistenceVerified).toBe(false);
      expect(missingMountStorage.reason).toContain("RAILWAY_VOLUME_MOUNT_PATH");
      expect(() => {
        validateCloudStartupConfig({
          ...missingMountEnv,
          PRICERADAR_WEB_PASSWORD: "SuperSecureCloudPassword2026!",
        });
      }).toThrow(/Storage configuration violation/);
      Object.assign(process.env, missingMountEnv);
      delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
      delete process.env.PRICERADAR_VOLUME_MOUNT_PATH;
      const missingMountHealth = await healthRoute();
      expect(missingMountHealth.status).toBe(503);

      // 5b. Mismatched RAILWAY_VOLUME_MOUNT_PATH
      const mismatchedMountEnv: NodeJS.ProcessEnv = {
        ...realisticRailwayEnv,
        RAILWAY_VOLUME_MOUNT_PATH: "/other-volume-mount",
      };
      const mismatchedStorage = checkStorageReadiness({ env: mismatchedMountEnv });
      expect(mismatchedStorage.ready).toBe(false);
      expect(mismatchedStorage.persistenceVerified).toBe(false);
      expect(mismatchedStorage.reason).toContain(
        "does not reside within Railway volume mount path",
      );
      expect(() => {
        validateCloudStartupConfig({
          ...mismatchedMountEnv,
          PRICERADAR_WEB_PASSWORD: "SuperSecureCloudPassword2026!",
        });
      }).toThrow(/Storage configuration violation/);
      Object.assign(process.env, mismatchedMountEnv);
      const mismatchedHealth = await healthRoute();
      expect(mismatchedHealth.status).toBe(503);

      // Expected 6: Missing dashboard password fails closed
      const missingPasswordEnv: NodeJS.ProcessEnv = {
        ...realisticRailwayEnv,
        PRICERADAR_WEB_PASSWORD: "",
      };
      delete missingPasswordEnv.PRICERADAR_WEB_PASSWORD;
      expect(() => {
        validateCloudStartupConfig(missingPasswordEnv);
      }).toThrow(/Security violation: PRICERADAR_WEB_PASSWORD must be configured/);

      // Middleware fails closed on remote request without credentials
      Object.assign(process.env, missingPasswordEnv);
      const unauthReq = new NextRequest(
        "https://priceradar-production.up.railway.app/products",
        { headers: { host: "priceradar-production.up.railway.app" } },
      );
      const unauthRes = middleware(unauthReq);
      expect(unauthRes.status).toBe(401);

      // Even if client attempts to forge loopback Host header in cloud mode, it fails closed (401/403)
      const forgedReq = new NextRequest("http://localhost:4178/products", {
        headers: { host: "localhost:4178" },
      });
      const forgedRes = middleware(forgedReq);
      expect([401, 403]).toContain(forgedRes.status);
    });
  });
});
