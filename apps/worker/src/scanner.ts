import type { WorkerRuntimeConfig } from "@priceradar/config";
import { DEFAULT_WORKER_RUNTIME_CONFIG } from "@priceradar/config";
import type { PriceRadarStorageRepository, ScanRunRecord } from "@priceradar/database";
import type {
  DiscoveryTarget,
  OpportunityCandidate,
  PriceIntelligenceConfig,
  PriceObservationRecord,
} from "@priceradar/domain";
import {
  buildCanonicalListingKey,
  buildObservationIdempotencyKey,
  createCopAmount,
  evaluateListingOpportunities,
} from "@priceradar/domain";
import type { CatalogProvider } from "@priceradar/providers";

export interface ExecuteDiscoveryScanInput {
  readonly scanRunId: string;
  readonly provider: CatalogProvider;
  readonly repository: PriceRadarStorageRepository;
  readonly targets?: readonly DiscoveryTarget[];
  readonly runtimeConfig?: Partial<WorkerRuntimeConfig>;
  readonly intelligenceConfig?: PriceIntelligenceConfig;
  readonly pageSize?: number;
  readonly simulationStep?: number;
  readonly nowIso?: string;
}

export interface ExecuteDiscoveryScanOutput {
  readonly scanRun: ScanRunRecord;
  readonly detectedOpportunities: readonly OpportunityCandidate[];
}

const WORKER_LOCK_KEY = "priceradar:discovery-worker:global-lock";

/**
 * Standalone, non-HTTP automatic discovery and price intelligence pipeline.
 *
 * Implements:
 * 1. Configuration loading & execution lock acquisition (prevents overlapping scans)
 * 2. Eligible target selection ordered by priority and staleness
 * 3. Bounded catalog exploration with pagination cursor checkpoints
 * 4. Record normalization & integer COP validation
 * 5. Idempotent observation persistence
 * 6. Deterministic price intelligence evaluation
 * 7. Scan run status reporting & guaranteed lock release
 */
export async function executeDiscoveryScan(
  input: ExecuteDiscoveryScanInput,
): Promise<ExecuteDiscoveryScanOutput> {
  const runtime: WorkerRuntimeConfig = {
    ...DEFAULT_WORKER_RUNTIME_CONFIG,
    ...input.runtimeConfig,
  };
  const nowIso = input.nowIso ?? new Date().toISOString();
  const pageSize = Math.max(1, input.pageSize ?? 25);

  const lockAcquired = await input.repository.acquireWorkerLock(
    WORKER_LOCK_KEY,
    runtime.executionTimeoutMs,
  );

  if (!lockAcquired) {
    const skippedRun: ScanRunRecord = {
      scanRunId: input.scanRunId,
      startedAt: nowIso,
      completedAt: nowIso,
      status: "SKIPPED_LOCKED",
      targetsAttempted: 0,
      targetsCompleted: 0,
      listingsDiscovered: 0,
      observationsPersisted: 0,
      opportunitiesCreated: 0,
      isPartialCoverage: true,
      errorSummary: "Another discovery scan is currently holding the execution lock.",
    };
    await input.repository.recordScanRun(skippedRun);
    return {
      scanRun: skippedRun,
      detectedOpportunities: [],
    };
  }

  let targetsAttempted = 0;
  let targetsCompleted = 0;
  let listingsDiscovered = 0;
  let observationsPersisted = 0;
  let opportunitiesCreated = 0;
  let isPartialCoverage = false;
  const errors: string[] = [];
  const allDetectedOpportunities: OpportunityCandidate[] = [];

  try {
    const rawTargets = input.targets ?? input.provider.getDefaultTargets();
    const eligibleTargets = [...rawTargets]
      .filter((t) => t.enabled && t.providerId === input.provider.id)
      .sort((a, b) => a.priority - b.priority);

    for (const target of eligibleTargets) {
      if (listingsDiscovered >= runtime.maxProductsPerScan) {
        isPartialCoverage = true;
        break;
      }

      targetsAttempted += 1;

      try {
        const checkpoint = await input.repository.getTargetCheckpoint(target.targetId);
        const cursor = checkpoint?.paginationCursor ?? target.paginationCursor;
        const remainingBudget = runtime.maxProductsPerScan - listingsDiscovered;
        const effectivePageSize = Math.min(pageSize, remainingBudget);

        const discoveryResult = await input.provider.discover(target, {
          ...(cursor !== undefined ? { cursor } : {}),
          pageSize: effectivePageSize,
          ...(input.simulationStep !== undefined
            ? { simulationStep: input.simulationStep }
            : {}),
          nowIso,
        });

        for (const listing of discoveryResult.listings) {
          listingsDiscovered += 1;

          // Validate integer COP invariant
          const validatedPrice = createCopAmount(listing.observedPriceCop);

          const listingKey = buildCanonicalListingKey({
            providerId: listing.providerId,
            externalStoreId: listing.store.externalStoreId,
            externalProductId: listing.variant.externalProductId,
            externalVariantId: listing.variant.externalVariantId,
            citySlug: listing.geographicContext.citySlug,
            ...(listing.geographicContext.zoneCode !== undefined
              ? { zoneCode: listing.geographicContext.zoneCode }
              : {}),
          });

          // Fetch prior history BEFORE persisting the new observation so baselines remain strictly historical
          const historicalObservations =
            await input.repository.getHistoricalObservations(listingKey);
          const existingOpportunities =
            await input.repository.getExistingOpportunities(listingKey);

          const idempotencyKey = buildObservationIdempotencyKey({
            listingKey,
            observedPriceCop: validatedPrice,
            bucketTimestampIso: listing.sourceObservedAt,
          });

          const observationRecord: PriceObservationRecord = {
            observationId: `obs::${input.scanRunId}::${listingKey}`,
            listingKey,
            providerId: listing.providerId,
            externalStoreId: listing.store.externalStoreId,
            externalProductId: listing.variant.externalProductId,
            externalVariantId: listing.variant.externalVariantId,
            citySlug: listing.geographicContext.citySlug,
            observedPriceCop: validatedPrice,
            ...(listing.declaredReferencePriceCop !== undefined
              ? {
                  declaredReferencePriceCop: createCopAmount(
                    listing.declaredReferencePriceCop,
                  ),
                }
              : {}),
            availability: listing.availability,
            provenance: listing.provenance,
            observedAt: listing.sourceObservedAt,
          };

          const { inserted } = await input.repository.saveObservationIdempotent(
            observationRecord,
            idempotencyKey,
          );

          if (inserted) {
            observationsPersisted += 1;
          }

          const candidates = evaluateListingOpportunities({
            listing,
            historicalObservations,
            existingOpportunities,
            ...(input.intelligenceConfig !== undefined
              ? { config: input.intelligenceConfig }
              : {}),
            evaluationTimeIso: nowIso,
          });

          if (candidates.length > 0) {
            const savedCount = await input.repository.saveOpportunities(candidates);
            opportunitiesCreated += savedCount;
            allDetectedOpportunities.push(...candidates);
          }
        }

        if (discoveryResult.hasMore) {
          isPartialCoverage = true;
        }

        await input.repository.updateTargetCheckpoint(
          target.targetId,
          discoveryResult.hasMore ? discoveryResult.nextCursor : undefined,
          nowIso,
        );

        targetsCompleted += 1;
      } catch (err) {
        isPartialCoverage = true;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Target ${target.targetId}: ${msg}`);
      }
    }

    const status =
      errors.length === 0
        ? isPartialCoverage
          ? "PARTIAL"
          : "SUCCEEDED"
        : targetsCompleted > 0
          ? "PARTIAL"
          : "FAILED";

    const completedRun: ScanRunRecord = {
      scanRunId: input.scanRunId,
      startedAt: nowIso,
      completedAt: new Date().toISOString(),
      status,
      targetsAttempted,
      targetsCompleted,
      listingsDiscovered,
      observationsPersisted,
      opportunitiesCreated,
      isPartialCoverage,
      ...(errors.length > 0 ? { errorSummary: errors.join("; ") } : {}),
    };

    await input.repository.recordScanRun(completedRun);

    return {
      scanRun: completedRun,
      detectedOpportunities: allDetectedOpportunities,
    };
  } finally {
    await input.repository.releaseWorkerLock(WORKER_LOCK_KEY);
  }
}
