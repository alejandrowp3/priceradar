import { describe, expect, it } from "vitest";
import { InMemoryPriceRadarRepository } from "@priceradar/database";
import { FixtureCatalogProvider } from "@priceradar/providers";
import { executeDiscoveryScan } from "../src/index.ts";

describe("Automatic discovery worker vertical slice (SC-005, SC-007, SC-008)", () => {
  it("runs a complete discovery-to-analysis vertical slice and classifies all 4 opportunity types accurately", async () => {
    const nowIso = "2026-11-07T12:00:00.000Z";
    const provider = new FixtureCatalogProvider();
    const seedHistory = provider.getSeedHistoricalObservations(nowIso);
    const repository = new InMemoryPriceRadarRepository(seedHistory);

    const output = await executeDiscoveryScan({
      scanRunId: "scan-slice-001",
      provider,
      repository,
      nowIso,
      simulationStep: 0,
    });

    expect(output.scanRun.status).toBe("SUCCEEDED");
    expect(output.scanRun.targetsAttempted).toBe(3);
    expect(output.scanRun.targetsCompleted).toBe(3);
    expect(output.scanRun.listingsDiscovered).toBe(6);
    expect(output.scanRun.observationsPersisted).toBe(6);
    expect(output.scanRun.opportunitiesCreated).toBe(8);
    expect(output.scanRun.isPartialCoverage).toBe(false);

    const types = new Set(output.detectedOpportunities.map((o) => o.type));
    expect(types.has("DECLARED_DISCOUNT")).toBe(true);
    expect(types.has("HISTORICAL_DROP")).toBe(true);
    expect(types.has("HISTORICAL_LOW")).toBe(true);
    expect(types.has("POTENTIAL_ANOMALY")).toBe(true);

    // Verify SC-007: Monitor with only 1 prior observation and 60% drop MUST NOT be classified as POTENTIAL_ANOMALY
    const monitorAnomalies = output.detectedOpportunities.filter(
      (o) =>
        o.listingKey.includes("prod-monitor-qhd-27") && o.type === "POTENTIAL_ANOMALY",
    );
    expect(monitorAnomalies).toHaveLength(0);

    // Verify Audifonos ANC with 6 prior observations and 62% drop IS classified as POTENTIAL_ANOMALY
    // and does NOT redundantly emit HISTORICAL_LOW or HISTORICAL_DROP
    const headphoneOpportunities = output.detectedOpportunities.filter((o) =>
      o.listingKey.includes("prod-audifonos-anc-pro"),
    );
    expect(headphoneOpportunities.map((o) => o.type)).toEqual([
      "POTENTIAL_ANOMALY",
      "DECLARED_DISCOUNT",
    ]);
    expect(headphoneOpportunities[0]?.requiresVerification).toBe(true);
  });

  it("enforces idempotent observation persistence and opportunity deduplication on repeated runs", async () => {
    const nowIso = "2026-11-07T12:00:00.000Z";
    const provider = new FixtureCatalogProvider();
    const repository = new InMemoryPriceRadarRepository(
      provider.getSeedHistoricalObservations(nowIso),
    );

    const first = await executeDiscoveryScan({
      scanRunId: "scan-idem-1",
      provider,
      repository,
      nowIso,
    });
    expect(first.scanRun.observationsPersisted).toBe(6);
    expect(first.scanRun.opportunitiesCreated).toBeGreaterThan(0);

    // Immediate re-run at the same timestamp bucket must not insert duplicate observations or duplicate opportunities
    const second = await executeDiscoveryScan({
      scanRunId: "scan-idem-2",
      provider,
      repository,
      nowIso,
    });
    expect(second.scanRun.observationsPersisted).toBe(0);
    expect(second.scanRun.opportunitiesCreated).toBe(0);
  });

  it("marks scan status as PARTIAL and persists pagination cursors when bounded by maxProductsPerScan", async () => {
    const nowIso = "2026-11-07T12:00:00.000Z";
    const provider = new FixtureCatalogProvider();
    const repository = new InMemoryPriceRadarRepository(
      provider.getSeedHistoricalObservations(nowIso),
    );

    const partial = await executeDiscoveryScan({
      scanRunId: "scan-partial-1",
      provider,
      repository,
      nowIso,
      pageSize: 2,
      runtimeConfig: {
        maxProductsPerScan: 2,
      },
    });

    expect(partial.scanRun.status).toBe("PARTIAL");
    expect(partial.scanRun.isPartialCoverage).toBe(true);
    expect(partial.scanRun.listingsDiscovered).toBe(2);

    const checkpoint = await repository.getTargetCheckpoint(
      "target-andino-supermercado-bog",
    );
    expect(checkpoint?.paginationCursor).toBe("2");
  });

  it("prevents overlapping scans when the worker lock is already held", async () => {
    const provider = new FixtureCatalogProvider();
    const repository = new InMemoryPriceRadarRepository();

    await repository.acquireWorkerLock("priceradar:discovery-worker:global-lock", 60_000);

    const lockedResult = await executeDiscoveryScan({
      scanRunId: "scan-locked",
      provider,
      repository,
    });

    expect(lockedResult.scanRun.status).toBe("SKIPPED_LOCKED");
    expect(lockedResult.scanRun.listingsDiscovered).toBe(0);
  });
});
