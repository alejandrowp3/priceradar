import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AvailabilityStatus,
  ConfidenceLevel,
  CopAmount,
  DataProvenance,
  DiscoveredListing,
  HistoricalPriceComparisonSummary,
  OpportunityCandidate,
  OpportunityType,
  PriceIntelligenceConfig,
  PriceObservationRecord,
} from "@priceradar/domain";
import {
  buildCanonicalListingKey,
  buildObservationIdempotencyKey,
  compareObservationAgainstHistory,
  createCopAmount,
  evaluateListingOpportunities,
  PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
} from "@priceradar/domain";

export const DEFAULT_PRIVATE_SQLITE_DB_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "priceradar",
  "private-history.sqlite",
);

const OPAQUE_CONTEXT_ID_REGEX = /^ctx-[0-9a-f]{16}$/;

const FORBIDDEN_PII_OR_CREDENTIAL_PATTERNS = [
  /\b(?:calle|carrera|diagonal|transversal|avenida|autopista|circular)\s+\d+/i,
  /\b(?:apto|apartamento|interior|torre|bloque|manzana|casa)\s*#?\s*\d+/i,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
  /\b(?:\+?57[\s-]?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/,
  /\bbearer\s+[a-z0-9._~+/-]+=*/i,
  /\b(?:session_id|access_token|refresh_token|cf_clearance|__cf_bm)\s*=/i,
];

export type GeographicVerificationVerdictType =
  | "VERIFIED_ADDRESS_SPECIFIC_PRICING"
  | "UNVERIFIED_STATIC_SEO_PRICING"
  | "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION"
  | "UNVERIFIED_MISSING_HMAC_SECRET"
  | "UNVERIFIED_NO_ACTIVE_ADDRESS";

export type OpportunityLifecycleStatus =
  "ACTIVE" | "SUPERSEDED" | "EXPIRED" | "DISMISSED";

export type OpportunityEventOrigin = "ORIGINAL_SCAN" | "HISTORICAL_REEVALUATION";

export interface SupervisedPersistenceContextInput {
  readonly scanRunId: string;
  readonly observedAtIso: string;
  readonly gateStatus: string;
  readonly hasSecurityChallenge?: boolean;
  readonly isLoginRequired?: boolean;
  readonly isDeliveryContextVerified: boolean;
  readonly citySlug: string;
  readonly cityName: string;
  readonly fulfillmentContextHash?: string;
  readonly activeAddressSelection: string;
  readonly cityAndNeighborhoodMetadata: string;
  readonly servingStoreBranch: string;
  readonly productCatalogContext: string;
  readonly pricingVerificationVerdict: GeographicVerificationVerdictType;
  readonly navigationStates: {
    readonly ADDRESS_SELECTED: boolean;
    readonly STORE_OPENED_FROM_ADDRESS_CONTEXT: boolean;
    readonly CATALOG_VISIBLE_IN_SESSION: boolean;
    readonly ADDRESS_SPECIFIC_PRICING_VERIFIED: boolean;
  };
  readonly candidatesDiscoveredCount: number;
  readonly skippedMalformedCount: number;
  readonly duplicateSuppressedCount: number;
  readonly listings: readonly DiscoveredListing[];
}

export interface BatchPreviewItem {
  readonly listing: DiscoveredListing;
  readonly listingKey: string;
  readonly comparison: HistoricalPriceComparisonSummary;
  readonly candidateOpportunities: readonly OpportunityCandidate[];
}

export interface BatchPreviewSummary {
  readonly isEligible: boolean;
  readonly rejectionReason?: string;
  readonly storeId?: string;
  readonly storeName?: string;
  readonly fulfillmentContextId?: string;
  readonly provenance?: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
  readonly geographicVerificationVerdict: GeographicVerificationVerdictType;
  readonly addressSpecificPricingVerified: boolean;
  readonly candidatesDiscoveredCount: number;
  readonly eligibleListingsCount: number;
  readonly skippedMalformedCount: number;
  readonly duplicateSuppressedCount: number;
  readonly newObservationsCount: number;
  readonly alreadyPersistedDuplicateCount: number;
  readonly priceDecreasesCount: number;
  readonly priceIncreasesCount: number;
  readonly unchangedPricesCount: number;
  readonly firstObservationsCount: number;
  readonly candidateOpportunitiesCount: number;
  readonly items: readonly BatchPreviewItem[];
}

export interface PersistApprovedBatchOptions {
  readonly ownerConfirmed: boolean;
  readonly intelligenceConfig?: PriceIntelligenceConfig;
  /**
   * Optional fault injection hook for testing atomic transaction rollback on mid-batch failure.
   */
  readonly simulateCrashAfterObservationsInserted?: number;
}

export interface PersistApprovedBatchResult {
  readonly persisted: boolean;
  readonly idempotentReplay?: boolean;
  readonly reason:
    | "PERSISTED_COMMITTED"
    | "IDEMPOTENT_SCAN_RUN_REPLAY"
    | "CONFLICTING_SCAN_RUN_ID"
    | "OWNER_DECLINED"
    | "INELIGIBLE_BATCH"
    | "TRANSACTION_FAILED";
  readonly scanRunId: string;
  readonly observationsInserted: number;
  readonly observationsSkippedDuplicate: number;
  readonly opportunitiesInserted: number;
  readonly errorSummary?: string;
}

export interface ReevaluateLatestOpportunitiesResult {
  readonly reevaluationRunId: string;
  readonly listingsEvaluated: number;
  readonly opportunitiesInserted: number;
  readonly opportunitiesSuperseded: number;
}

export interface PersistedScanRunRow {
  readonly scanRunId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED_LOCKED";
  readonly providerId: string;
  readonly storeKey?: string;
  readonly fulfillmentContextId?: string;
  readonly candidatesDiscovered: number;
  readonly validObservations: number;
  readonly skippedRecords: number;
  readonly duplicateRecords: number;
  readonly opportunitiesCreated: number;
  readonly errorCategory?: string;
  readonly errorSummary?: string;
}

export interface PersistedProductObservationHistoryRow {
  readonly observationId: string;
  readonly listingKey: string;
  readonly scanRunId: string;
  readonly providerId: string;
  readonly externalStoreId: string;
  readonly storeName: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly productName: string;
  readonly brand?: string;
  readonly packagingLabel: string;
  readonly unitQuantity: number;
  readonly unitType: "g" | "ml" | "unit" | "kg" | "l";
  readonly canonicalProductUrl: string;
  readonly fulfillmentContextId: string;
  readonly citySlug: string;
  readonly observedPriceCop: CopAmount;
  readonly declaredReferencePriceCop?: CopAmount;
  readonly availability: AvailabilityStatus;
  readonly observedAt: string;
  readonly provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
  readonly geographicVerificationVerdict: GeographicVerificationVerdictType;
  readonly servingBranchEvidence: string;
  readonly catalogContextEvidence: string;
  readonly addressSpecificPricingVerified: boolean;
  readonly isSuperseded: boolean;
}

export interface PersistedOpportunityEventRow {
  readonly opportunityId: string;
  readonly deduplicationKey: string;
  readonly listingKey: string;
  readonly observationId: string;
  readonly scanRunId: string;
  readonly externalStoreId: string;
  readonly storeName: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly productName: string;
  readonly packagingLabel: string;
  readonly fulfillmentContextId: string;
  readonly opportunityType: OpportunityType;
  readonly labelEsCo: string;
  readonly baselinePriceCop: CopAmount;
  readonly previousPriceCop?: CopAmount;
  readonly observedPriceCop: CopAmount;
  readonly savingsCop: CopAmount;
  readonly discountBasisPoints: number;
  readonly discountPercentage: number;
  readonly historicalObservationCount: number;
  readonly historicalLowCop: CopAmount;
  readonly historicalMedianCop: CopAmount;
  readonly confidence: ConfidenceLevel;
  readonly requiresVerification: boolean;
  readonly provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
  readonly geographicVerificationVerdict: GeographicVerificationVerdictType;
  readonly rationaleEsCo: string;
  readonly detectedAt: string;
  readonly lifecycleStatus: OpportunityLifecycleStatus;
  readonly eventOrigin: OpportunityEventOrigin;
  readonly reevaluationRunId?: string;
}

export interface PrivateDatabaseStatusSummary {
  readonly dbFilePath: string;
  readonly isInMemory: boolean;
  readonly existsOnDisk: boolean;
  readonly directoryModeOctal?: string;
  readonly fileModeOctal?: string;
  readonly schemaVersion: number;
  readonly counts: {
    readonly stores: number;
    readonly products: number;
    readonly fulfillmentContexts: number;
    readonly scanRuns: number;
    readonly activeObservations: number;
    readonly supersededObservations: number;
    readonly activeOpportunities: number;
  };
}

/**
 * Verifies that a string about to be written to the private SQLite database
 * does not contain raw street addresses, apartment numbers, emails, phone numbers,
 * bearer tokens, or session cookies (`Section 5 & Section 14`).
 */
export function assertNoSensitiveTextInPersistedString(
  value: string | undefined,
  fieldName: string,
): void {
  if (!value) return;
  for (const pattern of FORBIDDEN_PII_OR_CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(
        `Privacy violation prevented: field '${fieldName}' matched forbidden PII or credential pattern.`,
      );
    }
  }
}

function resolveWorkspaceRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

export function assertDatabasePathOutsideRepository(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const resolvedDbPath = path.resolve(dbPath);
  const workspaceRoot = resolveWorkspaceRoot();
  if (
    resolvedDbPath === workspaceRoot ||
    resolvedDbPath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error(
      `Security violation: SQLite database path '${resolvedDbPath}' must reside outside the Git repository ('${workspaceRoot}'). Use ~/.local/share/priceradar/private-history.sqlite or a temporary directory outside the repository.`,
    );
  }
}

export function enforcePrivateDatabaseFilePermissions(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const resolvedDbPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);

  for (const candidate of [
    resolvedDbPath,
    `${resolvedDbPath}-wal`,
    `${resolvedDbPath}-shm`,
  ]) {
    if (fs.existsSync(candidate)) {
      fs.chmodSync(candidate, 0o600);
    }
  }
}

const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  store_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_store_id TEXT NOT NULL,
  storefront_slug TEXT NOT NULL,
  store_name TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  verified_city_slug TEXT,
  verified_city_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(provider_id, external_store_id)
);

CREATE TABLE IF NOT EXISTS products (
  product_variant_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_product_id TEXT NOT NULL,
  external_variant_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  brand TEXT,
  category_slug TEXT NOT NULL,
  packaging_label TEXT NOT NULL,
  unit_quantity INTEGER NOT NULL CHECK (unit_quantity > 0),
  unit_type TEXT NOT NULL CHECK (unit_type IN ('g', 'ml', 'unit', 'kg', 'l')),
  canonical_product_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(provider_id, external_product_id, external_variant_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_contexts (
  fulfillment_context_id TEXT PRIMARY KEY CHECK (
    fulfillment_context_id GLOB 'ctx-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  provider_id TEXT NOT NULL,
  verified_city_slug TEXT,
  verified_city_name TEXT,
  context_verification_status TEXT NOT NULL CHECK (
    context_verification_status IN ('PROVISIONAL_SESSION_CONTEXT', 'VERIFIED_ADDRESS_CONTEXT')
  ),
  active_address_evidence TEXT NOT NULL,
  city_metadata_evidence TEXT NOT NULL,
  serving_branch_evidence TEXT NOT NULL,
  catalog_context_evidence TEXT NOT NULL,
  pricing_verification_verdict TEXT NOT NULL CHECK (
    pricing_verification_verdict IN (
      'VERIFIED_ADDRESS_SPECIFIC_PRICING',
      'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION'
    )
  ),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK (
    (context_verification_status = 'PROVISIONAL_SESSION_CONTEXT' AND pricing_verification_verdict != 'VERIFIED_ADDRESS_SPECIFIC_PRICING')
    OR
    (context_verification_status = 'VERIFIED_ADDRESS_CONTEXT' AND pricing_verification_verdict = 'VERIFIED_ADDRESS_SPECIFIC_PRICING')
  )
);

CREATE TABLE IF NOT EXISTS scan_runs (
  scan_run_id TEXT PRIMARY KEY,
  batch_fingerprint TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED_LOCKED')
  ),
  provider_id TEXT NOT NULL,
  store_key TEXT REFERENCES stores(store_key),
  fulfillment_context_id TEXT REFERENCES fulfillment_contexts(fulfillment_context_id),
  candidates_discovered INTEGER NOT NULL DEFAULT 0 CHECK (candidates_discovered >= 0),
  valid_observations INTEGER NOT NULL DEFAULT 0 CHECK (valid_observations >= 0),
  skipped_records INTEGER NOT NULL DEFAULT 0 CHECK (skipped_records >= 0),
  duplicate_records INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_records >= 0),
  opportunities_created INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_created >= 0),
  error_category TEXT,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS price_observations (
  observation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  listing_key TEXT NOT NULL,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(scan_run_id) ON DELETE CASCADE,
  product_variant_key TEXT NOT NULL REFERENCES products(product_variant_key),
  store_key TEXT NOT NULL REFERENCES stores(store_key),
  fulfillment_context_id TEXT NOT NULL REFERENCES fulfillment_contexts(fulfillment_context_id),
  city_slug TEXT NOT NULL,
  observed_price_cop INTEGER NOT NULL CHECK (observed_price_cop > 0),
  declared_reference_price_cop INTEGER CHECK (
    declared_reference_price_cop IS NULL OR declared_reference_price_cop > observed_price_cop
  ),
  availability TEXT NOT NULL CHECK (
    availability IN ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN')
  ),
  observed_at TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (
    provenance IN ('PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL', 'LIVE_PRIVATE')
  ),
  geographic_verification_verdict TEXT NOT NULL CHECK (
    geographic_verification_verdict IN (
      'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION',
      'VERIFIED_ADDRESS_SPECIFIC_PRICING'
    )
  ),
  serving_branch_evidence TEXT NOT NULL,
  catalog_context_evidence TEXT NOT NULL,
  address_specific_pricing_verified INTEGER NOT NULL CHECK (
    address_specific_pricing_verified IN (0, 1)
  ),
  is_superseded INTEGER NOT NULL DEFAULT 0 CHECK (is_superseded IN (0, 1)),
  superseded_reason TEXT,
  CHECK (
    (provenance = 'PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL' AND address_specific_pricing_verified = 0 AND geographic_verification_verdict = 'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION')
    OR
    (provenance = 'LIVE_PRIVATE' AND address_specific_pricing_verified = 1 AND geographic_verification_verdict = 'VERIFIED_ADDRESS_SPECIFIC_PRICING')
  )
);

CREATE INDEX IF NOT EXISTS idx_price_observations_listing_history
  ON price_observations(listing_key, provenance, is_superseded, observed_at ASC, observation_id ASC);

CREATE INDEX IF NOT EXISTS idx_price_observations_product
  ON price_observations(product_variant_key, observed_at DESC);

CREATE TABLE IF NOT EXISTS reevaluation_runs (
  reevaluation_run_id TEXT PRIMARY KEY,
  executed_at TEXT NOT NULL,
  target_listing_key TEXT,
  listings_evaluated INTEGER NOT NULL DEFAULT 0 CHECK (listings_evaluated >= 0),
  opportunities_inserted INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_inserted >= 0),
  opportunities_superseded INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_superseded >= 0)
);

CREATE TABLE IF NOT EXISTS opportunity_events (
  opportunity_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  listing_key TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES price_observations(observation_id) ON DELETE CASCADE,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(scan_run_id) ON DELETE CASCADE,
  event_origin TEXT NOT NULL DEFAULT 'ORIGINAL_SCAN' CHECK (
    event_origin IN ('ORIGINAL_SCAN', 'HISTORICAL_REEVALUATION')
  ),
  reevaluation_run_id TEXT REFERENCES reevaluation_runs(reevaluation_run_id),
  product_variant_key TEXT NOT NULL REFERENCES products(product_variant_key),
  store_key TEXT NOT NULL REFERENCES stores(store_key),
  fulfillment_context_id TEXT NOT NULL REFERENCES fulfillment_contexts(fulfillment_context_id),
  opportunity_type TEXT NOT NULL CHECK (
    opportunity_type IN ('DECLARED_DISCOUNT', 'HISTORICAL_DROP', 'HISTORICAL_LOW', 'POTENTIAL_ANOMALY')
  ),
  label_es_co TEXT NOT NULL,
  baseline_price_cop INTEGER NOT NULL CHECK (baseline_price_cop > 0),
  previous_price_cop INTEGER CHECK (previous_price_cop IS NULL OR previous_price_cop > 0),
  observed_price_cop INTEGER NOT NULL CHECK (observed_price_cop > 0),
  savings_cop INTEGER NOT NULL CHECK (savings_cop > 0),
  discount_basis_points INTEGER NOT NULL CHECK (
    discount_basis_points > 0 AND discount_basis_points <= 10000
  ),
  discount_percentage INTEGER NOT NULL,
  historical_observation_count INTEGER NOT NULL CHECK (historical_observation_count >= 0),
  historical_low_cop INTEGER NOT NULL CHECK (historical_low_cop > 0),
  historical_median_cop INTEGER NOT NULL CHECK (historical_median_cop > 0),
  confidence TEXT NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  requires_verification INTEGER NOT NULL CHECK (requires_verification IN (0, 1)),
  provenance TEXT NOT NULL CHECK (
    provenance IN ('PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL', 'LIVE_PRIVATE')
  ),
  geographic_verification_verdict TEXT NOT NULL CHECK (
    geographic_verification_verdict IN (
      'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION',
      'VERIFIED_ADDRESS_SPECIFIC_PRICING'
    )
  ),
  rationale_es_co TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    lifecycle_status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'DISMISSED')
  )
);

CREATE INDEX IF NOT EXISTS idx_opportunity_events_listing
  ON opportunity_events(listing_key, lifecycle_status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_opportunity_events_type
  ON opportunity_events(opportunity_type, lifecycle_status, discount_basis_points DESC);

CREATE INDEX IF NOT EXISTS idx_opportunity_events_scan_origin
  ON opportunity_events(scan_run_id, event_origin);
`;

/**
 * Builds a baseline-aware opportunity deduplication key (`Round 3 Additional Check`).
 * Embeds `baselinePriceCop`, `previousPriceCop`, `historicalObservationCount`, `historicalLowCop`,
 * and `historicalMedianCop` so that when historical baseline observations are corrected or superseded,
 * a recalculated candidate with updated baseline metrics never collides with a stale opportunity row.
 */
export function buildOpportunityDeduplicationKey(
  opp: OpportunityCandidate,
  observationId: string,
): string {
  return `${opp.opportunityKey}::${observationId}::base=${String(opp.baselinePriceCop)}:prev=${String(opp.previousPriceCop ?? 0)}:cnt=${String(opp.historicalObservationCount)}:low=${String(opp.historicalLowCop)}:med=${String(opp.historicalMedianCop)}`;
}

/**
 * Evaluates whether a supervised storefront inspection snapshot meets all Phase P2
 * eligibility gates for private persistence (`Section 6`).
 */
export function evaluateBatchPersistenceEligibility(
  context: SupervisedPersistenceContextInput,
): {
  readonly isEligible: boolean;
  readonly rejectionReason?: string;
  readonly effectiveProvenance?:
    "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
  readonly effectiveVerdict: GeographicVerificationVerdictType;
} {
  if (
    context.hasSecurityChallenge === true ||
    context.gateStatus === "CHALLENGE_DETECTED"
  ) {
    return {
      isEligible: false,
      rejectionReason:
        "Se detectó un desafío de seguridad (WAF/CAPTCHA). Observación rechazada.",
      effectiveVerdict: context.pricingVerificationVerdict,
    };
  }

  if (context.isLoginRequired === true || context.gateStatus === "AUTH_REQUIRED") {
    return {
      isEligible: false,
      rejectionReason: "Se requiere sesión autenticada en Rappi. Observación rechazada.",
      effectiveVerdict: context.pricingVerificationVerdict,
    };
  }

  if (
    !context.navigationStates.ADDRESS_SELECTED ||
    context.activeAddressSelection !== "VERIFIED_ACTIVE_SELECTION"
  ) {
    return {
      isEligible: false,
      rejectionReason:
        "No hay dirección de entrega activa seleccionada manualmente en el encabezado.",
      effectiveVerdict: "UNVERIFIED_NO_ACTIVE_ADDRESS",
    };
  }

  if (
    !context.fulfillmentContextHash ||
    !OPAQUE_CONTEXT_ID_REGEX.test(context.fulfillmentContextHash) ||
    context.pricingVerificationVerdict === "UNVERIFIED_MISSING_HMAC_SECRET"
  ) {
    return {
      isEligible: false,
      rejectionReason:
        "Falta el secreto HMAC válido (PRICERADAR_CONTEXT_HMAC_SECRET) o el identificador opaco ctx-<16hex>.",
      effectiveVerdict: "UNVERIFIED_MISSING_HMAC_SECRET",
    };
  }

  if (!context.navigationStates.STORE_OPENED_FROM_ADDRESS_CONTEXT) {
    return {
      isEligible: false,
      rejectionReason:
        "La tienda no fue abierta desde el directorio bajo el contexto de dirección activa.",
      effectiveVerdict: context.pricingVerificationVerdict,
    };
  }

  if (
    !context.navigationStates.CATALOG_VISIBLE_IN_SESSION ||
    context.productCatalogContext === "UNVERIFIED_STATIC_SEO_HYDRATION" ||
    context.productCatalogContext === "EMPTY_CATALOG"
  ) {
    return {
      isEligible: false,
      rejectionReason:
        "El catálogo proviene de hidratación estática SEO (#__NEXT_DATA__) o no tiene tarjetas DOM renderizadas en la sesión.",
      effectiveVerdict: "UNVERIFIED_STATIC_SEO_PRICING",
    };
  }

  if (context.listings.length === 0) {
    return {
      isEligible: false,
      rejectionReason:
        "No se encontraron productos válidos con identificador, nombre y precio entero en COP.",
      effectiveVerdict: context.pricingVerificationVerdict,
    };
  }

  const isFullyAddressVerified =
    context.isDeliveryContextVerified &&
    context.navigationStates.ADDRESS_SPECIFIC_PRICING_VERIFIED &&
    context.pricingVerificationVerdict === "VERIFIED_ADDRESS_SPECIFIC_PRICING";

  const effectiveProvenance:
    "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE" = isFullyAddressVerified
    ? "LIVE_PRIVATE"
    : "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL";

  const effectiveVerdict: GeographicVerificationVerdictType = isFullyAddressVerified
    ? "VERIFIED_ADDRESS_SPECIFIC_PRICING"
    : "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION";

  return {
    isEligible: true,
    effectiveProvenance,
    effectiveVerdict,
  };
}

/**
 * Computes a deterministic SHA-256 hex fingerprint for an inspection batch (`F-P2-07`).
 * Used to distinguish an identical idempotent `scan_run_id` replay from a conflicting reuse.
 */
export function computeScanBatchFingerprint(
  context: SupervisedPersistenceContextInput,
  effectiveProvenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE",
  effectiveVerdict: GeographicVerificationVerdictType,
): string {
  const canonicalListings = context.listings
    .map((item) => ({
      providerId: item.providerId,
      storeId: item.store.externalStoreId,
      productId: item.variant.externalProductId,
      variantId: item.variant.externalVariantId,
      observedPriceCop: item.observedPriceCop,
      declaredReferencePriceCop: item.declaredReferencePriceCop ?? null,
      availability: item.availability,
      sourceObservedAt: item.sourceObservedAt,
    }))
    .sort((a, b) =>
      `${a.providerId}::${a.storeId}::${a.productId}::${a.variantId}::${a.sourceObservedAt}`.localeCompare(
        `${b.providerId}::${b.storeId}::${b.productId}::${b.variantId}::${b.sourceObservedAt}`,
      ),
    );

  const canonicalPayload = JSON.stringify({
    observedAtIso: context.observedAtIso,
    citySlug: context.citySlug,
    fulfillmentContextHash: context.fulfillmentContextHash ?? null,
    effectiveProvenance,
    effectiveVerdict,
    candidatesDiscoveredCount: context.candidatesDiscoveredCount,
    skippedMalformedCount: context.skippedMalformedCount,
    duplicateSuppressedCount: context.duplicateSuppressedCount,
    listings: canonicalListings,
  });

  return crypto.createHash("sha256").update(canonicalPayload).digest("hex");
}

/**
 * Local private SQLite storage repository (`Phase P2`) backed by Node.js built-in `node:sqlite`.
 */
export class SqlitePrivateHistoryRepository {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;
  private isClosed = false;

  public constructor(dbPath: string = DEFAULT_PRIVATE_SQLITE_DB_PATH) {
    assertDatabasePathOutsideRepository(dbPath);
    this.dbPath = dbPath === ":memory:" ? ":memory:" : path.resolve(dbPath);

    if (this.dbPath !== ":memory:") {
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

    this.runMigrations();
    enforcePrivateDatabaseFilePermissions(this.dbPath);
  }

  public getDatabasePath(): string {
    return this.dbPath;
  }

  public close(): void {
    if (!this.isClosed) {
      this.db.close();
      this.isClosed = true;
      enforcePrivateDatabaseFilePermissions(this.dbPath);
    }
  }

  private runMigrations(): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.exec(MIGRATION_V1_SQL);
      const scanRunsColumns = this.db
        .prepare("PRAGMA table_info(scan_runs)")
        .all() as Array<{ name: string }>;
      if (!scanRunsColumns.some((col) => col.name === "batch_fingerprint")) {
        this.db.exec("ALTER TABLE scan_runs ADD COLUMN batch_fingerprint TEXT;");
      }

      const oppColumns = this.db
        .prepare("PRAGMA table_info(opportunity_events)")
        .all() as Array<{ name: string }>;
      if (!oppColumns.some((col) => col.name === "event_origin")) {
        this.db.exec(
          "ALTER TABLE opportunity_events ADD COLUMN event_origin TEXT NOT NULL DEFAULT 'ORIGINAL_SCAN' CHECK (event_origin IN ('ORIGINAL_SCAN', 'HISTORICAL_REEVALUATION'));",
        );
      }
      if (!oppColumns.some((col) => col.name === "reevaluation_run_id")) {
        this.db.exec(
          "ALTER TABLE opportunity_events ADD COLUMN reevaluation_run_id TEXT REFERENCES reevaluation_runs(reevaluation_run_id);",
        );
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_opportunity_events_scan_origin ON opportunity_events(scan_run_id, event_origin);",
      );

      const nowIso = new Date().toISOString();
      const existingV1 = this.db
        .prepare("SELECT version FROM schema_migrations WHERE version = 1")
        .get() as { version?: number } | undefined;
      if (!existingV1) {
        this.db
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(1, "001_initial_private_price_history_schema", nowIso);
      }

      const existingV2 = this.db
        .prepare("SELECT version FROM schema_migrations WHERE version = 2")
        .get() as { version?: number } | undefined;
      if (!existingV2) {
        this.db
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(2, "002_reevaluation_audit_and_event_origin", nowIso);
      }

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  public withImmediateTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      enforcePrivateDatabaseFilePermissions(this.dbPath);
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback error if already rolled back
      }
      throw err;
    }
  }

  /**
   * Returns strictly prior, non-superseded historical observations for a specific `listingKey`
   * and `provenance`, ordered deterministically by `(observed_at ASC, observation_id ASC)`.
   */
  public getPersistedHistoryForListing(
    listingKey: string,
    provenance?: DataProvenance,
  ): readonly PriceObservationRecord[] {
    const rows = (
      provenance
        ? this.db
            .prepare(
              `SELECT
                o.observation_id,
                o.listing_key,
                p.provider_id,
                s.external_store_id,
                p.external_product_id,
                p.external_variant_id,
                o.city_slug,
                o.observed_price_cop,
                o.declared_reference_price_cop,
                o.availability,
                o.provenance,
                o.observed_at
              FROM price_observations o
              JOIN products p ON p.product_variant_key = o.product_variant_key
              JOIN stores s ON s.store_key = o.store_key
              WHERE o.listing_key = ? AND o.provenance = ? AND o.is_superseded = 0
              ORDER BY o.observed_at ASC, o.observation_id ASC`,
            )
            .all(listingKey, provenance)
        : this.db
            .prepare(
              `SELECT
                o.observation_id,
                o.listing_key,
                p.provider_id,
                s.external_store_id,
                p.external_product_id,
                p.external_variant_id,
                o.city_slug,
                o.observed_price_cop,
                o.declared_reference_price_cop,
                o.availability,
                o.provenance,
                o.observed_at
              FROM price_observations o
              JOIN products p ON p.product_variant_key = o.product_variant_key
              JOIN stores s ON s.store_key = o.store_key
              WHERE o.listing_key = ? AND o.is_superseded = 0
              ORDER BY o.observed_at ASC, o.observation_id ASC`,
            )
            .all(listingKey)
    ) as Array<{
      observation_id: string;
      listing_key: string;
      provider_id: string;
      external_store_id: string;
      external_product_id: string;
      external_variant_id: string;
      city_slug: string;
      observed_price_cop: number;
      declared_reference_price_cop: number | null;
      availability: AvailabilityStatus;
      provenance: DataProvenance;
      observed_at: string;
    }>;

    return rows.map((r) => ({
      observationId: r.observation_id,
      listingKey: r.listing_key,
      providerId: r.provider_id,
      externalStoreId: r.external_store_id,
      externalProductId: r.external_product_id,
      externalVariantId: r.external_variant_id,
      citySlug: r.city_slug,
      observedPriceCop: createCopAmount(r.observed_price_cop),
      ...(r.declared_reference_price_cop !== null
        ? { declaredReferencePriceCop: createCopAmount(r.declared_reference_price_cop) }
        : {}),
      availability: r.availability,
      provenance: r.provenance,
      observedAt: r.observed_at,
    }));
  }

  public getExistingActiveOpportunitiesForListing(
    listingKey: string,
  ): readonly OpportunityCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT
          deduplication_key,
          listing_key,
          opportunity_type,
          label_es_co,
          observed_price_cop,
          baseline_price_cop,
          previous_price_cop,
          savings_cop,
          discount_basis_points,
          discount_percentage,
          historical_observation_count,
          historical_low_cop,
          historical_median_cop,
          confidence,
          requires_verification,
          rationale_es_co,
          provenance,
          detected_at
        FROM opportunity_events
        WHERE listing_key = ? AND lifecycle_status = 'ACTIVE'
        ORDER BY detected_at DESC`,
      )
      .all(listingKey) as Array<{
      deduplication_key: string;
      listing_key: string;
      opportunity_type: OpportunityType;
      label_es_co: string;
      observed_price_cop: number;
      baseline_price_cop: number;
      previous_price_cop: number | null;
      savings_cop: number;
      discount_basis_points: number;
      discount_percentage: number;
      historical_observation_count: number;
      historical_low_cop: number;
      historical_median_cop: number;
      confidence: ConfidenceLevel;
      requires_verification: number;
      rationale_es_co: string;
      provenance: DataProvenance;
      detected_at: string;
    }>;

    return rows.map((r) => ({
      opportunityKey: r.deduplication_key,
      listingKey: r.listing_key,
      type: r.opportunity_type,
      labelEsCo: r.label_es_co,
      observedPriceCop: createCopAmount(r.observed_price_cop),
      baselinePriceCop: createCopAmount(r.baseline_price_cop),
      ...(r.previous_price_cop !== null
        ? { previousPriceCop: createCopAmount(r.previous_price_cop) }
        : {}),
      savingsCop: createCopAmount(r.savings_cop),
      discountBasisPoints: r.discount_basis_points,
      discountPercentage: r.discount_percentage,
      historicalObservationCount: r.historical_observation_count,
      historicalLowCop: createCopAmount(r.historical_low_cop),
      historicalMedianCop: createCopAmount(r.historical_median_cop),
      confidence: r.confidence,
      requiresVerification: r.requires_verification === 1,
      rationaleEsCo: r.rationale_es_co,
      provenance: r.provenance,
      detectedAt: r.detected_at,
    }));
  }

  /**
   * Read-only preview of an inspected storefront batch against existing SQLite history.
   * Performs zero database writes.
   */
  public previewInspectionBatchAgainstHistory(
    context: SupervisedPersistenceContextInput,
    intelligenceConfig: PriceIntelligenceConfig = PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
  ): BatchPreviewSummary {
    const eligibility = evaluateBatchPersistenceEligibility(context);
    if (!eligibility.isEligible || !eligibility.effectiveProvenance) {
      return {
        isEligible: false,
        ...(eligibility.rejectionReason !== undefined
          ? { rejectionReason: eligibility.rejectionReason }
          : {}),
        geographicVerificationVerdict: eligibility.effectiveVerdict,
        addressSpecificPricingVerified: false,
        candidatesDiscoveredCount: context.candidatesDiscoveredCount,
        eligibleListingsCount: 0,
        skippedMalformedCount: context.skippedMalformedCount,
        duplicateSuppressedCount: context.duplicateSuppressedCount,
        newObservationsCount: 0,
        alreadyPersistedDuplicateCount: 0,
        priceDecreasesCount: 0,
        priceIncreasesCount: 0,
        unchangedPricesCount: 0,
        firstObservationsCount: 0,
        candidateOpportunitiesCount: 0,
        items: [],
      };
    }

    const effectiveProvenance = eligibility.effectiveProvenance;
    const contextHash = context.fulfillmentContextHash ?? "";
    const firstListing = context.listings[0];

    let newObservationsCount = 0;
    let alreadyPersistedDuplicateCount = 0;
    let priceDecreasesCount = 0;
    let priceIncreasesCount = 0;
    let unchangedPricesCount = 0;
    let firstObservationsCount = 0;
    let candidateOpportunitiesCount = 0;
    const items: BatchPreviewItem[] = [];

    const checkIdempotencyStmt = this.db.prepare(
      "SELECT 1 FROM price_observations WHERE idempotency_key = ? LIMIT 1",
    );

    for (const rawListing of context.listings) {
      const normalizedListing: DiscoveredListing = {
        ...rawListing,
        provenance: effectiveProvenance,
        geographicContext: {
          ...rawListing.geographicContext,
          zoneCode: contextHash,
        },
      };

      const listingKey = buildCanonicalListingKey({
        providerId: normalizedListing.providerId,
        externalStoreId: normalizedListing.store.externalStoreId,
        externalProductId: normalizedListing.variant.externalProductId,
        externalVariantId: normalizedListing.variant.externalVariantId,
        citySlug: normalizedListing.geographicContext.citySlug,
        zoneCode: contextHash,
      });

      const idempotencyKey = buildObservationIdempotencyKey({
        listingKey,
        observedPriceCop: normalizedListing.observedPriceCop,
        bucketTimestampIso: normalizedListing.sourceObservedAt,
      });

      const alreadyExists = Boolean(checkIdempotencyStmt.get(idempotencyKey));
      if (alreadyExists) {
        alreadyPersistedDuplicateCount += 1;
      } else {
        newObservationsCount += 1;
      }

      const historicalObservations = this.getPersistedHistoryForListing(
        listingKey,
        effectiveProvenance,
      );
      const existingOpportunities =
        this.getExistingActiveOpportunitiesForListing(listingKey);

      const comparison = compareObservationAgainstHistory({
        listingKey,
        currentPriceCop: normalizedListing.observedPriceCop,
        currentObservedAtIso: normalizedListing.sourceObservedAt,
        provenance: effectiveProvenance,
        historicalObservations,
      });

      if (comparison.movement === "FIRST_OBSERVATION") firstObservationsCount += 1;
      else if (comparison.movement === "UNCHANGED_PRICE") unchangedPricesCount += 1;
      else if (comparison.movement === "PRICE_DECREASE") priceDecreasesCount += 1;
      else if (comparison.movement === "PRICE_INCREASE") priceIncreasesCount += 1;

      const currentObservedAtMs = Date.parse(normalizedListing.sourceObservedAt);
      const hasNewerActiveObservation = historicalObservations.some(
        (obs) => Date.parse(obs.observedAt) > currentObservedAtMs,
      );

      const candidateOpportunities =
        alreadyExists || hasNewerActiveObservation
          ? []
          : evaluateListingOpportunities({
              listing: normalizedListing,
              historicalObservations,
              existingOpportunities,
              config: intelligenceConfig,
              evaluationTimeIso: context.observedAtIso,
            });

      candidateOpportunitiesCount += candidateOpportunities.length;
      items.push({
        listing: normalizedListing,
        listingKey,
        comparison,
        candidateOpportunities,
      });
    }

    return {
      isEligible: true,
      ...(firstListing
        ? {
            storeId: firstListing.store.externalStoreId,
            storeName: firstListing.store.name,
          }
        : {}),
      fulfillmentContextId: contextHash,
      provenance: effectiveProvenance,
      geographicVerificationVerdict: eligibility.effectiveVerdict,
      addressSpecificPricingVerified: effectiveProvenance === "LIVE_PRIVATE",
      candidatesDiscoveredCount: context.candidatesDiscoveredCount,
      eligibleListingsCount: context.listings.length,
      skippedMalformedCount: context.skippedMalformedCount,
      duplicateSuppressedCount: context.duplicateSuppressedCount,
      newObservationsCount,
      alreadyPersistedDuplicateCount,
      priceDecreasesCount,
      priceIncreasesCount,
      unchangedPricesCount,
      firstObservationsCount,
      candidateOpportunitiesCount,
      items,
    };
  }

  /**
   * Atomically persists an eligible, owner-approved inspection batch into SQLite (`Sections 6-10`, `F-P2-06`, `F-P2-07`).
   * Never writes if `options.ownerConfirmed !== true`.
   */
  public persistApprovedInspectionBatch(
    context: SupervisedPersistenceContextInput,
    options: PersistApprovedBatchOptions,
  ): PersistApprovedBatchResult {
    if (options.ownerConfirmed !== true) {
      return {
        persisted: false,
        reason: "OWNER_DECLINED",
        scanRunId: context.scanRunId,
        observationsInserted: 0,
        observationsSkippedDuplicate: 0,
        opportunitiesInserted: 0,
      };
    }

    const eligibility = evaluateBatchPersistenceEligibility(context);
    if (
      !eligibility.isEligible ||
      !eligibility.effectiveProvenance ||
      !context.fulfillmentContextHash
    ) {
      return {
        persisted: false,
        reason: "INELIGIBLE_BATCH",
        scanRunId: context.scanRunId,
        observationsInserted: 0,
        observationsSkippedDuplicate: 0,
        opportunitiesInserted: 0,
        ...(eligibility.rejectionReason !== undefined
          ? { errorSummary: eligibility.rejectionReason }
          : {}),
      };
    }

    const effectiveProvenance = eligibility.effectiveProvenance;
    const effectiveVerdict = eligibility.effectiveVerdict;
    const contextHash = context.fulfillmentContextHash;
    const intelligenceConfig =
      options.intelligenceConfig ?? PRIVATE_HISTORY_INTELLIGENCE_CONFIG;
    const batchFingerprint = computeScanBatchFingerprint(
      context,
      effectiveProvenance,
      effectiveVerdict,
    );

    assertNoSensitiveTextInPersistedString(contextHash, "fulfillmentContextHash");
    assertNoSensitiveTextInPersistedString(context.citySlug, "citySlug");
    assertNoSensitiveTextInPersistedString(context.cityName, "cityName");

    let observationsInserted = 0;
    let observationsSkippedDuplicate = 0;
    let opportunitiesInserted = 0;
    let earlyScanRunResult: PersistApprovedBatchResult | undefined;

    try {
      this.withImmediateTransaction(() => {
        const firstListing = context.listings[0];
        if (!firstListing) {
          throw new Error("Empty listings in eligible batch.");
        }

        // F-P2-07: Check if scan_run_id already exists before any mutation
        const existingScanRun = this.db
          .prepare(
            `SELECT
              status,
              batch_fingerprint,
              valid_observations,
              duplicate_records,
              opportunities_created
            FROM scan_runs
            WHERE scan_run_id = ?
            LIMIT 1`,
          )
          .get(context.scanRunId) as
          | {
              status: string;
              batch_fingerprint: string | null;
              valid_observations: number;
              duplicate_records: number;
              opportunities_created: number;
            }
          | undefined;

        if (existingScanRun) {
          if (
            existingScanRun.status === "SUCCEEDED" &&
            existingScanRun.batch_fingerprint === batchFingerprint
          ) {
            const obsCountRow = this.db
              .prepare(
                "SELECT COUNT(*) as c FROM price_observations WHERE scan_run_id = ?",
              )
              .get(context.scanRunId) as { c: number } | undefined;
            const oppCountRow = this.db
              .prepare(
                "SELECT COUNT(*) as c FROM opportunity_events WHERE scan_run_id = ? AND event_origin = 'ORIGINAL_SCAN'",
              )
              .get(context.scanRunId) as { c: number } | undefined;

            const persistedObsForRun = Number(obsCountRow?.c ?? 0);
            const persistedOppForRun = Number(oppCountRow?.c ?? 0);

            if (
              persistedObsForRun !== existingScanRun.valid_observations ||
              persistedOppForRun !== existingScanRun.opportunities_created
            ) {
              throw new Error(
                `Execution integrity error: existing scan_run_id '${context.scanRunId}' counters (${String(existingScanRun.valid_observations)}/${String(existingScanRun.opportunities_created)}) do not match persisted rows (${String(persistedObsForRun)}/${String(persistedOppForRun)}).`,
              );
            }

            earlyScanRunResult = {
              persisted: true,
              idempotentReplay: true,
              reason: "IDEMPOTENT_SCAN_RUN_REPLAY",
              scanRunId: context.scanRunId,
              observationsInserted: 0,
              observationsSkippedDuplicate: context.listings.length,
              opportunitiesInserted: 0,
            };
            return;
          }

          earlyScanRunResult = {
            persisted: false,
            reason: "CONFLICTING_SCAN_RUN_ID",
            scanRunId: context.scanRunId,
            observationsInserted: 0,
            observationsSkippedDuplicate: 0,
            opportunitiesInserted: 0,
            errorSummary: `Reused scan_run_id '${context.scanRunId}' conflicts with an existing execution (status=${existingScanRun.status}). Never overwrite a completed or active scan run with conflicting batch data.`,
          };
          return;
        }

        const providerId = firstListing.providerId;
        const storeKey = `${providerId}::${firstListing.store.externalStoreId}`;
        const isCityVerifiedFromActiveContext =
          context.cityAndNeighborhoodMetadata === "VERIFIED_FROM_ACTIVE_CONTEXT";
        const verifiedCitySlug = isCityVerifiedFromActiveContext
          ? context.citySlug
          : null;
        const verifiedCityName = isCityVerifiedFromActiveContext
          ? context.cityName
          : null;

        // 1. Upsert fulfillment_contexts (never stores raw street addresses)
        const contextVerificationStatus =
          effectiveProvenance === "LIVE_PRIVATE"
            ? "VERIFIED_ADDRESS_CONTEXT"
            : "PROVISIONAL_SESSION_CONTEXT";

        this.db
          .prepare(
            `INSERT INTO fulfillment_contexts (
              fulfillment_context_id,
              provider_id,
              verified_city_slug,
              verified_city_name,
              context_verification_status,
              active_address_evidence,
              city_metadata_evidence,
              serving_branch_evidence,
              catalog_context_evidence,
              pricing_verification_verdict,
              first_seen_at,
              last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fulfillment_context_id) DO UPDATE SET
              last_seen_at = excluded.last_seen_at,
              verified_city_slug = COALESCE(excluded.verified_city_slug, fulfillment_contexts.verified_city_slug),
              verified_city_name = COALESCE(excluded.verified_city_name, fulfillment_contexts.verified_city_name)`,
          )
          .run(
            contextHash,
            providerId,
            verifiedCitySlug,
            verifiedCityName,
            contextVerificationStatus,
            context.activeAddressSelection,
            context.cityAndNeighborhoodMetadata,
            context.servingStoreBranch,
            context.productCatalogContext,
            effectiveVerdict,
            context.observedAtIso,
            context.observedAtIso,
          );

        // 2. Upsert stores
        assertNoSensitiveTextInPersistedString(
          firstListing.store.externalStoreId,
          "externalStoreId",
        );
        assertNoSensitiveTextInPersistedString(firstListing.store.name, "storeName");

        this.db
          .prepare(
            `INSERT INTO stores (
              store_key,
              provider_id,
              external_store_id,
              storefront_slug,
              store_name,
              category_slug,
              verified_city_slug,
              verified_city_name,
              first_seen_at,
              last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(store_key) DO UPDATE SET
              store_name = excluded.store_name,
              last_seen_at = excluded.last_seen_at,
              verified_city_slug = COALESCE(excluded.verified_city_slug, stores.verified_city_slug),
              verified_city_name = COALESCE(excluded.verified_city_name, stores.verified_city_name)`,
          )
          .run(
            storeKey,
            providerId,
            firstListing.store.externalStoreId,
            firstListing.store.externalStoreId,
            firstListing.store.name,
            firstListing.store.categorySlug,
            verifiedCitySlug,
            verifiedCityName,
            context.observedAtIso,
            context.observedAtIso,
          );

        // 3. Insert new scan_runs header (strict INSERT without ON CONFLICT DO UPDATE)
        this.db
          .prepare(
            `INSERT INTO scan_runs (
              scan_run_id,
              batch_fingerprint,
              started_at,
              completed_at,
              status,
              provider_id,
              store_key,
              fulfillment_context_id,
              candidates_discovered,
              valid_observations,
              skipped_records,
              duplicate_records,
              opportunities_created
            ) VALUES (?, ?, ?, NULL, 'RUNNING', ?, ?, ?, ?, 0, ?, ?, 0)`,
          )
          .run(
            context.scanRunId,
            batchFingerprint,
            context.observedAtIso,
            providerId,
            storeKey,
            contextHash,
            context.candidatesDiscoveredCount,
            context.skippedMalformedCount,
            context.duplicateSuppressedCount,
          );

        const upsertProductStmt = this.db.prepare(
          `INSERT INTO products (
            product_variant_key,
            provider_id,
            external_product_id,
            external_variant_id,
            product_name,
            brand,
            category_slug,
            packaging_label,
            unit_quantity,
            unit_type,
            canonical_product_url,
            first_seen_at,
            last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(product_variant_key) DO UPDATE SET
            product_name = excluded.product_name,
            brand = COALESCE(excluded.brand, products.brand),
            packaging_label = excluded.packaging_label,
            canonical_product_url = excluded.canonical_product_url,
            last_seen_at = excluded.last_seen_at`,
        );

        const insertObservationStmt = this.db.prepare(
          `INSERT INTO price_observations (
            observation_id,
            idempotency_key,
            listing_key,
            scan_run_id,
            product_variant_key,
            store_key,
            fulfillment_context_id,
            city_slug,
            observed_price_cop,
            declared_reference_price_cop,
            availability,
            observed_at,
            provenance,
            geographic_verification_verdict,
            serving_branch_evidence,
            catalog_context_evidence,
            address_specific_pricing_verified,
            is_superseded
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(idempotency_key) DO NOTHING`,
        );

        const insertOpportunityStmt = this.db.prepare(
          `INSERT INTO opportunity_events (
            opportunity_id,
            deduplication_key,
            listing_key,
            observation_id,
            scan_run_id,
            event_origin,
            reevaluation_run_id,
            product_variant_key,
            store_key,
            fulfillment_context_id,
            opportunity_type,
            label_es_co,
            baseline_price_cop,
            previous_price_cop,
            observed_price_cop,
            savings_cop,
            discount_basis_points,
            discount_percentage,
            historical_observation_count,
            historical_low_cop,
            historical_median_cop,
            confidence,
            requires_verification,
            provenance,
            geographic_verification_verdict,
            rationale_es_co,
            detected_at,
            lifecycle_status
          ) VALUES (?, ?, ?, ?, ?, 'ORIGINAL_SCAN', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
          ON CONFLICT(deduplication_key) DO NOTHING`,
        );

        const supersedeOlderOpportunitiesStmt = this.db.prepare(
          `UPDATE opportunity_events
           SET lifecycle_status = 'SUPERSEDED'
           WHERE listing_key = ?
             AND opportunity_type = ?
             AND deduplication_key != ?
             AND lifecycle_status = 'ACTIVE'
             AND observation_id IN (
               SELECT observation_id FROM price_observations WHERE observed_at <= ?
             )`,
        );

        for (const rawListing of context.listings) {
          const validatedPrice = createCopAmount(rawListing.observedPriceCop);
          const validatedRefPrice =
            rawListing.declaredReferencePriceCop !== undefined
              ? createCopAmount(rawListing.declaredReferencePriceCop)
              : null;

          assertNoSensitiveTextInPersistedString(rawListing.variant.name, "productName");
          assertNoSensitiveTextInPersistedString(
            rawListing.variant.productUrl,
            "productUrl",
          );

          const productVariantKey = `${rawListing.providerId}::${rawListing.variant.externalProductId}::${rawListing.variant.externalVariantId}`;
          const normalizedBrand =
            rawListing.variant.brand &&
            rawListing.variant.brand !== "Sin marca especificada"
              ? rawListing.variant.brand
              : null;

          upsertProductStmt.run(
            productVariantKey,
            rawListing.providerId,
            rawListing.variant.externalProductId,
            rawListing.variant.externalVariantId,
            rawListing.variant.name,
            normalizedBrand,
            rawListing.variant.categorySlug,
            rawListing.variant.packagingLabel,
            rawListing.variant.unitQuantity,
            rawListing.variant.unitType,
            rawListing.variant.productUrl,
            rawListing.sourceObservedAt,
            rawListing.sourceObservedAt,
          );

          const listingKey = buildCanonicalListingKey({
            providerId: rawListing.providerId,
            externalStoreId: rawListing.store.externalStoreId,
            externalProductId: rawListing.variant.externalProductId,
            externalVariantId: rawListing.variant.externalVariantId,
            citySlug: context.citySlug,
            zoneCode: contextHash,
          });

          // Section 9: Fetch previously persisted observations BEFORE inserting the current observation
          const historicalObservations = this.getPersistedHistoryForListing(
            listingKey,
            effectiveProvenance,
          );
          const existingOpportunities =
            this.getExistingActiveOpportunitiesForListing(listingKey);

          const idempotencyKey = buildObservationIdempotencyKey({
            listingKey,
            observedPriceCop: validatedPrice,
            bucketTimestampIso: rawListing.sourceObservedAt,
          });
          const observationId = `obs::${context.scanRunId}::${listingKey}`;

          const insertResult = insertObservationStmt.run(
            observationId,
            idempotencyKey,
            listingKey,
            context.scanRunId,
            productVariantKey,
            storeKey,
            contextHash,
            context.citySlug,
            validatedPrice,
            validatedRefPrice,
            rawListing.availability,
            rawListing.sourceObservedAt,
            effectiveProvenance,
            effectiveVerdict,
            context.servingStoreBranch,
            context.productCatalogContext,
            effectiveProvenance === "LIVE_PRIVATE" ? 1 : 0,
          );

          const wasInserted = Number(insertResult.changes) > 0;
          if (!wasInserted) {
            // F-P2-06: Duplicate observations must NEVER generate new opportunity events
            // or supersede existing active opportunities during replay.
            observationsSkippedDuplicate += 1;
            continue;
          }

          observationsInserted += 1;

          if (
            options.simulateCrashAfterObservationsInserted !== undefined &&
            observationsInserted >= options.simulateCrashAfterObservationsInserted
          ) {
            throw new Error(
              "Simulated mid-transaction crash after inserting observation.",
            );
          }

          // Targeted Check #1: If a chronologically newer active observation already exists for this
          // (listingKey, provenance), this observation is an out-of-order historical backfill and
          // must NOT emit a misleading current alert or supersede newer opportunities.
          const currentObservedAtMs = Date.parse(rawListing.sourceObservedAt);
          const hasNewerActiveObservation = historicalObservations.some(
            (obs) => Date.parse(obs.observedAt) > currentObservedAtMs,
          );
          if (hasNewerActiveObservation) {
            continue;
          }

          const normalizedListing: DiscoveredListing = {
            ...rawListing,
            provenance: effectiveProvenance,
            geographicContext: {
              countryCode: "CO",
              citySlug: context.citySlug,
              cityName: context.cityName,
              zoneCode: contextHash,
            },
          };

          const candidates = evaluateListingOpportunities({
            listing: normalizedListing,
            historicalObservations,
            existingOpportunities,
            config: intelligenceConfig,
            evaluationTimeIso: context.observedAtIso,
          });

          for (const opp of candidates) {
            const deduplicationKey = buildOpportunityDeduplicationKey(opp, observationId);
            const opportunityId = `opp::${context.scanRunId}::${opp.opportunityKey}`;
            const oppResult = insertOpportunityStmt.run(
              opportunityId,
              deduplicationKey,
              listingKey,
              observationId,
              context.scanRunId,
              productVariantKey,
              storeKey,
              contextHash,
              opp.type,
              opp.labelEsCo,
              opp.baselinePriceCop,
              opp.previousPriceCop ?? null,
              opp.observedPriceCop,
              opp.savingsCop,
              opp.discountBasisPoints,
              opp.discountPercentage,
              opp.historicalObservationCount,
              opp.historicalLowCop,
              opp.historicalMedianCop,
              opp.confidence,
              opp.requiresVerification ? 1 : 0,
              effectiveProvenance,
              effectiveVerdict,
              opp.rationaleEsCo,
              opp.detectedAt,
            );

            if (Number(oppResult.changes) > 0) {
              opportunitiesInserted += 1;
              supersedeOlderOpportunitiesStmt.run(
                listingKey,
                opp.type,
                deduplicationKey,
                rawListing.sourceObservedAt,
              );
            }
          }
        }

        // F-P2-07 & F-P2-08: Verify final persisted counts for ORIGINAL_SCAN match in-memory counters before marking SUCCEEDED
        const persistedObsCheck = this.db
          .prepare("SELECT COUNT(*) as c FROM price_observations WHERE scan_run_id = ?")
          .get(context.scanRunId) as { c: number } | undefined;
        const persistedOppCheck = this.db
          .prepare(
            "SELECT COUNT(*) as c FROM opportunity_events WHERE scan_run_id = ? AND event_origin = 'ORIGINAL_SCAN'",
          )
          .get(context.scanRunId) as { c: number } | undefined;

        const actualObsCount = Number(persistedObsCheck?.c ?? 0);
        const actualOppCount = Number(persistedOppCheck?.c ?? 0);

        if (
          actualObsCount !== observationsInserted ||
          actualOppCount !== opportunitiesInserted
        ) {
          throw new Error(
            `Execution consistency check failed for scan_run_id '${context.scanRunId}': expected (${String(observationsInserted)}, ${String(opportunitiesInserted)}) but persisted (${String(actualObsCount)}, ${String(actualOppCount)}).`,
          );
        }

        // 4. Mark scan_run as SUCCEEDED
        this.db
          .prepare(
            `UPDATE scan_runs
             SET completed_at = ?,
                 status = 'SUCCEEDED',
                 valid_observations = ?,
                 duplicate_records = duplicate_records + ?,
                 opportunities_created = ?
             WHERE scan_run_id = ?`,
          )
          .run(
            new Date().toISOString(),
            actualObsCount,
            observationsSkippedDuplicate,
            actualOppCount,
            context.scanRunId,
          );
      });

      if (earlyScanRunResult) {
        return earlyScanRunResult;
      }

      return {
        persisted: true,
        reason: "PERSISTED_COMMITTED",
        scanRunId: context.scanRunId,
        observationsInserted,
        observationsSkippedDuplicate,
        opportunitiesInserted,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        persisted: false,
        reason: "TRANSACTION_FAILED",
        scanRunId: context.scanRunId,
        observationsInserted: 0,
        observationsSkippedDuplicate: 0,
        opportunitiesInserted: 0,
        errorSummary: errorMessage,
      };
    }
  }

  /**
   * Explicit, separate auditable operation to reevaluate the chronologically latest active observation
   * for a listing (or all listings) after out-of-order historical backfills or manual superseding (`F-P2-06`, `F-P2-08`, `Round 3 Additional Check`).
   *
   * - Preserves immutable `scan_runs.opportunities_created` counters by tagging recalculated opportunities
   *   with `event_origin = 'HISTORICAL_REEVALUATION'` and recording a `reevaluation_runs` audit row.
   * - Supersedes any currently `ACTIVE` opportunity whose baseline metrics or eligibility have become stale
   *   after historical observations were superseded or corrected.
   */
  public reevaluateLatestListingOpportunities(options?: {
    readonly listingKey?: string;
    readonly intelligenceConfig?: PriceIntelligenceConfig;
    readonly evaluationTimeIso?: string;
    readonly reevaluationRunId?: string;
  }): ReevaluateLatestOpportunitiesResult {
    const intelligenceConfig =
      options?.intelligenceConfig ?? PRIVATE_HISTORY_INTELLIGENCE_CONFIG;
    const evaluationTimeIso = options?.evaluationTimeIso ?? new Date().toISOString();
    const reevaluationRunId =
      options?.reevaluationRunId ??
      `reeval::${evaluationTimeIso}::${crypto.randomUUID().slice(0, 8)}`;

    let listingsEvaluated = 0;
    let opportunitiesInserted = 0;
    let opportunitiesSuperseded = 0;

    this.withImmediateTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO reevaluation_runs (
            reevaluation_run_id,
            executed_at,
            target_listing_key,
            listings_evaluated,
            opportunities_inserted,
            opportunities_superseded
          ) VALUES (?, ?, ?, 0, 0, 0)`,
        )
        .run(reevaluationRunId, evaluationTimeIso, options?.listingKey ?? null);

      const distinctGroups = (
        options?.listingKey
          ? this.db
              .prepare(
                `SELECT DISTINCT listing_key, provenance
                 FROM price_observations
                 WHERE is_superseded = 0 AND listing_key = ?`,
              )
              .all(options.listingKey)
          : this.db
              .prepare(
                `SELECT DISTINCT listing_key, provenance
                 FROM price_observations
                 WHERE is_superseded = 0`,
              )
              .all()
      ) as Array<{
        listing_key: string;
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
      }>;

      const latestObsStmt = this.db.prepare(
        `SELECT
          o.observation_id,
          o.listing_key,
          o.scan_run_id,
          o.product_variant_key,
          o.store_key,
          o.fulfillment_context_id,
          o.city_slug,
          o.observed_price_cop,
          o.declared_reference_price_cop,
          o.availability,
          o.observed_at,
          o.provenance,
          o.geographic_verification_verdict,
          p.provider_id,
          p.external_product_id,
          p.external_variant_id,
          p.product_name,
          p.brand,
          p.category_slug,
          p.packaging_label,
          p.unit_quantity,
          p.unit_type,
          p.canonical_product_url,
          s.external_store_id,
          s.store_name
        FROM price_observations o
        JOIN products p ON p.product_variant_key = o.product_variant_key
        JOIN stores s ON s.store_key = o.store_key
        WHERE o.listing_key = ? AND o.provenance = ? AND o.is_superseded = 0
        ORDER BY o.observed_at DESC, o.observation_id DESC
        LIMIT 1`,
      );

      const activeOppsForGroupStmt = this.db.prepare(
        `SELECT opportunity_id, opportunity_type, deduplication_key
         FROM opportunity_events
         WHERE listing_key = ? AND provenance = ? AND lifecycle_status = 'ACTIVE'`,
      );

      const supersedeByIdStmt = this.db.prepare(
        `UPDATE opportunity_events
         SET lifecycle_status = 'SUPERSEDED'
         WHERE opportunity_id = ? AND lifecycle_status = 'ACTIVE'`,
      );

      const insertOpportunityStmt = this.db.prepare(
        `INSERT INTO opportunity_events (
          opportunity_id,
          deduplication_key,
          listing_key,
          observation_id,
          scan_run_id,
          event_origin,
          reevaluation_run_id,
          product_variant_key,
          store_key,
          fulfillment_context_id,
          opportunity_type,
          label_es_co,
          baseline_price_cop,
          previous_price_cop,
          observed_price_cop,
          savings_cop,
          discount_basis_points,
          discount_percentage,
          historical_observation_count,
          historical_low_cop,
          historical_median_cop,
          confidence,
          requires_verification,
          provenance,
          geographic_verification_verdict,
          rationale_es_co,
          detected_at,
          lifecycle_status
        ) VALUES (?, ?, ?, ?, ?, 'HISTORICAL_REEVALUATION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
        ON CONFLICT(deduplication_key) DO NOTHING`,
      );

      for (const group of distinctGroups) {
        const latest = latestObsStmt.get(group.listing_key, group.provenance) as
          | {
              observation_id: string;
              listing_key: string;
              scan_run_id: string;
              product_variant_key: string;
              store_key: string;
              fulfillment_context_id: string;
              city_slug: string;
              observed_price_cop: number;
              declared_reference_price_cop: number | null;
              availability: AvailabilityStatus;
              observed_at: string;
              provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
              geographic_verification_verdict: GeographicVerificationVerdictType;
              provider_id: string;
              external_product_id: string;
              external_variant_id: string;
              product_name: string;
              brand: string | null;
              category_slug: string;
              packaging_label: string;
              unit_quantity: number;
              unit_type: "g" | "ml" | "unit" | "kg" | "l";
              canonical_product_url: string;
              external_store_id: string;
              store_name: string;
            }
          | undefined;

        if (!latest) continue;
        listingsEvaluated += 1;

        const allHistory = this.getPersistedHistoryForListing(
          latest.listing_key,
          latest.provenance,
        );

        const synthesizedListing: DiscoveredListing = {
          providerId: latest.provider_id,
          store: {
            providerId: latest.provider_id,
            externalStoreId: latest.external_store_id,
            name: latest.store_name,
            categorySlug: latest.category_slug,
          },
          variant: {
            externalProductId: latest.external_product_id,
            externalVariantId: latest.external_variant_id,
            name: latest.product_name,
            brand: latest.brand ?? "Sin marca especificada",
            categorySlug: latest.category_slug,
            categoryName: latest.category_slug,
            packagingLabel: latest.packaging_label,
            unitQuantity: latest.unit_quantity,
            unitType: latest.unit_type,
            productUrl: latest.canonical_product_url,
          },
          geographicContext: {
            countryCode: "CO",
            citySlug: latest.city_slug,
            cityName: latest.city_slug,
            zoneCode: latest.fulfillment_context_id,
          },
          observedPriceCop: createCopAmount(latest.observed_price_cop),
          ...(latest.declared_reference_price_cop !== null
            ? {
                declaredReferencePriceCop: createCopAmount(
                  latest.declared_reference_price_cop,
                ),
              }
            : {}),
          availability: latest.availability,
          provenance: latest.provenance,
          sourceObservedAt: latest.observed_at,
        };

        // Compute ground-truth candidates against current non-superseded history without cooldown suppression
        const candidates = evaluateListingOpportunities({
          listing: synthesizedListing,
          historicalObservations: allHistory,
          existingOpportunities: [],
          config: intelligenceConfig,
          evaluationTimeIso,
        });

        const recalculatedDedupKeys = new Set<string>();
        const candidatesWithKeys = candidates.map((opp) => {
          const deduplicationKey = buildOpportunityDeduplicationKey(
            opp,
            latest.observation_id,
          );
          recalculatedDedupKeys.add(deduplicationKey);
          return { opp, deduplicationKey };
        });

        const currentlyActiveRows = activeOppsForGroupStmt.all(
          latest.listing_key,
          latest.provenance,
        ) as Array<{
          opportunity_id: string;
          opportunity_type: OpportunityType;
          deduplication_key: string;
        }>;

        const alreadyActiveDedupKeys = new Set<string>();
        for (const activeRow of currentlyActiveRows) {
          if (recalculatedDedupKeys.has(activeRow.deduplication_key)) {
            alreadyActiveDedupKeys.add(activeRow.deduplication_key);
          } else {
            // Stale baseline or invalidated opportunity -> supersede explicitly
            const supRes = supersedeByIdStmt.run(activeRow.opportunity_id);
            opportunitiesSuperseded += Number(supRes.changes);
          }
        }

        for (const { opp, deduplicationKey } of candidatesWithKeys) {
          if (alreadyActiveDedupKeys.has(deduplicationKey)) {
            continue;
          }
          const opportunityId = `opp::${reevaluationRunId}::${latest.observation_id}::${opp.opportunityKey}`;
          const oppResult = insertOpportunityStmt.run(
            opportunityId,
            deduplicationKey,
            latest.listing_key,
            latest.observation_id,
            latest.scan_run_id,
            reevaluationRunId,
            latest.product_variant_key,
            latest.store_key,
            latest.fulfillment_context_id,
            opp.type,
            opp.labelEsCo,
            opp.baselinePriceCop,
            opp.previousPriceCop ?? null,
            opp.observedPriceCop,
            opp.savingsCop,
            opp.discountBasisPoints,
            opp.discountPercentage,
            opp.historicalObservationCount,
            opp.historicalLowCop,
            opp.historicalMedianCop,
            opp.confidence,
            opp.requiresVerification ? 1 : 0,
            latest.provenance,
            latest.geographic_verification_verdict,
            opp.rationaleEsCo,
            opp.detectedAt,
          );

          if (Number(oppResult.changes) > 0) {
            opportunitiesInserted += 1;
          }
        }
      }

      this.db
        .prepare(
          `UPDATE reevaluation_runs
           SET listings_evaluated = ?,
               opportunities_inserted = ?,
               opportunities_superseded = ?
           WHERE reevaluation_run_id = ?`,
        )
        .run(
          listingsEvaluated,
          opportunitiesInserted,
          opportunitiesSuperseded,
          reevaluationRunId,
        );
    });

    return {
      reevaluationRunId,
      listingsEvaluated,
      opportunitiesInserted,
      opportunitiesSuperseded,
    };
  }

  /**
   * Marks a historical observation as superseded (for historical data corrections without destructive deletion, `Section 9`).
   */
  public markObservationSuperseded(observationId: string, reason: string): boolean {
    return this.withImmediateTransaction(() => {
      const res = this.db
        .prepare(
          `UPDATE price_observations
           SET is_superseded = 1, superseded_reason = ?
           WHERE observation_id = ? AND is_superseded = 0`,
        )
        .run(reason, observationId);
      if (Number(res.changes) > 0) {
        this.db
          .prepare(
            `UPDATE opportunity_events
             SET lifecycle_status = 'SUPERSEDED'
             WHERE observation_id = ? AND lifecycle_status = 'ACTIVE'`,
          )
          .run(observationId);
        return true;
      }
      return false;
    });
  }

  public getDatabaseStatus(): PrivateDatabaseStatusSummary {
    const isInMemory = this.dbPath === ":memory:";
    const existsOnDisk = !isInMemory && fs.existsSync(this.dbPath);
    let directoryModeOctal: string | undefined;
    let fileModeOctal: string | undefined;

    if (existsOnDisk) {
      const dirStat = fs.statSync(path.dirname(this.dbPath));
      const fileStat = fs.statSync(this.dbPath);
      directoryModeOctal = `0${(dirStat.mode & 0o777).toString(8)}`;
      fileModeOctal = `0${(fileStat.mode & 0o777).toString(8)}`;
    }

    const versionRow = this.db
      .prepare("SELECT MAX(version) as v FROM schema_migrations")
      .get() as { v: number | null } | undefined;

    const countTable = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { c: number } | undefined;
      return Number(row?.c ?? 0);
    };

    return {
      dbFilePath: this.dbPath,
      isInMemory,
      existsOnDisk,
      ...(directoryModeOctal !== undefined ? { directoryModeOctal } : {}),
      ...(fileModeOctal !== undefined ? { fileModeOctal } : {}),
      schemaVersion: Number(versionRow?.v ?? 0),
      counts: {
        stores: countTable("SELECT COUNT(*) as c FROM stores"),
        products: countTable("SELECT COUNT(*) as c FROM products"),
        fulfillmentContexts: countTable("SELECT COUNT(*) as c FROM fulfillment_contexts"),
        scanRuns: countTable("SELECT COUNT(*) as c FROM scan_runs"),
        activeObservations: countTable(
          "SELECT COUNT(*) as c FROM price_observations WHERE is_superseded = 0",
        ),
        supersededObservations: countTable(
          "SELECT COUNT(*) as c FROM price_observations WHERE is_superseded = 1",
        ),
        activeOpportunities: countTable(
          "SELECT COUNT(*) as c FROM opportunity_events WHERE lifecycle_status = 'ACTIVE'",
        ),
      },
    };
  }

  public listRecentScanRuns(limit = 20): readonly PersistedScanRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT
          scan_run_id,
          started_at,
          completed_at,
          status,
          provider_id,
          store_key,
          fulfillment_context_id,
          candidates_discovered,
          valid_observations,
          skipped_records,
          duplicate_records,
          opportunities_created,
          error_category,
          error_summary
        FROM scan_runs
        ORDER BY started_at DESC, scan_run_id DESC
        LIMIT ?`,
      )
      .all(Math.max(1, limit)) as Array<{
      scan_run_id: string;
      started_at: string;
      completed_at: string | null;
      status: PersistedScanRunRow["status"];
      provider_id: string;
      store_key: string | null;
      fulfillment_context_id: string | null;
      candidates_discovered: number;
      valid_observations: number;
      skipped_records: number;
      duplicate_records: number;
      opportunities_created: number;
      error_category: string | null;
      error_summary: string | null;
    }>;

    return rows.map((r) => ({
      scanRunId: r.scan_run_id,
      startedAt: r.started_at,
      ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
      status: r.status,
      providerId: r.provider_id,
      ...(r.store_key !== null ? { storeKey: r.store_key } : {}),
      ...(r.fulfillment_context_id !== null
        ? { fulfillmentContextId: r.fulfillment_context_id }
        : {}),
      candidatesDiscovered: r.candidates_discovered,
      validObservations: r.valid_observations,
      skippedRecords: r.skipped_records,
      duplicateRecords: r.duplicate_records,
      opportunitiesCreated: r.opportunities_created,
      ...(r.error_category !== null ? { errorCategory: r.error_category } : {}),
      ...(r.error_summary !== null ? { errorSummary: r.error_summary } : {}),
    }));
  }

  public getProductPriceHistory(
    productQuery: string,
  ): readonly PersistedProductObservationHistoryRow[] {
    const trimmed = productQuery.trim();
    if (!trimmed) return [];

    const likePattern = `%${trimmed}%`;
    const rows = this.db
      .prepare(
        `SELECT
          o.observation_id,
          o.listing_key,
          o.scan_run_id,
          p.provider_id,
          s.external_store_id,
          s.store_name,
          p.external_product_id,
          p.external_variant_id,
          p.product_name,
          p.brand,
          p.packaging_label,
          p.unit_quantity,
          p.unit_type,
          p.canonical_product_url,
          o.fulfillment_context_id,
          o.city_slug,
          o.observed_price_cop,
          o.declared_reference_price_cop,
          o.availability,
          o.observed_at,
          o.provenance,
          o.geographic_verification_verdict,
          o.serving_branch_evidence,
          o.catalog_context_evidence,
          o.address_specific_pricing_verified,
          o.is_superseded
        FROM price_observations o
        JOIN products p ON p.product_variant_key = o.product_variant_key
        JOIN stores s ON s.store_key = o.store_key
        WHERE o.is_superseded = 0
          AND (
            p.external_product_id = ?
            OR p.external_variant_id = ?
            OR o.listing_key = ?
            OR p.product_name LIKE ?
          )
        ORDER BY o.observed_at ASC, o.observation_id ASC`,
      )
      .all(trimmed, trimmed, trimmed, likePattern) as Array<{
      observation_id: string;
      listing_key: string;
      scan_run_id: string;
      provider_id: string;
      external_store_id: string;
      store_name: string;
      external_product_id: string;
      external_variant_id: string;
      product_name: string;
      brand: string | null;
      packaging_label: string;
      unit_quantity: number;
      unit_type: "g" | "ml" | "unit" | "kg" | "l";
      canonical_product_url: string;
      fulfillment_context_id: string;
      city_slug: string;
      observed_price_cop: number;
      declared_reference_price_cop: number | null;
      availability: AvailabilityStatus;
      observed_at: string;
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
      geographic_verification_verdict: GeographicVerificationVerdictType;
      serving_branch_evidence: string;
      catalog_context_evidence: string;
      address_specific_pricing_verified: number;
      is_superseded: number;
    }>;

    return rows.map((r) => ({
      observationId: r.observation_id,
      listingKey: r.listing_key,
      scanRunId: r.scan_run_id,
      providerId: r.provider_id,
      externalStoreId: r.external_store_id,
      storeName: r.store_name,
      externalProductId: r.external_product_id,
      externalVariantId: r.external_variant_id,
      productName: r.product_name,
      ...(r.brand !== null ? { brand: r.brand } : {}),
      packagingLabel: r.packaging_label,
      unitQuantity: r.unit_quantity,
      unitType: r.unit_type,
      canonicalProductUrl: r.canonical_product_url,
      fulfillmentContextId: r.fulfillment_context_id,
      citySlug: r.city_slug,
      observedPriceCop: createCopAmount(r.observed_price_cop),
      ...(r.declared_reference_price_cop !== null
        ? { declaredReferencePriceCop: createCopAmount(r.declared_reference_price_cop) }
        : {}),
      availability: r.availability,
      observedAt: r.observed_at,
      provenance: r.provenance,
      geographicVerificationVerdict: r.geographic_verification_verdict,
      servingBranchEvidence: r.serving_branch_evidence,
      catalogContextEvidence: r.catalog_context_evidence,
      addressSpecificPricingVerified: r.address_specific_pricing_verified === 1,
      isSuperseded: r.is_superseded === 1,
    }));
  }

  public listDetectedOpportunities(options?: {
    readonly types?: readonly OpportunityType[];
    readonly lifecycleStatus?: OpportunityLifecycleStatus;
    readonly limit?: number;
  }): readonly PersistedOpportunityEventRow[] {
    const status = options?.lifecycleStatus ?? "ACTIVE";
    const limit = Math.max(1, options?.limit ?? 50);
    const types = options?.types;

    const baseSelect = `
      SELECT
        e.opportunity_id,
        e.deduplication_key,
        e.listing_key,
        e.observation_id,
        e.scan_run_id,
        s.external_store_id,
        s.store_name,
        p.external_product_id,
        p.external_variant_id,
        p.product_name,
        p.packaging_label,
        e.fulfillment_context_id,
        e.opportunity_type,
        e.label_es_co,
        e.baseline_price_cop,
        e.previous_price_cop,
        e.observed_price_cop,
        e.savings_cop,
        e.discount_basis_points,
        e.discount_percentage,
        e.historical_observation_count,
        e.historical_low_cop,
        e.historical_median_cop,
        e.confidence,
        e.requires_verification,
        e.provenance,
        e.geographic_verification_verdict,
        e.rationale_es_co,
        e.detected_at,
        e.lifecycle_status,
        e.event_origin,
        e.reevaluation_run_id
      FROM opportunity_events e
      JOIN products p ON p.product_variant_key = e.product_variant_key
      JOIN stores s ON s.store_key = e.store_key
    `;

    const rows = (
      types && types.length > 0
        ? this.db
            .prepare(
              `${baseSelect}
               WHERE e.lifecycle_status = ?
                 AND e.opportunity_type IN (${types.map(() => "?").join(", ")})
               ORDER BY e.discount_basis_points DESC, e.detected_at DESC
               LIMIT ?`,
            )
            .all(status, ...types, limit)
        : this.db
            .prepare(
              `${baseSelect}
               WHERE e.lifecycle_status = ?
               ORDER BY e.discount_basis_points DESC, e.detected_at DESC
               LIMIT ?`,
            )
            .all(status, limit)
    ) as Array<{
      opportunity_id: string;
      deduplication_key: string;
      listing_key: string;
      observation_id: string;
      scan_run_id: string;
      external_store_id: string;
      store_name: string;
      external_product_id: string;
      external_variant_id: string;
      product_name: string;
      packaging_label: string;
      fulfillment_context_id: string;
      opportunity_type: OpportunityType;
      label_es_co: string;
      baseline_price_cop: number;
      previous_price_cop: number | null;
      observed_price_cop: number;
      savings_cop: number;
      discount_basis_points: number;
      discount_percentage: number;
      historical_observation_count: number;
      historical_low_cop: number;
      historical_median_cop: number;
      confidence: ConfidenceLevel;
      requires_verification: number;
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
      geographic_verification_verdict: GeographicVerificationVerdictType;
      rationale_es_co: string;
      detected_at: string;
      lifecycle_status: OpportunityLifecycleStatus;
      event_origin: OpportunityEventOrigin;
      reevaluation_run_id: string | null;
    }>;

    return rows.map((r) => ({
      opportunityId: r.opportunity_id,
      deduplicationKey: r.deduplication_key,
      listingKey: r.listing_key,
      observationId: r.observation_id,
      scanRunId: r.scan_run_id,
      externalStoreId: r.external_store_id,
      storeName: r.store_name,
      externalProductId: r.external_product_id,
      externalVariantId: r.external_variant_id,
      productName: r.product_name,
      packagingLabel: r.packaging_label,
      fulfillmentContextId: r.fulfillment_context_id,
      opportunityType: r.opportunity_type,
      labelEsCo: r.label_es_co,
      baselinePriceCop: createCopAmount(r.baseline_price_cop),
      ...(r.previous_price_cop !== null
        ? { previousPriceCop: createCopAmount(r.previous_price_cop) }
        : {}),
      observedPriceCop: createCopAmount(r.observed_price_cop),
      savingsCop: createCopAmount(r.savings_cop),
      discountBasisPoints: r.discount_basis_points,
      discountPercentage: r.discount_percentage,
      historicalObservationCount: r.historical_observation_count,
      historicalLowCop: createCopAmount(r.historical_low_cop),
      historicalMedianCop: createCopAmount(r.historical_median_cop),
      confidence: r.confidence,
      requiresVerification: r.requires_verification === 1,
      provenance: r.provenance,
      geographicVerificationVerdict: r.geographic_verification_verdict,
      rationaleEsCo: r.rationale_es_co,
      detectedAt: r.detected_at,
      lifecycleStatus: r.lifecycle_status,
      eventOrigin: r.event_origin,
      ...(r.reevaluation_run_id !== null
        ? { reevaluationRunId: r.reevaluation_run_id }
        : {}),
    }));
  }
}
