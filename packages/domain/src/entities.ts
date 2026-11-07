import type { CopAmount } from "./money.ts";

export type DataProvenance =
  | "DEMO_FIXTURE"
  | "PUBLIC_STOREFRONT_UNAUTHENTICATED"
  | "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL"
  | "LIVE_PRIVATE"
  | "LIVE_PROVIDER";

export type AvailabilityStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";

export type OpportunityType =
  "DECLARED_DISCOUNT" | "HISTORICAL_DROP" | "HISTORICAL_LOW" | "POTENTIAL_ANOMALY";

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface GeographicContext {
  readonly countryCode: "CO";
  readonly citySlug: string;
  readonly cityName: string;
  readonly zoneCode?: string;
}

export interface StoreIdentity {
  readonly providerId: string;
  readonly externalStoreId: string;
  readonly name: string;
  readonly categorySlug: string;
}

export interface ProductVariantIdentity {
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly name: string;
  readonly brand: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly packagingLabel: string;
  readonly unitQuantity: number;
  readonly unitType: "g" | "ml" | "unit" | "kg" | "l";
  readonly imageUrl?: string;
  readonly productUrl: string;
}

export interface DiscoveredListing {
  readonly providerId: string;
  readonly store: StoreIdentity;
  readonly variant: ProductVariantIdentity;
  readonly geographicContext: GeographicContext;
  readonly observedPriceCop: CopAmount;
  readonly declaredReferencePriceCop?: CopAmount;
  readonly availability: AvailabilityStatus;
  readonly provenance: DataProvenance;
  readonly sourceObservedAt: string;
}

export interface PriceObservationRecord {
  readonly observationId: string;
  readonly listingKey: string;
  readonly providerId: string;
  readonly externalStoreId: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly citySlug: string;
  readonly observedPriceCop: CopAmount;
  readonly declaredReferencePriceCop?: CopAmount;
  readonly availability: AvailabilityStatus;
  readonly provenance: DataProvenance;
  readonly observedAt: string;
}

export interface OpportunityCandidate {
  readonly opportunityKey: string;
  readonly listingKey: string;
  readonly type: OpportunityType;
  readonly labelEsCo: string;
  readonly observedPriceCop: CopAmount;
  readonly baselinePriceCop: CopAmount;
  readonly savingsCop: CopAmount;
  readonly discountBasisPoints: number;
  readonly discountPercentage: number;
  readonly historicalObservationCount: number;
  readonly historicalLowCop: CopAmount;
  readonly historicalMedianCop: CopAmount;
  readonly confidence: ConfidenceLevel;
  readonly requiresVerification: boolean;
  readonly rationaleEsCo: string;
  readonly provenance: DataProvenance;
  readonly detectedAt: string;
}

export interface DiscoveryTarget {
  readonly targetId: string;
  readonly providerId: string;
  readonly storeId: string;
  readonly categorySlug: string;
  readonly geographicContext: GeographicContext;
  readonly enabled: boolean;
  readonly priority: number;
  readonly paginationCursor?: string;
  readonly lastScanAt?: string;
}

/**
 * Generates a deterministic canonical key for a store + variant + city listing.
 * Prevents merging variants or listings across different stores or cities.
 */
export function buildCanonicalListingKey(params: {
  readonly providerId: string;
  readonly externalStoreId: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly citySlug: string;
  readonly zoneCode?: string;
}): string {
  const parts = [
    params.providerId.trim().toLowerCase(),
    params.externalStoreId.trim().toLowerCase(),
    params.externalProductId.trim().toLowerCase(),
    params.externalVariantId.trim().toLowerCase(),
    params.citySlug.trim().toLowerCase(),
  ];
  if (params.zoneCode && params.zoneCode.trim().length > 0) {
    parts.push(params.zoneCode.trim().toLowerCase());
  }
  return parts.join("::");
}

/**
 * Generates an idempotent observation fingerprint to suppress redundant identical
 * observations within the same scan window.
 */
export function buildObservationIdempotencyKey(params: {
  readonly listingKey: string;
  readonly observedPriceCop: CopAmount;
  readonly bucketTimestampIso: string;
}): string {
  return `${params.listingKey}::${String(params.observedPriceCop)}::${params.bucketTimestampIso}`;
}
