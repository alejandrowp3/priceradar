import type {
  DiscoveryTarget,
  OpportunityCandidate,
  PriceObservationRecord,
} from "@priceradar/domain";

/**
 * Normalized entity table names and index boundaries planned for Neon PostgreSQL (Drizzle ORM in Phase 2).
 */
export const DATABASE_TABLES = {
  providers: "providers",
  stores: "stores",
  categories: "categories",
  products: "products",
  productVariants: "product_variants",
  listings: "listings",
  priceObservations: "price_observations",
  discoveryTargets: "discovery_targets",
  scanRuns: "scan_runs",
  opportunities: "opportunities",
  alertEvents: "alert_events",
  adminUsers: "admin_users",
} as const;

export type ScanRunStatus =
  "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED_LOCKED";

export interface ScanRunRecord {
  readonly scanRunId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: ScanRunStatus;
  readonly targetsAttempted: number;
  readonly targetsCompleted: number;
  readonly listingsDiscovered: number;
  readonly observationsPersisted: number;
  readonly opportunitiesCreated: number;
  readonly isPartialCoverage: boolean;
  readonly errorSummary?: string;
}

export interface PriceRadarStorageRepository {
  acquireWorkerLock(lockKey: string, ttlMs: number): Promise<boolean>;
  releaseWorkerLock(lockKey: string): Promise<void>;
  getHistoricalObservations(
    listingKey: string,
  ): Promise<readonly PriceObservationRecord[]>;
  saveObservationIdempotent(
    observation: PriceObservationRecord,
    idempotencyKey: string,
  ): Promise<{ inserted: boolean }>;
  getExistingOpportunities(listingKey: string): Promise<readonly OpportunityCandidate[]>;
  saveOpportunities(opportunities: readonly OpportunityCandidate[]): Promise<number>;
  updateTargetCheckpoint(
    targetId: string,
    cursor: string | undefined,
    lastScanAt: string,
  ): Promise<void>;
  recordScanRun(scanRun: ScanRunRecord): Promise<void>;
  getAllOpportunities(): Promise<readonly OpportunityCandidate[]>;
  getTargetCheckpoint(
    targetId: string,
  ): Promise<Pick<DiscoveryTarget, "paginationCursor" | "lastScanAt"> | undefined>;
}

/**
 * Deterministic in-memory repository used in Phase 0/1 and integration tests
 * before remote Neon PostgreSQL provisioning is authorized in Phase 2.
 */
export class InMemoryPriceRadarRepository implements PriceRadarStorageRepository {
  private readonly activeLocks = new Map<string, number>();
  private readonly observationsByListing = new Map<string, PriceObservationRecord[]>();
  private readonly seenIdempotencyKeys = new Set<string>();
  private readonly opportunitiesByListing = new Map<string, OpportunityCandidate[]>();
  private readonly targetCheckpoints = new Map<
    string,
    { paginationCursor?: string; lastScanAt?: string }
  >();
  private readonly scanRuns: ScanRunRecord[] = [];

  public constructor(seedObservations: readonly PriceObservationRecord[] = []) {
    for (const obs of seedObservations) {
      const list = this.observationsByListing.get(obs.listingKey) ?? [];
      list.push(obs);
      this.observationsByListing.set(obs.listingKey, list);
    }
  }

  public async acquireWorkerLock(lockKey: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.activeLocks.get(lockKey);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    this.activeLocks.set(lockKey, now + ttlMs);
    return true;
  }

  public async releaseWorkerLock(lockKey: string): Promise<void> {
    this.activeLocks.delete(lockKey);
  }

  public async getHistoricalObservations(
    listingKey: string,
  ): Promise<readonly PriceObservationRecord[]> {
    return [...(this.observationsByListing.get(listingKey) ?? [])];
  }

  public async saveObservationIdempotent(
    observation: PriceObservationRecord,
    idempotencyKey: string,
  ): Promise<{ inserted: boolean }> {
    if (this.seenIdempotencyKeys.has(idempotencyKey)) {
      return { inserted: false };
    }
    this.seenIdempotencyKeys.add(idempotencyKey);
    const list = this.observationsByListing.get(observation.listingKey) ?? [];
    list.push(observation);
    this.observationsByListing.set(observation.listingKey, list);
    return { inserted: true };
  }

  public async getExistingOpportunities(
    listingKey: string,
  ): Promise<readonly OpportunityCandidate[]> {
    return [...(this.opportunitiesByListing.get(listingKey) ?? [])];
  }

  public async saveOpportunities(
    opportunities: readonly OpportunityCandidate[],
  ): Promise<number> {
    let saved = 0;
    for (const opp of opportunities) {
      const list = this.opportunitiesByListing.get(opp.listingKey) ?? [];
      const alreadyExists = list.some(
        (item) => item.opportunityKey === opp.opportunityKey,
      );
      if (!alreadyExists) {
        list.push(opp);
        this.opportunitiesByListing.set(opp.listingKey, list);
        saved += 1;
      }
    }
    return saved;
  }

  public async updateTargetCheckpoint(
    targetId: string,
    cursor: string | undefined,
    lastScanAt: string,
  ): Promise<void> {
    this.targetCheckpoints.set(targetId, {
      ...(cursor !== undefined ? { paginationCursor: cursor } : {}),
      lastScanAt,
    });
  }

  public async getTargetCheckpoint(
    targetId: string,
  ): Promise<Pick<DiscoveryTarget, "paginationCursor" | "lastScanAt"> | undefined> {
    return this.targetCheckpoints.get(targetId);
  }

  public async recordScanRun(scanRun: ScanRunRecord): Promise<void> {
    this.scanRuns.push(scanRun);
  }

  public async getAllOpportunities(): Promise<readonly OpportunityCandidate[]> {
    const all: OpportunityCandidate[] = [];
    for (const list of this.opportunitiesByListing.values()) {
      all.push(...list);
    }
    return all;
  }

  public getScanRuns(): readonly ScanRunRecord[] {
    return [...this.scanRuns];
  }
}

export * from "./sqlite-repository.ts";
