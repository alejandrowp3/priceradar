import type {
  DiscoveredListing,
  DiscoveryTarget,
  PriceObservationRecord,
} from "@priceradar/domain";

export interface ProviderCapabilities {
  readonly supportsCatalogExploration: boolean;
  readonly supportsCategoryDiscovery: boolean;
  readonly supportsPagination: boolean;
  readonly supportsStoreSpecificListings: boolean;
  readonly supportsStableProductIdentity: boolean;
  readonly supportsProductVariants: boolean;
  readonly supportsDeclaredReferencePrice: boolean;
  readonly supportsAvailabilityStatus: boolean;
  readonly supportsGeographicContext: boolean;
  readonly supportsProductImages: boolean;
  readonly supportsSourceTimestamps: boolean;
  readonly isSimulatedFixture: boolean;
}

export interface DiscoveryOptions {
  readonly cursor?: string;
  readonly pageSize?: number;
  /**
   * Deterministic simulation cycle index (0, 1, 2...) or timestamp override
   * used by fixture providers to reproduce price drops and anomalies.
   */
  readonly simulationStep?: number;
  readonly nowIso?: string;
}

export interface DiscoveryResult {
  readonly providerId: string;
  readonly targetId: string;
  readonly listings: readonly DiscoveredListing[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly fetchedAt: string;
  readonly totalAvailableInTarget?: number;
}

export interface CatalogProvider {
  readonly id: string;
  readonly displayName: string;

  getCapabilities(): ProviderCapabilities;

  getDefaultTargets(): readonly DiscoveryTarget[];

  /**
   * Optional seed history helper for deterministic demo/fixture providers.
   */
  getSeedHistoricalObservations?(nowIso?: string): readonly PriceObservationRecord[];

  discover(target: DiscoveryTarget, options?: DiscoveryOptions): Promise<DiscoveryResult>;
}
