import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DiscoveredListing } from "@priceradar/domain";
import { createCopAmount } from "@priceradar/domain";
import { SqlitePrivateHistoryRepository } from "@priceradar/database";
import { fetchSchedulerStatus } from "../../../apps/web/src/lib/db";
import { CloudScheduler } from "../src/cloud-scheduler";

describe("Cloud Scheduler (P5 Cloud-First Milestone 1)", () => {
  let tempDir: string;
  let dbPath: string;
  let statusFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-sched-test-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
    statusFilePath = path.join(tempDir, "scheduler-status.json");
    process.env.PRICERADAR_SQLITE_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.PRICERADAR_SQLITE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes with standby status before start()", () => {
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 30,
      scanOnStartup: false,
    });

    const status = scheduler.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.totalScansExecuted).toBe(0);
    expect(status.intervalMinutes).toBe(30);
    expect(status.activeProvider).toBe("fixture-colombia");
  });

  it("executes scheduled collection scan and persists observations and scan_runs to SQLite", async () => {
    const logs: string[] = [];
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 15,
      scanOnStartup: false,
      logger: (msg) => logs.push(msg),
    });

    const result = await scheduler.executeScheduledScan();
    expect(result).not.toBeNull();
    expect(result?.persisted).toBe(true);
    expect(result?.observationsInserted).toBeGreaterThan(0);

    const status = scheduler.getStatus();
    expect(status.totalScansExecuted).toBe(1);
    expect(status.lastScanStatus).toBe("SUCCEEDED");
    expect(status.lastScanCompletedAt).toBeDefined();

    // Verify status file written to disk
    expect(fs.existsSync(statusFilePath)).toBe(true);
    const fileContent = JSON.parse(fs.readFileSync(statusFilePath, "utf-8"));
    expect(fileContent.totalScansExecuted).toBe(1);
    expect(fileContent.lastScanStatus).toBe("SUCCEEDED");
    expect(fileContent.lastHeartbeatAt).toBeDefined();

    // Verify SQLite contains the scan run
    const repo = new SqlitePrivateHistoryRepository(dbPath, { readOnly: true });
    const runs = repo.listRecentScanRuns(5);
    repo.close();

    expect(runs.length).toBe(1);
    expect(runs[0]?.scanRunId).toContain("cloud-sched-");
    expect(runs[0]?.status).toBe("SUCCEEDED");
    expect(runs[0]?.validObservations).toBeGreaterThan(0);
  });

  it("F7-03: explicitly labels synthetic fixture data as DEMO_FIXTURE and UNVERIFIED_DEMO_FIXTURE", async () => {
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 60,
      scanOnStartup: false,
    });

    const result = await scheduler.executeScheduledScan();
    expect(result?.persisted).toBe(true);

    const repo = new SqlitePrivateHistoryRepository(dbPath, { readOnly: true });
    const opps = repo.listActiveOpportunities();
    const products = repo.listCatalogProducts();
    repo.close();

    expect(opps.items.length).toBeGreaterThan(0);
    expect(opps.items[0]?.isSyntheticDemo).toBe(true);

    expect(products.items.length).toBeGreaterThan(0);
    expect(products.items[0]?.isSyntheticDemo).toBe(true);
  });

  it("F7-03: rejects persistence if DEMO_FIXTURE is claimed as verified address pricing", () => {
    const repo = new SqlitePrivateHistoryRepository(dbPath);

    // Direct SQLite insertion test for CHECK constraint enforcement
    expect(() => {
      (
        repo as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
        }
      ).db
        .prepare(
          `INSERT INTO price_observations (
            observation_id, idempotency_key, listing_key, scan_run_id,
            product_variant_key, store_key, fulfillment_context_id, city_slug,
            observed_price_cop, declared_reference_price_cop, availability,
            observed_at, provenance, geographic_verification_verdict,
            serving_branch_evidence, catalog_context_evidence,
            address_specific_pricing_verified, is_superseded
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bogota', 25000, NULL, 'IN_STOCK', ?, 'DEMO_FIXTURE', 'VERIFIED_ADDRESS_SPECIFIC_PRICING', 'evidence', 'evidence', 1, 0)`,
        )
        .run(
          "obs-fail-1",
          "idemp-fail-1",
          "list-1",
          "scan-1",
          "pv-1",
          "store-1",
          "ctx-88be5762563932c5",
          new Date().toISOString(),
        );
    }).toThrow();

    repo.close();
  });

  it("F7-05: detects stale heartbeat and marks scheduler as inactive and stale", () => {
    // Write a stale status file (heartbeat 120 seconds ago, threshold is 90s)
    const staleHeartbeat = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(
      statusFilePath,
      JSON.stringify(
        {
          isRunning: true,
          totalScansExecuted: 5,
          lastHeartbeatAt: staleHeartbeat,
          intervalMinutes: 60,
          activeProvider: "fixture-colombia",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const status = fetchSchedulerStatus(90_000);
    expect(status).not.toBeNull();
    expect(status?.isStale).toBe(true);
    expect(status?.isRunning).toBe(false);
  });

  it("F7-05: recovers status from durable SQLite history when status file is missing or corrupted", async () => {
    // 1. Run a scan to establish durable SQLite history
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 60,
      scanOnStartup: false,
    });
    await scheduler.executeScheduledScan();

    // 2. Corrupt or delete status file
    fs.writeFileSync(statusFilePath, "{ corrupted json syntax !!", "utf-8");

    // 3. fetchSchedulerStatus should recover from durable SQLite
    const status = fetchSchedulerStatus(90_000);
    expect(status).not.toBeNull();
    expect(status?.isStale).toBe(true);
    expect(status?.lastScanStartedAt).toBeDefined();
    expect(status?.lastScanStatus).toBe("SUCCEEDED");
  });

  it("F7-06: distributed worker lock prevents concurrent execution across duplicate replicas", async () => {
    const repo = new SqlitePrivateHistoryRepository(dbPath);
    const nowIso = new Date().toISOString();

    // Simulate Worker 1 holding the lock
    const lockAcquired = repo.acquireWorkerLock(
      "cloud-scheduler:leader-scan-lock",
      "worker-1-holder",
      10 * 60 * 1000,
      nowIso,
    );
    expect(lockAcquired).toBe(true);

    // Worker 2 attempts scheduled scan while lock is held
    const logs: string[] = [];
    const scheduler2 = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 60,
      scanOnStartup: false,
      logger: (msg) => logs.push(msg),
    });

    const result = await scheduler2.executeScheduledScan();
    expect(result).toBeNull();
    expect(scheduler2.getStatus().lastScanStatus).toBe("SKIPPED_LOCKED");
    expect(
      logs.some((l) => l.includes("Skipping this scan cycle (SKIPPED_LOCKED)")),
    ).toBe(true);

    // Release lock from Worker 1
    repo.releaseWorkerLock("cloud-scheduler:leader-scan-lock", "worker-1-holder");
    repo.close();

    // Now Worker 2 should be able to acquire lock and execute
    const result2 = await scheduler2.executeScheduledScan();
    expect(result2).not.toBeNull();
    expect(result2?.persisted).toBe(true);
  });

  it("F7-09: renewWorkerLock extends active lease and rejects unauthorized or expired renewals", () => {
    const repo = new SqlitePrivateHistoryRepository(dbPath);
    const t0 = new Date("2026-11-11T12:00:00.000Z");
    const t0Iso = t0.toISOString();

    // 1. Acquire initial lock for 60 seconds
    const acquired = repo.acquireWorkerLock(
      "cloud-scheduler:test-lock",
      "holder-alpha",
      60_000,
      t0Iso,
    );
    expect(acquired).toBe(true);
    expect(
      repo.isWorkerLockHeldBy("cloud-scheduler:test-lock", "holder-alpha", t0Iso),
    ).toBe(true);
    expect(
      repo.isWorkerLockHeldBy("cloud-scheduler:test-lock", "holder-beta", t0Iso),
    ).toBe(false);

    // 2. Renew after 30 seconds (still within 60s TTL)
    const t30Iso = new Date(t0.getTime() + 30_000).toISOString();
    const renewed = repo.renewWorkerLock(
      "cloud-scheduler:test-lock",
      "holder-alpha",
      60_000,
      t30Iso,
    );
    expect(renewed).toBe(true);

    // Lock is now extended to t0 + 30s + 60s = t0 + 90s
    const t80Iso = new Date(t0.getTime() + 80_000).toISOString();
    expect(
      repo.isWorkerLockHeldBy("cloud-scheduler:test-lock", "holder-alpha", t80Iso),
    ).toBe(true);

    // 3. Unauthorized renewal attempt by different holder fails
    const unauthorizedRenew = repo.renewWorkerLock(
      "cloud-scheduler:test-lock",
      "holder-beta",
      60_000,
      t80Iso,
    );
    expect(unauthorizedRenew).toBe(false);

    // 4. Renewal attempt after expiry (at t0 + 100s) fails
    const t100Iso = new Date(t0.getTime() + 100_000).toISOString();
    expect(
      repo.isWorkerLockHeldBy("cloud-scheduler:test-lock", "holder-alpha", t100Iso),
    ).toBe(false);

    const expiredRenew = repo.renewWorkerLock(
      "cloud-scheduler:test-lock",
      "holder-alpha",
      60_000,
      t100Iso,
    );
    expect(expiredRenew).toBe(false);

    repo.close();
  });

  it("F7-09: crash recovery allows new worker to acquire lock after lease TTL expires", () => {
    const repo = new SqlitePrivateHistoryRepository(dbPath);
    const t0 = new Date("2026-11-11T12:00:00.000Z");

    // Worker 1 acquires lock for 30s and crashes without releasing
    repo.acquireWorkerLock(
      "cloud-scheduler:test-lock",
      "crashed-worker",
      30_000,
      t0.toISOString(),
    );

    // At t + 10s, Worker 2 cannot acquire
    const t10Iso = new Date(t0.getTime() + 10_000).toISOString();
    expect(
      repo.acquireWorkerLock(
        "cloud-scheduler:test-lock",
        "survivor-worker",
        30_000,
        t10Iso,
      ),
    ).toBe(false);

    // At t + 35s (after TTL expires), Worker 2 successfully recovers and acquires lock
    const t35Iso = new Date(t0.getTime() + 35_000).toISOString();
    expect(
      repo.acquireWorkerLock(
        "cloud-scheduler:test-lock",
        "survivor-worker",
        30_000,
        t35Iso,
      ),
    ).toBe(true);

    expect(
      repo.isWorkerLockHeldBy("cloud-scheduler:test-lock", "survivor-worker", t35Iso),
    ).toBe(true);
    expect(
      repo.isWorkerLockHeldBy("cloud-scheduler:test-lock", "crashed-worker", t35Iso),
    ).toBe(false);

    repo.close();
  });

  it("F7-09: persistApprovedInspectionBatch aborts and rolls back if requiredWorkerLock is lost", () => {
    const repo = new SqlitePrivateHistoryRepository(dbPath);
    const lockKey = "cloud-scheduler:persist-lock";
    const holderId = "valid-holder";

    // Acquire lock with short TTL (100ms)
    repo.acquireWorkerLock(lockKey, holderId, 100);

    // Force expiration by releasing or expiring
    repo.releaseWorkerLock(lockKey, holderId);

    const testListing: DiscoveredListing = {
      providerId: "rappi-authenticated-inspector",
      store: {
        providerId: "rappi-authenticated-inspector",
        externalStoreId: "900130995-turbo-super",
        name: "Turbo Super",
        categorySlug: "supermercados",
      },
      variant: {
        externalProductId: "prod-test-99",
        externalVariantId: "prod-test-99-std",
        name: "Test Product",
        brand: "Test Brand",
        categorySlug: "supermercados",
        categoryName: "Supermercados",
        packagingLabel: "1 unidad",
        unitQuantity: 1,
        unitType: "unit" as const,
        productUrl: "https://www.rappi.com.co/p/prod-test-99",
      },
      geographicContext: {
        countryCode: "CO",
        citySlug: "bogota",
        cityName: "Bogotá D.C.",
      },
      observedPriceCop: createCopAmount(25000),
      availability: "IN_STOCK" as const,
      provenance: "DEMO_FIXTURE" as const,
      sourceObservedAt: new Date().toISOString(),
    };

    const context = {
      scanRunId: "test-scan-lock-fail",
      observedAtIso: new Date().toISOString(),
      gateStatus: "VERIFIED_ACTIVE_SELECTION" as const,
      hasSecurityChallenge: false,
      isLoginRequired: false,
      isDeliveryContextVerified: false,
      citySlug: "bogota",
      cityName: "Bogotá D.C. (Demo)",
      fulfillmentContextHash: "ctx-88be5762563932c5",
      activeAddressSelection: "UNVERIFIED_SESSION_DEFAULT",
      cityAndNeighborhoodMetadata: "SYNTHETIC_DEMO_CONTEXT",
      servingStoreBranch: "DEMO_FIXTURE_STORE",
      productCatalogContext: "SYNTHETIC_DEMO_CATALOG",
      pricingVerificationVerdict: "UNVERIFIED_DEMO_FIXTURE" as const,
      navigationStates: {
        ADDRESS_SELECTED: false,
        STORE_OPENED_FROM_ADDRESS_CONTEXT: false,
        CATALOG_VISIBLE_IN_SESSION: true,
        ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
      },
      candidatesDiscoveredCount: 1,
      skippedMalformedCount: 0,
      duplicateSuppressedCount: 0,
      listings: [testListing],
      isDemoFixture: true,
    };

    // Attempt persistence with requiredWorkerLock that is not held
    const result = repo.persistApprovedInspectionBatch(context, {
      ownerConfirmed: true,
      requiredWorkerLock: { lockKey, holderId },
    });

    expect(result.persisted).toBe(false);
    expect(result.reason).toBe("TRANSACTION_FAILED");
    expect(result.errorSummary).toContain("Worker lock");

    // Verify nothing was written to database
    const runs = repo.listRecentScanRuns(5);
    expect(runs.some((r) => r.scanRunId === "test-scan-lock-fail")).toBe(false);

    repo.close();
  });

  it("starts and stops cleanly without leaving dangling timers", async () => {
    const scheduler = new CloudScheduler({
      dbPath,
      statusFilePath,
      intervalMinutes: 60,
      scanOnStartup: true,
    });

    await scheduler.start();
    expect(scheduler.getStatus().isRunning).toBe(true);
    expect(scheduler.getStatus().totalScansExecuted).toBe(1);

    scheduler.stop();
    expect(scheduler.getStatus().isRunning).toBe(false);
    expect(scheduler.getStatus().nextScheduledScanAt).toBeUndefined();

    const fileContent = JSON.parse(fs.readFileSync(statusFilePath, "utf-8"));
    expect(fileContent.isRunning).toBe(false);
  });
});
