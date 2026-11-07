import { InMemoryPriceRadarRepository } from "@priceradar/database";
import { formatCop } from "@priceradar/domain";
import { FixtureCatalogProvider } from "@priceradar/providers";
import { executeDiscoveryScan } from "./scanner.ts";

/**
 * Standalone CLI entry point for the PriceRadar automatic discovery worker.
 * Never opens a persistent HTTP server. Exits cleanly after bounded execution.
 */
async function main(): Promise<void> {
  const nowIso = "2026-11-07T12:00:00.000Z";
  const provider = new FixtureCatalogProvider();
  const seedHistory = provider.getSeedHistoricalObservations(nowIso);
  const repository = new InMemoryPriceRadarRepository(seedHistory);

  const result = await executeDiscoveryScan({
    scanRunId: `cli-scan-${String(Date.now())}`,
    provider,
    repository,
    nowIso,
    simulationStep: 0,
  });

  const structuredSummary = {
    service: "priceradar-worker",
    mode: "DEMO_FIXTURE",
    scanRun: result.scanRun,
    opportunities: result.detectedOpportunities.map((opp) => ({
      key: opp.opportunityKey,
      type: opp.type,
      labelEsCo: opp.labelEsCo,
      observedPrice: formatCop(opp.observedPriceCop),
      baselinePrice: formatCop(opp.baselinePriceCop),
      discountPercentage: `${String(opp.discountPercentage)}%`,
      confidence: opp.confidence,
      requiresVerification: opp.requiresVerification,
    })),
  };

  console.log(JSON.stringify(structuredSummary, null, 2));

  if (result.scanRun.status === "FAILED") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      service: "priceradar-worker",
      level: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
