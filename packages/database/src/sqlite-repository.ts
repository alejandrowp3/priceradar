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
  SourceViewDescriptor,
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

/**
 * Legacy catch-all patterns, still applied to unclassified free-text fields
 * (`assertNoSensitiveTextInPersistedString`). Product names, packaging labels and URLs use the
 * field-aware rules below, because words such as "Casa", "Torre", "Bloque" or "Manzana"
 * followed by a quantity are legitimate grocery labels ("Manzana 6 unidades").
 */
const FORBIDDEN_PII_OR_CREDENTIAL_PATTERNS = [
  /\b(?:calle|carrera|diagonal|transversal|avenida|autopista|circular)\s+\d+/i,
  /\b(?:apto|apartamento|interior|torre|bloque|manzana|casa)\s*#?\s*\d+/i,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
  /\b(?:\+?57[\s-]?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/,
  /\bbearer\s+[a-z0-9._~+/-]+=*/i,
  /\b(?:session_id|access_token|refresh_token|cf_clearance|__cf_bm)\s*=/i,
];

/** Field classes with distinct privacy semantics (`P2 hotfix`). */
export type PersistedFieldClass =
  /** Unclassified text that might hold a delivery address or personal data: strictest rules. */
  | "FREE_TEXT"
  /** Product name, brand, packaging label, store name: may legitimately contain casa/torre/bloque/manzana + number. */
  | "PRODUCT_LABEL"
  /** Canonical product URL: digits are legitimate; query strings must not carry auth material. */
  | "PRODUCT_URL"
  /** Strict provider/store/product/variant identifier. */
  | "STRICT_ID"
  /** Opaque fulfillment-context identifier (`ctx-<16 hex>`). */
  | "OPAQUE_CONTEXT_ID"
  /** City slug. */
  | "SLUG";

export class PrivacyViolationError extends Error {
  public readonly fieldName: string;
  public readonly fieldClass: PersistedFieldClass;
  public readonly ruleId: string;
  public readonly subject: string | undefined;

  public constructor(
    fieldName: string,
    fieldClass: PersistedFieldClass,
    ruleId: string,
    subject?: string,
  ) {
    // Never include the matched substring: only field, class, rule id and an opaque subject.
    super(
      `Privacy violation prevented: field '${fieldName}' matched forbidden PII or credential pattern (rule=${ruleId}, class=${fieldClass}${subject !== undefined ? `, subject=${subject}` : ""}).`,
    );
    this.name = "PrivacyViolationError";
    this.fieldName = fieldName;
    this.fieldClass = fieldClass;
    this.ruleId = ruleId;
    this.subject = subject;
  }
}

interface PrivacyRule {
  readonly id: string;
  readonly test: (value: string) => boolean;
}

const STREET_DESIGNATOR =
  "(?:calle|cll|cl|carrera|cra|cr|kra|diagonal|diag|dg|transversal|tv|avenida|av|autopista|circular)";
const UNIT_DESIGNATOR_WITH_NUMBER =
  /\b(torre|bloque|manzana|casa|interior|apto|apartamento)\.?\s*#?\s*\d+/gi;

/** Authentication / session material: must never be persisted in ANY field. */
const AUTH_MATERIAL_RULES: readonly PrivacyRule[] = [
  { id: "AUTH_BEARER_TOKEN", test: (v) => /\bbearer\s+[a-z0-9._~+/-]+=*/i.test(v) },
  {
    id: "AUTH_SESSION_ASSIGNMENT",
    test: (v) =>
      /\b(?:session_?id|access_token|refresh_token|id_token|cf_clearance|__cf_bm)\s*=/i.test(
        v,
      ),
  },
  {
    id: "AUTH_JWT",
    test: (v) => /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/.test(v),
  },
];

const EMAIL_RULE: PrivacyRule = {
  id: "PII_EMAIL",
  test: (v) => /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.test(v),
};

const PHONE_RULE: PrivacyRule = {
  id: "PII_PHONE",
  test: (v) => /\b(?:\+?57[\s-]?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/.test(v),
};

const LONG_SECRET_RULE: PrivacyRule = {
  id: "AUTH_LONG_OPAQUE_SECRET",
  test: (v) =>
    /(?=[A-Za-z0-9+/_=]*\d)(?=[A-Za-z0-9+/_=]*[A-Za-z])[A-Za-z0-9+/_=]{40,}/.test(v),
};

/** Plausible full address / unit designation for product labels (not bare "Casa 12"). */
const LABEL_ADDRESS_RULES: readonly PrivacyRule[] = [
  {
    id: "ADDRESS_STREET_COMPLETE",
    test: (v) =>
      new RegExp(
        `\\b${STREET_DESIGNATOR}\\.?\\s*\\d+\\s*[a-z]?(?:\\s*(?:bis|sur|norte|este|oeste))?\\s*(?:(?:#|no\\.?|nro\\.?|n°|nº)\\s*\\d+|\\d+\\s*-\\s*\\d+)`,
        "i",
      ).test(v),
  },
  {
    id: "ADDRESS_STREET_CROSS",
    test: (v) =>
      new RegExp(
        `\\b${STREET_DESIGNATOR}\\.?\\s*\\d+\\s*[a-z]?\\s+(?:con|entre|esq\\.?)\\s+${STREET_DESIGNATOR}\\.?\\s*\\d+`,
        "i",
      ).test(v),
  },
  {
    id: "ADDRESS_APARTMENT_UNIT",
    test: (v) => /\b(?:apto|apartamento|apt)\.?\s*#?\s*\d+/i.test(v),
  },
  {
    id: "ADDRESS_MULTIPLE_UNIT_DESIGNATORS",
    test: (v) => {
      const seen = new Set<string>();
      for (const match of v.matchAll(UNIT_DESIGNATOR_WITH_NUMBER)) {
        seen.add((match[1] ?? "").toLowerCase());
      }
      return seen.size >= 2;
    },
  },
];

const STRICT_ID_REGEX = /^[\p{L}\p{N}][\p{L}\p{N}._:~-]{0,199}$/u;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SENSITIVE_QUERY_PARAM_REGEX =
  /(?:token|session|sess|auth|cookie|secret|passw|pwd|jwt|bearer|credential|api[_-]?key|sid|signature)/i;

function firstViolatedRule(
  value: string,
  rules: readonly PrivacyRule[],
): string | undefined {
  return rules.find((rule) => rule.test(value))?.id;
}

function classifyViolation(
  value: string,
  fieldClass: PersistedFieldClass,
): string | undefined {
  switch (fieldClass) {
    case "OPAQUE_CONTEXT_ID":
      return OPAQUE_CONTEXT_ID_REGEX.test(value) ? undefined : "CONTEXT_ID_NOT_OPAQUE";
    case "SLUG":
      return (
        firstViolatedRule(value, [...AUTH_MATERIAL_RULES, EMAIL_RULE]) ??
        (SLUG_REGEX.test(value) && value.length <= 64 ? undefined : "SLUG_INVALID_FORMAT")
      );
    case "STRICT_ID":
      return (
        firstViolatedRule(value, [...AUTH_MATERIAL_RULES, EMAIL_RULE]) ??
        (STRICT_ID_REGEX.test(value) ? undefined : "ID_INVALID_FORMAT")
      );
    case "PRODUCT_URL": {
      let parsed: URL;
      try {
        parsed = new URL(value, "https://www.rappi.com.co");
      } catch {
        return "URL_MALFORMED";
      }
      if (parsed.protocol !== "https:") return "URL_NOT_HTTPS";
      if (parsed.username !== "" || parsed.password !== "")
        return "URL_EMBEDDED_CREDENTIALS";
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // keep raw value for scanning
      }
      const credentialRule = firstViolatedRule(decoded, [
        ...AUTH_MATERIAL_RULES,
        EMAIL_RULE,
      ]);
      if (credentialRule) return credentialRule;
      for (const key of parsed.searchParams.keys()) {
        if (SENSITIVE_QUERY_PARAM_REGEX.test(key)) return "URL_SENSITIVE_QUERY_PARAMETER";
      }
      return undefined;
    }
    case "PRODUCT_LABEL":
      return firstViolatedRule(value, [
        ...AUTH_MATERIAL_RULES,
        LONG_SECRET_RULE,
        EMAIL_RULE,
        PHONE_RULE,
        ...LABEL_ADDRESS_RULES,
      ]);
    case "FREE_TEXT": {
      const legacy = FORBIDDEN_PII_OR_CREDENTIAL_PATTERNS.findIndex((p) => p.test(value));
      return (
        firstViolatedRule(value, [...AUTH_MATERIAL_RULES, LONG_SECRET_RULE]) ??
        (legacy >= 0 ? `LEGACY_FREE_TEXT_PATTERN_${String(legacy + 1)}` : undefined)
      );
    }
  }
}

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
  readonly sourceView?: SourceViewDescriptor;
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
  readonly newProductsCount: number;
  readonly previouslyKnownProductsCount: number;
  readonly priceDecreasesCount: number;
  readonly priceIncreasesCount: number;
  readonly unchangedPricesCount: number;
  readonly firstObservationsCount: number;
  readonly candidateOpportunitiesCount: number;
  readonly sourceView?: SourceViewDescriptor;
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
  readonly newProductsDiscovered?: number;
  readonly existingProductsObserved?: number;
  readonly sourceView?: SourceViewDescriptor;
  readonly errorSummary?: string;
}

export interface ReevaluateLatestOpportunitiesResult {
  readonly reevaluationRunId: string;
  readonly listingsEvaluated: number;
  readonly opportunitiesInserted: number;
  readonly opportunitiesSuperseded: number;
  /** Previously SUPERSEDED events restored to ACTIVE because their exact baseline became valid again (`F-P2-09`). */
  readonly opportunitiesReactivated: number;
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
  readonly sourceViewKey?: string;
  readonly sourceViewKind?: string;
  readonly sourceViewLabel?: string;
  readonly newProductsDiscovered?: number;
  readonly existingProductsObserved?: number;
  readonly errorCategory?: string;
  readonly errorSummary?: string;
}

export interface CatalogCoverageViewSummary {
  readonly viewKey: string;
  readonly pageKind: string;
  readonly ownerLabel?: string;
  readonly lastObservedAt: string;
  readonly scanRunsCount: number;
  readonly distinctProductsCount: number;
  readonly totalObservationsCount: number;
}

export interface CatalogCoverageCategorySummary {
  readonly categorySlug: string;
  readonly distinctProductsCount: number;
  readonly distinctVariantsCount: number;
  readonly activeObservationsCount: number;
  readonly lastSeenAt: string;
}

export interface CatalogCoverageReport {
  readonly totalDistinctProducts: number;
  readonly totalDistinctVariants: number;
  readonly totalActiveObservations: number;
  readonly totalScanRuns: number;
  readonly totalInspectedViews: number;
  readonly latestScanRun?: {
    readonly scanRunId: string;
    readonly observedAt: string;
    readonly viewKey?: string;
    readonly viewKind?: string;
    readonly viewLabel?: string;
    readonly validObservations: number;
    readonly duplicateRecordsSuppressed: number;
    readonly newProductsDiscovered: number;
    readonly existingProductsObserved: number;
  };
  readonly views: readonly CatalogCoverageViewSummary[];
  readonly categories: readonly CatalogCoverageCategorySummary[];
  readonly staleProductsCount: number;
  readonly staleThresholdDays: number;
  readonly newestProductsSample: readonly {
    readonly productId: string;
    readonly productName: string;
    readonly categorySlug: string;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
  }[];
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
 * Builds a diagnostic subject for privacy failures: the product index plus the external product
 * id only when it is itself strictly well-formed (so no sensitive text can leak through the id).
 */
function buildOpaqueProductSubject(index: number, externalProductId: string): string {
  const base = `product-index=${String(index)}`;
  return STRICT_ID_REGEX.test(externalProductId) &&
    !firstViolatedRule(externalProductId, [...AUTH_MATERIAL_RULES, EMAIL_RULE])
    ? `${base},product-id=${externalProductId}`
    : base;
}

/**
 * Verifies that a string about to be written to the private SQLite database
 * does not contain raw street addresses, apartment numbers, emails, phone numbers,
 * bearer tokens, or session cookies (`Section 5 & Section 14`).
 *
 * Unclassified fields are treated as `FREE_TEXT` (strictest legacy behavior).
 * Use `assertPersistedFieldSafe` for field-aware validation.
 */
export function assertNoSensitiveTextInPersistedString(
  value: string | undefined,
  fieldName: string,
): void {
  assertPersistedFieldSafe(value, fieldName, "FREE_TEXT");
}

/**
 * Field-aware privacy validation. Throws `PrivacyViolationError` carrying only the field name,
 * field class, rule identifier and an optional opaque subject — never the matched text.
 */
export function assertPersistedFieldSafe(
  value: string | undefined,
  fieldName: string,
  fieldClass: PersistedFieldClass,
  subject?: string,
): void {
  if (!value) return;
  const ruleId = classifyViolation(value, fieldClass);
  if (ruleId !== undefined) {
    throw new PrivacyViolationError(fieldName, fieldClass, ruleId, subject);
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

/**
 * Schema v1 DDL, kept byte-identical to the pre-v2 commit (690e217) so authentic v1 databases
 * are recognized. v2 artifacts are applied separately by `applySchemaV2()` (`F-P2-10`).
 */
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

CREATE TABLE IF NOT EXISTS opportunity_events (
  opportunity_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  listing_key TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES price_observations(observation_id) ON DELETE CASCADE,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(scan_run_id) ON DELETE CASCADE,
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
function createPresentationOpportunityId(rawOpportunityId: string): string {
  return `opp-${crypto.createHash("sha256").update(rawOpportunityId).digest("hex").slice(0, 16)}`;
}

export class SqlitePrivateHistoryRepository {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly isReadOnly: boolean;
  private isClosed = false;

  public constructor(
    dbPath: string = DEFAULT_PRIVATE_SQLITE_DB_PATH,
    options?: {
      /** Opens the database connection in read-only mode (PRAGMA query_only = ON; zero file writes/migrations). */
      readonly readOnly?: boolean;
      /** Test-only fault injection to verify atomic rollback of the v2 migration. */
      readonly simulateMigrationFailureAfterV2Step?: "ADD_COLUMNS";
    },
  ) {
    assertDatabasePathOutsideRepository(dbPath);
    this.dbPath = dbPath === ":memory:" ? ":memory:" : path.resolve(dbPath);
    this.isReadOnly = Boolean(options?.readOnly);

    if (this.isReadOnly) {
      if (this.dbPath !== ":memory:" && !fs.existsSync(this.dbPath)) {
        throw new Error(
          `Cannot open read-only database: file does not exist at '${this.dbPath}'.`,
        );
      }
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      this.db.exec("PRAGMA query_only = ON;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      return;
    }

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

    try {
      this.runMigrations(options?.simulateMigrationFailureAfterV2Step);
    } catch (err) {
      this.db.close();
      throw err;
    }
    enforcePrivateDatabaseFilePermissions(this.dbPath);
  }

  public getIsReadOnly(): boolean {
    return this.isReadOnly;
  }

  private assertWritable(operation: string): void {
    if (this.isReadOnly) {
      throw new Error(
        `Cannot perform '${operation}' on a read-only database repository connection.`,
      );
    }
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

  private runMigrations(simulateFailureAfterV2Step?: "ADD_COLUMNS"): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      // v1 DDL is idempotent (`IF NOT EXISTS`) and byte-identical to the pre-v2 schema.
      this.db.exec(MIGRATION_V1_SQL);

      const nowIso = new Date().toISOString();
      const recordMigration = (version: number, name: string): void => {
        const existing = this.db
          .prepare("SELECT version FROM schema_migrations WHERE version = ?")
          .get(version) as { version?: number } | undefined;
        if (!existing) {
          this.db
            .prepare(
              "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            )
            .run(version, name, nowIso);
        }
      };

      recordMigration(1, "001_initial_private_price_history_schema");
      this.applySchemaV2(simulateFailureAfterV2Step);
      recordMigration(2, "002_reevaluation_audit_and_event_origin");

      this.db.exec("COMMIT;");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback error if the transaction was already rolled back
      }
      throw err;
    }
  }

  /**
   * Applies schema v2 artifacts to a v1 (or partially migrated) database inside the caller's
   * transaction. Every step is guarded so that it is a no-op on an already-migrated database.
   */
  private applySchemaV2(simulateFailureAfterStep?: "ADD_COLUMNS"): void {
    const columnsOf = (table: string): Set<string> =>
      new Set(
        (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((col) => col.name),
      );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reevaluation_runs (
        reevaluation_run_id TEXT PRIMARY KEY,
        executed_at TEXT NOT NULL,
        target_listing_key TEXT,
        listings_evaluated INTEGER NOT NULL DEFAULT 0 CHECK (listings_evaluated >= 0),
        opportunities_inserted INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_inserted >= 0),
        opportunities_superseded INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_superseded >= 0),
        opportunities_reactivated INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_reactivated >= 0)
      );
    `);
    if (!columnsOf("reevaluation_runs").has("opportunities_reactivated")) {
      this.db.exec(
        "ALTER TABLE reevaluation_runs ADD COLUMN opportunities_reactivated INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_reactivated >= 0);",
      );
    }

    if (!columnsOf("scan_runs").has("batch_fingerprint")) {
      this.db.exec("ALTER TABLE scan_runs ADD COLUMN batch_fingerprint TEXT;");
    }
    if (!columnsOf("scan_runs").has("source_view_key")) {
      this.db.exec("ALTER TABLE scan_runs ADD COLUMN source_view_key TEXT;");
    }
    if (!columnsOf("scan_runs").has("source_view_kind")) {
      this.db.exec("ALTER TABLE scan_runs ADD COLUMN source_view_kind TEXT;");
    }
    if (!columnsOf("scan_runs").has("source_view_label")) {
      this.db.exec("ALTER TABLE scan_runs ADD COLUMN source_view_label TEXT;");
    }
    if (!columnsOf("scan_runs").has("new_products_discovered")) {
      this.db.exec(
        "ALTER TABLE scan_runs ADD COLUMN new_products_discovered INTEGER NOT NULL DEFAULT 0 CHECK (new_products_discovered >= 0);",
      );
    }
    if (!columnsOf("scan_runs").has("existing_products_observed")) {
      this.db.exec(
        "ALTER TABLE scan_runs ADD COLUMN existing_products_observed INTEGER NOT NULL DEFAULT 0 CHECK (existing_products_observed >= 0);",
      );
    }

    const oppColumns = columnsOf("opportunity_events");
    if (!oppColumns.has("event_origin")) {
      this.db.exec(
        "ALTER TABLE opportunity_events ADD COLUMN event_origin TEXT NOT NULL DEFAULT 'ORIGINAL_SCAN' CHECK (event_origin IN ('ORIGINAL_SCAN', 'HISTORICAL_REEVALUATION'));",
      );
    }
    if (!oppColumns.has("reevaluation_run_id")) {
      this.db.exec(
        "ALTER TABLE opportunity_events ADD COLUMN reevaluation_run_id TEXT REFERENCES reevaluation_runs(reevaluation_run_id);",
      );
    }

    if (simulateFailureAfterStep === "ADD_COLUMNS") {
      throw new Error("Simulated migration failure after v2 ADD_COLUMNS step.");
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_opportunity_events_scan_origin
        ON opportunity_events(scan_run_id, event_origin);

      CREATE TABLE IF NOT EXISTS opportunity_lifecycle_transitions (
        transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id TEXT NOT NULL REFERENCES opportunity_events(opportunity_id) ON DELETE CASCADE,
        from_status TEXT NOT NULL CHECK (from_status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'DISMISSED')),
        to_status TEXT NOT NULL CHECK (to_status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'DISMISSED')),
        reason TEXT NOT NULL,
        reevaluation_run_id TEXT REFERENCES reevaluation_runs(reevaluation_run_id),
        transitioned_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_opportunity_lifecycle_transitions_opportunity
        ON opportunity_lifecycle_transitions(opportunity_id, transition_id);

      CREATE TABLE IF NOT EXISTS scan_run_products (
        scan_run_id TEXT NOT NULL REFERENCES scan_runs(scan_run_id) ON DELETE CASCADE,
        product_variant_key TEXT NOT NULL REFERENCES products(product_variant_key),
        PRIMARY KEY (scan_run_id, product_variant_key)
      );

      CREATE INDEX IF NOT EXISTS idx_scan_run_products_product
        ON scan_run_products(product_variant_key);
    `);
  }

  public withImmediateTransaction<T>(fn: () => T): T {
    this.assertWritable("withImmediateTransaction");
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
        newProductsCount: 0,
        previouslyKnownProductsCount: 0,
        priceDecreasesCount: 0,
        priceIncreasesCount: 0,
        unchangedPricesCount: 0,
        firstObservationsCount: 0,
        candidateOpportunitiesCount: 0,
        ...(context.sourceView !== undefined ? { sourceView: context.sourceView } : {}),
        items: [],
      };
    }

    const effectiveProvenance = eligibility.effectiveProvenance;
    const contextHash = context.fulfillmentContextHash ?? "";
    const firstListing = context.listings[0];

    let newObservationsCount = 0;
    let alreadyPersistedDuplicateCount = 0;
    let newProductsCount = 0;
    let previouslyKnownProductsCount = 0;
    let priceDecreasesCount = 0;
    let priceIncreasesCount = 0;
    let unchangedPricesCount = 0;
    let firstObservationsCount = 0;
    let candidateOpportunitiesCount = 0;
    const items: BatchPreviewItem[] = [];

    const checkIdempotencyStmt = this.db.prepare(
      "SELECT 1 FROM price_observations WHERE idempotency_key = ? LIMIT 1",
    );
    const checkProductExistsStmt = this.db.prepare(
      "SELECT 1 FROM products WHERE product_variant_key = ? LIMIT 1",
    );
    const seenProductKeysInBatch = new Set<string>();

    for (const rawListing of context.listings) {
      const normalizedListing: DiscoveredListing = {
        ...rawListing,
        provenance: effectiveProvenance,
        geographicContext: {
          ...rawListing.geographicContext,
          zoneCode: contextHash,
        },
      };

      const productKey = `${normalizedListing.providerId}::${normalizedListing.variant.externalProductId}::${normalizedListing.variant.externalVariantId}`;
      if (!seenProductKeysInBatch.has(productKey)) {
        seenProductKeysInBatch.add(productKey);
        if (checkProductExistsStmt.get(productKey)) {
          previouslyKnownProductsCount += 1;
        } else {
          newProductsCount += 1;
        }
      }

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
      newProductsCount,
      previouslyKnownProductsCount,
      priceDecreasesCount,
      priceIncreasesCount,
      unchangedPricesCount,
      firstObservationsCount,
      candidateOpportunitiesCount,
      ...(context.sourceView !== undefined ? { sourceView: context.sourceView } : {}),
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

    this.assertWritable("persistApprovedInspectionBatch");

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

    assertPersistedFieldSafe(contextHash, "fulfillmentContextHash", "OPAQUE_CONTEXT_ID");
    assertPersistedFieldSafe(context.citySlug, "citySlug", "SLUG");
    assertPersistedFieldSafe(context.cityName, "cityName", "FREE_TEXT");
    if (context.sourceView?.viewKey) {
      assertPersistedFieldSafe(
        context.sourceView.viewKey,
        "sourceViewKey",
        "PRODUCT_URL",
      );
    }
    if (context.sourceView?.ownerLabel) {
      assertPersistedFieldSafe(
        context.sourceView.ownerLabel,
        "sourceViewLabel",
        "PRODUCT_LABEL",
      );
    }

    let observationsInserted = 0;
    let observationsSkippedDuplicate = 0;
    let opportunitiesInserted = 0;
    let newProductsDiscovered = 0;
    let existingProductsObserved = 0;
    let earlyScanRunResult: PersistApprovedBatchResult | undefined;

    try {
      this.withImmediateTransaction(() => {
        const firstListing = context.listings[0];
        if (!firstListing) {
          throw new Error("Empty listings in eligible batch.");
        }

        const checkProductExistsStmt = this.db.prepare(
          "SELECT 1 FROM products WHERE product_variant_key = ? LIMIT 1",
        );
        const seenProductKeysInBatch = new Set<string>();

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
              newProductsDiscovered: 0,
              existingProductsObserved: Number(existingScanRun.valid_observations),
              ...(context.sourceView !== undefined
                ? { sourceView: context.sourceView }
                : {}),
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
        assertPersistedFieldSafe(
          firstListing.store.externalStoreId,
          "externalStoreId",
          "STRICT_ID",
        );
        assertPersistedFieldSafe(firstListing.store.name, "storeName", "PRODUCT_LABEL");

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
              source_view_key,
              source_view_kind,
              source_view_label,
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
              new_products_discovered,
              existing_products_observed
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'RUNNING', ?, ?, ?, ?, 0, ?, ?, 0, 0, 0)`,
          )
          .run(
            context.scanRunId,
            batchFingerprint,
            context.sourceView?.viewKey ?? null,
            context.sourceView?.pageKind ?? null,
            context.sourceView?.ownerLabel ?? null,
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

        const insertScanRunProductStmt = this.db.prepare(
          `INSERT INTO scan_run_products (
            scan_run_id,
            product_variant_key
          ) VALUES (?, ?)
          ON CONFLICT(scan_run_id, product_variant_key) DO NOTHING`,
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

        for (const [listingIndex, rawListing] of context.listings.entries()) {
          const validatedPrice = createCopAmount(rawListing.observedPriceCop);
          const validatedRefPrice =
            rawListing.declaredReferencePriceCop !== undefined
              ? createCopAmount(rawListing.declaredReferencePriceCop)
              : null;

          const subject = buildOpaqueProductSubject(
            listingIndex,
            rawListing.variant.externalProductId,
          );
          assertPersistedFieldSafe(
            rawListing.variant.externalProductId,
            "externalProductId",
            "STRICT_ID",
            `product-index=${String(listingIndex)}`,
          );
          assertPersistedFieldSafe(
            rawListing.variant.externalVariantId,
            "externalVariantId",
            "STRICT_ID",
            subject,
          );
          assertPersistedFieldSafe(
            rawListing.variant.name,
            "productName",
            "PRODUCT_LABEL",
            subject,
          );
          assertPersistedFieldSafe(
            rawListing.variant.packagingLabel,
            "packagingLabel",
            "PRODUCT_LABEL",
            subject,
          );
          assertPersistedFieldSafe(
            rawListing.variant.brand,
            "brand",
            "PRODUCT_LABEL",
            subject,
          );
          assertPersistedFieldSafe(
            rawListing.variant.productUrl,
            "productUrl",
            "PRODUCT_URL",
            subject,
          );

          const productVariantKey = `${rawListing.providerId}::${rawListing.variant.externalProductId}::${rawListing.variant.externalVariantId}`;
          if (!seenProductKeysInBatch.has(productVariantKey)) {
            seenProductKeysInBatch.add(productVariantKey);
            if (checkProductExistsStmt.get(productVariantKey)) {
              existingProductsObserved += 1;
            } else {
              newProductsDiscovered += 1;
            }
          }
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

          insertScanRunProductStmt.run(context.scanRunId, productVariantKey);

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
                 opportunities_created = ?,
                 new_products_discovered = ?,
                 existing_products_observed = ?
             WHERE scan_run_id = ?`,
          )
          .run(
            new Date().toISOString(),
            actualObsCount,
            observationsSkippedDuplicate,
            actualOppCount,
            newProductsDiscovered,
            existingProductsObserved,
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
        newProductsDiscovered,
        existingProductsObserved,
        ...(context.sourceView !== undefined ? { sourceView: context.sourceView } : {}),
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
    this.assertWritable("reevaluateLatestListingOpportunities");
    const intelligenceConfig =
      options?.intelligenceConfig ?? PRIVATE_HISTORY_INTELLIGENCE_CONFIG;
    const evaluationTimeIso = options?.evaluationTimeIso ?? new Date().toISOString();
    const reevaluationRunId =
      options?.reevaluationRunId ??
      `reeval::${evaluationTimeIso}::${crypto.randomUUID().slice(0, 8)}`;

    let listingsEvaluated = 0;
    let opportunitiesInserted = 0;
    let opportunitiesSuperseded = 0;
    let opportunitiesReactivated = 0;

    this.withImmediateTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO reevaluation_runs (
            reevaluation_run_id,
            executed_at,
            target_listing_key,
            listings_evaluated,
            opportunities_inserted,
            opportunities_superseded,
            opportunities_reactivated
          ) VALUES (?, ?, ?, 0, 0, 0, 0)`,
        )
        .run(reevaluationRunId, evaluationTimeIso, options?.listingKey ?? null);

      const recordTransitionStmt = this.db.prepare(
        `INSERT INTO opportunity_lifecycle_transitions (
          opportunity_id, from_status, to_status, reason, reevaluation_run_id, transitioned_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      const findByDedupKeyStmt = this.db.prepare(
        `SELECT opportunity_id, lifecycle_status
         FROM opportunity_events
         WHERE deduplication_key = ?`,
      );

      // Explicit reactivation (`F-P2-09`): only a SUPERSEDED event may be restored. DISMISSED and
      // EXPIRED are terminal owner/time decisions and are never reactivated by reevaluation.
      const reactivateStmt = this.db.prepare(
        `UPDATE opportunity_events
         SET lifecycle_status = 'ACTIVE'
         WHERE opportunity_id = ? AND lifecycle_status = 'SUPERSEDED'`,
      );
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
            if (Number(supRes.changes) > 0) {
              opportunitiesSuperseded += Number(supRes.changes);
              recordTransitionStmt.run(
                activeRow.opportunity_id,
                "ACTIVE",
                "SUPERSEDED",
                "STALE_BASELINE_OR_INVALIDATED_BY_REEVALUATION",
                reevaluationRunId,
                evaluationTimeIso,
              );
            }
          }
        }

        for (const { opp, deduplicationKey } of candidatesWithKeys) {
          if (alreadyActiveDedupKeys.has(deduplicationKey)) {
            continue;
          }

          const existingByKey = findByDedupKeyStmt.get(deduplicationKey) as
            | { opportunity_id: string; lifecycle_status: OpportunityLifecycleStatus }
            | undefined;
          if (existingByKey) {
            if (existingByKey.lifecycle_status === "SUPERSEDED") {
              const reactivated = reactivateStmt.run(existingByKey.opportunity_id);
              if (Number(reactivated.changes) > 0) {
                opportunitiesReactivated += 1;
                recordTransitionStmt.run(
                  existingByKey.opportunity_id,
                  "SUPERSEDED",
                  "ACTIVE",
                  "BASELINE_VALID_AGAIN_AFTER_HISTORY_CORRECTION",
                  reevaluationRunId,
                  evaluationTimeIso,
                );
              }
            }
            // ACTIVE (already handled), DISMISSED and EXPIRED rows are left untouched.
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
               opportunities_superseded = ?,
               opportunities_reactivated = ?
           WHERE reevaluation_run_id = ?`,
        )
        .run(
          listingsEvaluated,
          opportunitiesInserted,
          opportunitiesSuperseded,
          opportunitiesReactivated,
          reevaluationRunId,
        );
    });

    return {
      reevaluationRunId,
      listingsEvaluated,
      opportunitiesInserted,
      opportunitiesSuperseded,
      opportunitiesReactivated,
    };
  }

  /**
   * Returns the append-only lifecycle audit trail of an opportunity event (`F-P2-09`).
   */
  public listOpportunityLifecycleTransitions(opportunityId: string): ReadonlyArray<{
    readonly fromStatus: OpportunityLifecycleStatus;
    readonly toStatus: OpportunityLifecycleStatus;
    readonly reason: string;
    readonly reevaluationRunId: string | null;
    readonly transitionedAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT from_status, to_status, reason, reevaluation_run_id, transitioned_at
         FROM opportunity_lifecycle_transitions
         WHERE opportunity_id = ?
         ORDER BY transition_id ASC`,
      )
      .all(opportunityId) as Array<{
      from_status: OpportunityLifecycleStatus;
      to_status: OpportunityLifecycleStatus;
      reason: string;
      reevaluation_run_id: string | null;
      transitioned_at: string;
    }>;
    return rows.map((r) => ({
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      reevaluationRunId: r.reevaluation_run_id,
      transitionedAt: r.transitioned_at,
    }));
  }

  /**
   * Explicitly restores a previously superseded historical observation (non-destructive correction reversal, `F-P2-09`).
   * Does not touch opportunity events; call `reevaluateLatestListingOpportunities()` afterwards to recompute them.
   */
  public restoreSupersededObservation(observationId: string): boolean {
    return this.withImmediateTransaction(() => {
      const res = this.db
        .prepare(
          `UPDATE price_observations
           SET is_superseded = 0, superseded_reason = NULL
           WHERE observation_id = ? AND is_superseded = 1`,
        )
        .run(observationId);
      return Number(res.changes) > 0;
    });
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
        const affected = this.db
          .prepare(
            `SELECT opportunity_id FROM opportunity_events
             WHERE observation_id = ? AND lifecycle_status = 'ACTIVE'`,
          )
          .all(observationId) as Array<{ opportunity_id: string }>;
        this.db
          .prepare(
            `UPDATE opportunity_events
             SET lifecycle_status = 'SUPERSEDED'
             WHERE observation_id = ? AND lifecycle_status = 'ACTIVE'`,
          )
          .run(observationId);
        const nowIso = new Date().toISOString();
        for (const row of affected) {
          this.db
            .prepare(
              `INSERT INTO opportunity_lifecycle_transitions (
                opportunity_id, from_status, to_status, reason, reevaluation_run_id, transitioned_at
              ) VALUES (?, 'ACTIVE', 'SUPERSEDED', 'SOURCE_OBSERVATION_SUPERSEDED', NULL, ?)`,
            )
            .run(row.opportunity_id, nowIso);
        }
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
          source_view_key,
          source_view_kind,
          source_view_label,
          new_products_discovered,
          existing_products_observed,
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
      source_view_key: string | null;
      source_view_kind: string | null;
      source_view_label: string | null;
      new_products_discovered: number | null;
      existing_products_observed: number | null;
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
      ...(r.source_view_key !== null ? { sourceViewKey: r.source_view_key } : {}),
      ...(r.source_view_kind !== null ? { sourceViewKind: r.source_view_kind } : {}),
      ...(r.source_view_label !== null ? { sourceViewLabel: r.source_view_label } : {}),
      newProductsDiscovered: r.new_products_discovered ?? 0,
      existingProductsObserved: r.existing_products_observed ?? 0,
      ...(r.error_category !== null ? { errorCategory: r.error_category } : {}),
      ...(r.error_summary !== null ? { errorSummary: r.error_summary } : {}),
    }));
  }

  /**
   * Generates a comprehensive, privacy-preserving catalog coverage report (`P3`).
   * Measures accumulated unique products, variants, active observations, views inspected,
   * category distribution and freshness without claiming to know Turbo's complete catalog denominator.
   */
  public getCatalogCoverageReport(options?: {
    readonly staleDays?: number;
  }): CatalogCoverageReport {
    const staleDays = Math.max(1, options?.staleDays ?? 7);

    const totalDistinctProductsRow = this.db
      .prepare("SELECT COUNT(DISTINCT external_product_id) as c FROM products")
      .get() as { c: number } | undefined;
    const totalDistinctVariantsRow = this.db
      .prepare("SELECT COUNT(*) as c FROM products")
      .get() as { c: number } | undefined;
    const totalActiveObsRow = this.db
      .prepare("SELECT COUNT(*) as c FROM price_observations WHERE is_superseded = 0")
      .get() as { c: number } | undefined;
    const totalScanRunsRow = this.db
      .prepare("SELECT COUNT(*) as c FROM scan_runs WHERE status = 'SUCCEEDED'")
      .get() as { c: number } | undefined;
    const totalInspectedViewsRow = this.db
      .prepare(
        "SELECT COUNT(DISTINCT COALESCE(source_view_key, 'VISTA_DEFAULT')) as c FROM scan_runs WHERE status = 'SUCCEEDED'",
      )
      .get() as { c: number } | undefined;

    const latestScanRunRow = this.db
      .prepare(
        `SELECT
          scan_run_id,
          started_at,
          source_view_key,
          source_view_kind,
          source_view_label,
          valid_observations,
          duplicate_records,
          new_products_discovered,
          existing_products_observed
        FROM scan_runs
        WHERE status = 'SUCCEEDED'
        ORDER BY started_at DESC
        LIMIT 1`,
      )
      .get() as
      | {
          scan_run_id: string;
          started_at: string;
          source_view_key: string | null;
          source_view_kind: string | null;
          source_view_label: string | null;
          valid_observations: number;
          duplicate_records: number;
          new_products_discovered: number;
          existing_products_observed: number;
        }
      | undefined;

    const viewRows = this.db
      .prepare(
        `SELECT
          COALESCE(r.source_view_key, 'VISTA_DEFAULT') as view_key,
          COALESCE(r.source_view_kind, 'STORE_ROOT') as page_kind,
          r.source_view_label as owner_label,
          MAX(r.started_at) as last_observed_at,
          COUNT(DISTINCT r.scan_run_id) as scan_runs_count,
          (
            SELECT COUNT(DISTINCT product_key)
            FROM (
              SELECT srp.product_variant_key as product_key
              FROM scan_run_products srp
              JOIN scan_runs r2 ON r2.scan_run_id = srp.scan_run_id
              WHERE r2.status = 'SUCCEEDED'
                AND COALESCE(r2.source_view_key, 'VISTA_DEFAULT') = COALESCE(r.source_view_key, 'VISTA_DEFAULT')
              UNION
              SELECT o2.product_variant_key as product_key
              FROM price_observations o2
              JOIN scan_runs r2 ON r2.scan_run_id = o2.scan_run_id
              WHERE r2.status = 'SUCCEEDED'
                AND o2.is_superseded = 0
                AND COALESCE(r2.source_view_key, 'VISTA_DEFAULT') = COALESCE(r.source_view_key, 'VISTA_DEFAULT')
            )
          ) as distinct_products_count,
          COUNT(o.observation_id) as total_observations_count
        FROM scan_runs r
        LEFT JOIN price_observations o ON o.scan_run_id = r.scan_run_id AND o.is_superseded = 0
        WHERE r.status = 'SUCCEEDED'
        GROUP BY COALESCE(r.source_view_key, 'VISTA_DEFAULT')
        ORDER BY last_observed_at DESC`,
      )
      .all() as Array<{
      view_key: string;
      page_kind: string;
      owner_label: string | null;
      last_observed_at: string;
      scan_runs_count: number;
      distinct_products_count: number;
      total_observations_count: number;
    }>;

    const categoryRows = this.db
      .prepare(
        `SELECT
          p.category_slug,
          COUNT(DISTINCT p.external_product_id) as distinct_products_count,
          COUNT(DISTINCT p.product_variant_key) as distinct_variants_count,
          COUNT(o.observation_id) as active_observations_count,
          MAX(p.last_seen_at) as last_seen_at
        FROM products p
        LEFT JOIN price_observations o ON o.product_variant_key = p.product_variant_key AND o.is_superseded = 0
        GROUP BY p.category_slug
        ORDER BY distinct_products_count DESC, p.category_slug ASC`,
      )
      .all() as Array<{
      category_slug: string;
      distinct_products_count: number;
      distinct_variants_count: number;
      active_observations_count: number;
      last_seen_at: string;
    }>;

    const staleCutoff = new Date(
      Date.now() - staleDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const staleCountRow = this.db
      .prepare("SELECT COUNT(*) as c FROM products WHERE last_seen_at < ?")
      .get(staleCutoff) as { c: number } | undefined;

    const newestProductsRows = this.db
      .prepare(
        `SELECT
          external_product_id,
          product_name,
          category_slug,
          first_seen_at,
          last_seen_at
        FROM products
        ORDER BY first_seen_at DESC, product_variant_key ASC
        LIMIT 5`,
      )
      .all() as Array<{
      external_product_id: string;
      product_name: string;
      category_slug: string;
      first_seen_at: string;
      last_seen_at: string;
    }>;

    return {
      totalDistinctProducts: Number(totalDistinctProductsRow?.c ?? 0),
      totalDistinctVariants: Number(totalDistinctVariantsRow?.c ?? 0),
      totalActiveObservations: Number(totalActiveObsRow?.c ?? 0),
      totalScanRuns: Number(totalScanRunsRow?.c ?? 0),
      totalInspectedViews: Number(totalInspectedViewsRow?.c ?? 0),
      ...(latestScanRunRow !== undefined
        ? {
            latestScanRun: {
              scanRunId: latestScanRunRow.scan_run_id,
              observedAt: latestScanRunRow.started_at,
              ...(latestScanRunRow.source_view_key !== null
                ? { viewKey: latestScanRunRow.source_view_key }
                : {}),
              ...(latestScanRunRow.source_view_kind !== null
                ? { viewKind: latestScanRunRow.source_view_kind }
                : {}),
              ...(latestScanRunRow.source_view_label !== null
                ? { viewLabel: latestScanRunRow.source_view_label }
                : {}),
              validObservations: latestScanRunRow.valid_observations,
              duplicateRecordsSuppressed: latestScanRunRow.duplicate_records,
              newProductsDiscovered: latestScanRunRow.new_products_discovered,
              existingProductsObserved: latestScanRunRow.existing_products_observed,
            },
          }
        : {}),
      views: viewRows.map((v) => ({
        viewKey: v.view_key,
        pageKind: v.page_kind,
        ...(v.owner_label !== null ? { ownerLabel: v.owner_label } : {}),
        lastObservedAt: v.last_observed_at,
        scanRunsCount: v.scan_runs_count,
        distinctProductsCount: v.distinct_products_count,
        totalObservationsCount: v.total_observations_count,
      })),
      categories: categoryRows.map((c) => ({
        categorySlug: c.category_slug,
        distinctProductsCount: c.distinct_products_count,
        distinctVariantsCount: c.distinct_variants_count,
        activeObservationsCount: c.active_observations_count,
        lastSeenAt: c.last_seen_at,
      })),
      staleProductsCount: Number(staleCountRow?.c ?? 0),
      staleThresholdDays: staleDays,
      newestProductsSample: newestProductsRows.map((p) => ({
        productId: p.external_product_id,
        productName: p.product_name,
        categorySlug: p.category_slug,
        firstSeenAt: p.first_seen_at,
        lastSeenAt: p.last_seen_at,
      })),
    };
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

  /**
   * Returns a top-level telemetry summary for the dashboard overview (`P4`).
   */
  public getDashboardSummary(): DashboardSummary {
    const totalDistinctProductsRow = this.db
      .prepare("SELECT COUNT(DISTINCT external_product_id) as c FROM products")
      .get() as { c: number } | undefined;
    const totalActiveObsRow = this.db
      .prepare("SELECT COUNT(*) as c FROM price_observations WHERE is_superseded = 0")
      .get() as { c: number } | undefined;
    const activeOppsRow = this.db
      .prepare(
        "SELECT COUNT(*) as c FROM opportunity_events WHERE lifecycle_status = 'ACTIVE'",
      )
      .get() as { c: number } | undefined;
    const historicalLowsRow = this.db
      .prepare(
        "SELECT COUNT(*) as c FROM opportunity_events WHERE lifecycle_status = 'ACTIVE' AND opportunity_type = 'HISTORICAL_LOW'",
      )
      .get() as { c: number } | undefined;
    const totalScanRunsRow = this.db
      .prepare("SELECT COUNT(*) as c FROM scan_runs WHERE status = 'SUCCEEDED'")
      .get() as { c: number } | undefined;
    const totalInspectedViewsRow = this.db
      .prepare(
        "SELECT COUNT(DISTINCT COALESCE(source_view_key, 'VISTA_DEFAULT')) as c FROM scan_runs WHERE status = 'SUCCEEDED'",
      )
      .get() as { c: number } | undefined;
    const latestObsRow = this.db
      .prepare(
        "SELECT MAX(observed_at) as m FROM price_observations WHERE is_superseded = 0",
      )
      .get() as { m: string | null } | undefined;
    const latestScanRunRow = this.db
      .prepare(
        `SELECT scan_run_id, started_at, source_view_key, source_view_label, new_products_discovered
         FROM scan_runs
         WHERE status = 'SUCCEEDED'
         ORDER BY started_at DESC, scan_run_id DESC
         LIMIT 1`,
      )
      .get() as
      | {
          scan_run_id: string;
          started_at: string;
          source_view_key: string | null;
          source_view_label: string | null;
          new_products_discovered: number | null;
        }
      | undefined;

    const totalActiveObs = Number(totalActiveObsRow?.c ?? 0);
    const latestObservationAt = latestObsRow?.m ?? undefined;

    let freshnessStatus: "RECENT" | "MODERATE" | "STALE" | "EMPTY" = "EMPTY";
    if (totalActiveObs > 0 && latestObservationAt) {
      const ageMs = Date.now() - new Date(latestObservationAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours <= 24) {
        freshnessStatus = "RECENT";
      } else if (ageHours <= 168) {
        freshnessStatus = "MODERATE";
      } else {
        freshnessStatus = "STALE";
      }
    }

    const topOpportunities = this.listActiveOpportunities({
      pageSize: 6,
      sortBy: "DISCOUNT_DESC",
    }).items;
    const recentlyObservedProducts = this.listCatalogProducts({
      pageSize: 6,
      sortBy: "LAST_SEEN_DESC",
    }).items;

    return {
      counts: {
        totalDistinctProducts: Number(totalDistinctProductsRow?.c ?? 0),
        totalActiveObservations: totalActiveObs,
        activeOpportunitiesCount: Number(activeOppsRow?.c ?? 0),
        historicalLowsCount: Number(historicalLowsRow?.c ?? 0),
        totalScanRuns: Number(totalScanRunsRow?.c ?? 0),
        totalInspectedViews: Number(totalInspectedViewsRow?.c ?? 0),
      },
      ...(latestObservationAt !== undefined ? { latestObservationAt } : {}),
      ...(latestScanRunRow !== undefined
        ? {
            latestScanRun: {
              scanRunId: latestScanRunRow.scan_run_id,
              startedAt: latestScanRunRow.started_at,
              ...(latestScanRunRow.source_view_key !== null
                ? { sourceViewKey: latestScanRunRow.source_view_key }
                : {}),
              ...(latestScanRunRow.source_view_label !== null
                ? { sourceViewLabel: latestScanRunRow.source_view_label }
                : {}),
              newProductsDiscovered: latestScanRunRow.new_products_discovered ?? 0,
            },
          }
        : {}),
      topOpportunities,
      recentlyObservedProducts,
      freshnessStatus,
    };
  }

  /**
   * Returns a paginated, filterable catalog of products with latest price telemetry (`P4`).
   */
  public listCatalogProducts(
    options?: ListCatalogProductsOptions,
  ): PaginatedResult<CatalogProductSummaryItem> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options?.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const whereClauses: string[] = ["latest.rn = 1"];
    const whereParams: Array<string | number> = [];

    const search = (options?.search ?? "").trim();
    if (search) {
      whereClauses.push(
        "(p.product_name LIKE ? OR p.external_product_id = ? OR p.brand LIKE ?)",
      );
      const pattern = `%${search}%`;
      whereParams.push(pattern, search, pattern);
    }

    if (options?.sourceViewKey) {
      if (options.sourceViewKey === "VISTA_DEFAULT") {
        whereClauses.push(
          "EXISTS (SELECT 1 FROM scan_run_products srp JOIN scan_runs sr ON sr.scan_run_id = srp.scan_run_id WHERE srp.product_variant_key = p.product_variant_key AND (sr.source_view_key IS NULL OR sr.source_view_key = 'VISTA_DEFAULT'))",
        );
      } else {
        whereClauses.push(
          "EXISTS (SELECT 1 FROM scan_run_products srp JOIN scan_runs sr ON sr.scan_run_id = srp.scan_run_id WHERE srp.product_variant_key = p.product_variant_key AND sr.source_view_key = ?)",
        );
        whereParams.push(options.sourceViewKey);
      }
    }

    if (options?.priceChange) {
      switch (options.priceChange) {
        case "DROPPED":
          whereClauses.push("latest.observed_price_cop < prev.observed_price_cop");
          break;
        case "INCREASED":
          whereClauses.push("latest.observed_price_cop > prev.observed_price_cop");
          break;
        case "UNCHANGED":
          whereClauses.push("latest.observed_price_cop = prev.observed_price_cop");
          break;
        case "FIRST_OBSERVATION":
          whereClauses.push("prev.observed_price_cop IS NULL");
          break;
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    let orderSql = "ORDER BY p.last_seen_at DESC, p.product_name ASC";
    switch (options?.sortBy) {
      case "NAME_ASC":
        orderSql = "ORDER BY p.product_name ASC";
        break;
      case "NAME_DESC":
        orderSql = "ORDER BY p.product_name DESC";
        break;
      case "PRICE_ASC":
        orderSql = "ORDER BY latest.observed_price_cop ASC, p.product_name ASC";
        break;
      case "PRICE_DESC":
        orderSql = "ORDER BY latest.observed_price_cop DESC, p.product_name ASC";
        break;
      case "OBSERVATIONS_DESC":
        orderSql = "ORDER BY stats.total_obs DESC, p.last_seen_at DESC";
        break;
      case "LAST_SEEN_DESC":
      default:
        orderSql = "ORDER BY p.last_seen_at DESC, p.product_name ASC";
        break;
    }

    const baseCte = `
      WITH ranked_obs AS (
        SELECT
          o.product_variant_key,
          o.observed_price_cop,
          o.declared_reference_price_cop,
          o.observed_at,
          o.store_key,
          o.scan_run_id,
          ROW_NUMBER() OVER (
            PARTITION BY o.product_variant_key
            ORDER BY o.observed_at DESC, o.observation_id DESC
          ) as rn
        FROM price_observations o
        WHERE o.is_superseded = 0
      ),
      product_obs_stats AS (
        SELECT
          product_variant_key,
          COUNT(*) as total_obs,
          MIN(observed_price_cop) as min_price,
          MAX(observed_price_cop) as max_price
        FROM price_observations
        WHERE is_superseded = 0
        GROUP BY product_variant_key
      )
    `;

    const countSql = `
      ${baseCte}
      SELECT COUNT(*) as c
      FROM products p
      JOIN ranked_obs latest ON latest.product_variant_key = p.product_variant_key AND latest.rn = 1
      LEFT JOIN ranked_obs prev ON prev.product_variant_key = p.product_variant_key AND prev.rn = 2
      JOIN product_obs_stats stats ON stats.product_variant_key = p.product_variant_key
      JOIN stores s ON s.store_key = latest.store_key
      ${whereSql}
    `;

    const countRow = this.db.prepare(countSql).get(...whereParams) as
      { c: number } | undefined;
    const totalCount = Number(countRow?.c ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    if (totalCount === 0) {
      return {
        items: [],
        totalCount: 0,
        page,
        pageSize,
        totalPages: 1,
      };
    }

    const selectSql = `
      ${baseCte}
      SELECT
        p.product_variant_key,
        p.external_product_id,
        p.external_variant_id,
        p.product_name,
        p.brand,
        p.packaging_label,
        p.unit_quantity,
        p.unit_type,
        p.category_slug,
        p.canonical_product_url,
        p.first_seen_at,
        p.last_seen_at,
        s.store_name,
        s.external_store_id,
        latest.observed_price_cop as latest_price,
        latest.observed_at as latest_observed_at,
        prev.observed_price_cop as prev_price,
        stats.total_obs,
        sr.source_view_key,
        sr.source_view_label,
        opp.opportunity_id as opp_id,
        opp.opportunity_type as opp_type,
        opp.label_es_co as opp_label,
        opp.savings_cop as opp_savings,
        opp.discount_percentage as opp_pct,
        opp.confidence as opp_conf
      FROM products p
      JOIN ranked_obs latest ON latest.product_variant_key = p.product_variant_key AND latest.rn = 1
      LEFT JOIN ranked_obs prev ON prev.product_variant_key = p.product_variant_key AND prev.rn = 2
      JOIN product_obs_stats stats ON stats.product_variant_key = p.product_variant_key
      JOIN stores s ON s.store_key = latest.store_key
      LEFT JOIN scan_runs sr ON sr.scan_run_id = latest.scan_run_id
      LEFT JOIN (
        SELECT
          e.opportunity_id,
          e.product_variant_key,
          e.opportunity_type,
          e.label_es_co,
          e.savings_cop,
          e.discount_percentage,
          e.confidence,
          ROW_NUMBER() OVER (
            PARTITION BY e.product_variant_key
            ORDER BY
              CASE e.opportunity_type
                WHEN 'HISTORICAL_LOW' THEN 1
                WHEN 'HISTORICAL_DROP' THEN 2
                WHEN 'DECLARED_DISCOUNT' THEN 3
                ELSE 4
              END,
              e.detected_at DESC
          ) as opp_rn
        FROM opportunity_events e
        WHERE e.lifecycle_status = 'ACTIVE'
      ) opp ON opp.product_variant_key = p.product_variant_key AND opp.opp_rn = 1
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db
      .prepare(selectSql)
      .all(...whereParams, pageSize, offset) as Array<{
      product_variant_key: string;
      external_product_id: string;
      external_variant_id: string;
      product_name: string;
      brand: string | null;
      packaging_label: string;
      unit_quantity: number;
      unit_type: string;
      category_slug: string;
      canonical_product_url: string | null;
      first_seen_at: string;
      last_seen_at: string;
      store_name: string;
      external_store_id: string;
      latest_price: number;
      latest_observed_at: string;
      prev_price: number | null;
      total_obs: number;
      source_view_key: string | null;
      source_view_label: string | null;
      opp_id: string | null;
      opp_type: OpportunityType | null;
      opp_label: string | null;
      opp_savings: number | null;
      opp_pct: number | null;
      opp_conf: string | null;
    }>;

    const items: CatalogProductSummaryItem[] = rows.map((r) => {
      const latestPriceCop = createCopAmount(r.latest_price);
      let previousPriceCop: CopAmount | undefined;
      let priceDifferenceCop: number | undefined;
      let priceDifferencePercentage: number | undefined;

      if (r.prev_price !== null) {
        previousPriceCop = createCopAmount(r.prev_price);
        priceDifferenceCop = r.latest_price - r.prev_price;
        if (r.prev_price > 0) {
          priceDifferencePercentage = Math.round(
            ((r.latest_price - r.prev_price) / r.prev_price) * 100,
          );
        }
      }

      return {
        productVariantKey: r.product_variant_key,
        externalProductId: r.external_product_id,
        externalVariantId: r.external_variant_id,
        productName: r.product_name,
        ...(r.brand !== null ? { brand: r.brand } : {}),
        packagingLabel: r.packaging_label,
        unitQuantity: r.unit_quantity,
        unitType: r.unit_type,
        categorySlug: r.category_slug,
        ...(r.canonical_product_url
          ? { canonicalProductUrl: r.canonical_product_url }
          : {}),
        latestPriceCop,
        ...(previousPriceCop !== undefined ? { previousPriceCop } : {}),
        ...(priceDifferenceCop !== undefined ? { priceDifferenceCop } : {}),
        ...(priceDifferencePercentage !== undefined ? { priceDifferencePercentage } : {}),
        observationCount: r.total_obs,
        firstObservedAt: r.first_seen_at,
        lastObservedAt: r.last_seen_at,
        storeName: r.store_name,
        externalStoreId: r.external_store_id,
        ...(r.source_view_key !== null ? { latestSourceViewKey: r.source_view_key } : {}),
        ...(r.source_view_label !== null
          ? { latestSourceViewLabel: r.source_view_label }
          : {}),
        ...(r.opp_id !== null &&
        r.opp_type !== null &&
        r.opp_label !== null &&
        r.opp_savings !== null &&
        r.opp_pct !== null &&
        r.opp_conf !== null
          ? {
              activeOpportunity: {
                opportunityId: createPresentationOpportunityId(r.opp_id),
                type: r.opp_type,
                labelEsCo: r.opp_label,
                savingsCop: createCopAmount(r.opp_savings),
                discountPercentage: r.opp_pct,
                confidence: r.opp_conf,
              },
            }
          : {}),
      };
    });

    return {
      items,
      totalCount,
      page,
      pageSize,
      totalPages,
    };
  }

  /**
   * Retrieves comprehensive product detail, price statistics, observations timeline, and active opportunities (`P4`).
   */
  public getProductDetail(productIdOrKey: string): ProductDetailView | undefined {
    const trimmed = productIdOrKey.trim();
    if (!trimmed) return undefined;

    // Check if trimmed matches an exact product_variant_key first
    let productRow = this.db
      .prepare(
        `SELECT
          p.product_variant_key,
          p.external_product_id,
          p.external_variant_id,
          p.product_name,
          p.brand,
          p.packaging_label,
          p.unit_quantity,
          p.unit_type,
          p.category_slug,
          p.canonical_product_url,
          p.first_seen_at,
          p.last_seen_at,
          COALESCE(s.store_name, 'Desconocida') as store_name,
          COALESCE(s.external_store_id, 'N/A') as external_store_id
        FROM products p
        LEFT JOIN price_observations o ON o.product_variant_key = p.product_variant_key AND o.is_superseded = 0
        LEFT JOIN stores s ON s.store_key = o.store_key
        WHERE p.product_variant_key = ?
        ORDER BY o.observed_at DESC
        LIMIT 1`,
      )
      .get(trimmed) as
      | {
          product_variant_key: string;
          external_product_id: string;
          external_variant_id: string;
          product_name: string;
          brand: string | null;
          packaging_label: string;
          unit_quantity: number;
          unit_type: string;
          category_slug: string;
          canonical_product_url: string | null;
          first_seen_at: string;
          last_seen_at: string;
          store_name: string;
          external_store_id: string;
        }
      | undefined;

    // If not found by product_variant_key, check if it's an external_product_id
    if (!productRow) {
      const matchingKeys = this.db
        .prepare(`SELECT product_variant_key FROM products WHERE external_product_id = ?`)
        .all(trimmed) as Array<{ product_variant_key: string }>;

      // If exactly 1 variant exists, resolve safely (preserves legacy single-variant lookup)
      if (matchingKeys.length === 1 && matchingKeys[0]) {
        const singleKey = matchingKeys[0].product_variant_key;
        productRow = this.db
          .prepare(
            `SELECT
              p.product_variant_key,
              p.external_product_id,
              p.external_variant_id,
              p.product_name,
              p.brand,
              p.packaging_label,
              p.unit_quantity,
              p.unit_type,
              p.category_slug,
              p.canonical_product_url,
              p.first_seen_at,
              p.last_seen_at,
              COALESCE(s.store_name, 'Desconocida') as store_name,
              COALESCE(s.external_store_id, 'N/A') as external_store_id
            FROM products p
            LEFT JOIN price_observations o ON o.product_variant_key = p.product_variant_key AND o.is_superseded = 0
            LEFT JOIN stores s ON s.store_key = o.store_key
            WHERE p.product_variant_key = ?
            ORDER BY o.observed_at DESC
            LIMIT 1`,
          )
          .get(singleKey) as typeof productRow;
      } else {
        // If matchingKeys.length > 1, the externalProductId is ambiguous across variants!
        // Returning undefined prevents silently selecting an incorrect variant.
        return undefined;
      }
    }

    if (!productRow) {
      return undefined;
    }

    const obsRows = this.db
      .prepare(
        `SELECT
          o.observed_at,
          o.observed_price_cop,
          o.declared_reference_price_cop,
          o.availability,
          s.store_name,
          r.source_view_key,
          r.source_view_label
        FROM price_observations o
        JOIN stores s ON s.store_key = o.store_key
        LEFT JOIN scan_runs r ON r.scan_run_id = o.scan_run_id
        WHERE o.product_variant_key = ? AND o.is_superseded = 0
        ORDER BY o.observed_at ASC, o.observation_id ASC`,
      )
      .all(productRow.product_variant_key) as Array<{
      observed_at: string;
      observed_price_cop: number;
      declared_reference_price_cop: number | null;
      availability: string;
      store_name: string;
      source_view_key: string | null;
      source_view_label: string | null;
    }>;

    const observations: ProductDetailObservationItem[] = obsRows.map((r, idx) => ({
      presentationId: `obs-${idx + 1}`,
      observedAt: r.observed_at,
      observedPriceCop: createCopAmount(r.observed_price_cop),
      ...(r.declared_reference_price_cop !== null
        ? { declaredReferencePriceCop: createCopAmount(r.declared_reference_price_cop) }
        : {}),
      availability: r.availability,
      storeName: r.store_name,
      ...(r.source_view_key !== null ? { sourceViewKey: r.source_view_key } : {}),
      ...(r.source_view_label !== null ? { sourceViewLabel: r.source_view_label } : {}),
    }));

    const observationCount = observations.length;
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let totalPrice = 0;

    for (const ob of observations) {
      if (ob.observedPriceCop < minPrice) minPrice = ob.observedPriceCop;
      if (ob.observedPriceCop > maxPrice) maxPrice = ob.observedPriceCop;
      totalPrice += ob.observedPriceCop;
    }

    const latestOb = observations[observations.length - 1];
    const prevOb =
      observations.length >= 2 ? observations[observations.length - 2] : undefined;
    const currentPriceCop = latestOb ? latestOb.observedPriceCop : createCopAmount(0);
    const previousPriceCop = prevOb ? prevOb.observedPriceCop : undefined;
    const minPriceCop = createCopAmount(minPrice === Infinity ? 0 : minPrice);
    const maxPriceCop = createCopAmount(maxPrice === -Infinity ? 0 : maxPrice);
    const averagePriceCop = createCopAmount(
      observationCount > 0 ? Math.round(totalPrice / observationCount) : 0,
    );

    let priceDifferenceCop: number | undefined;
    let priceDifferencePercentage: number | undefined;

    if (previousPriceCop !== undefined) {
      priceDifferenceCop = currentPriceCop - previousPriceCop;
      if (previousPriceCop > 0) {
        priceDifferencePercentage = Math.round(
          ((currentPriceCop - previousPriceCop) / previousPriceCop) * 100,
        );
      }
    }

    const firstObservedAt = observations[0]?.observedAt ?? productRow.first_seen_at;
    const lastObservedAt = latestOb?.observedAt ?? productRow.last_seen_at;

    const oppRows = this.db
      .prepare(
        `SELECT
          e.opportunity_id,
          e.product_variant_key,
          p.external_product_id,
          p.external_variant_id,
          p.product_name,
          p.brand,
          p.packaging_label,
          s.store_name,
          e.opportunity_type,
          e.label_es_co,
          e.baseline_price_cop,
          e.previous_price_cop,
          e.observed_price_cop,
          e.savings_cop,
          e.discount_percentage,
          e.confidence,
          e.detected_at
        FROM opportunity_events e
        JOIN products p ON p.product_variant_key = e.product_variant_key
        JOIN stores s ON s.store_key = e.store_key
        WHERE e.product_variant_key = ?
          AND e.lifecycle_status = 'ACTIVE'
        ORDER BY e.detected_at DESC`,
      )
      .all(productRow.product_variant_key) as Array<{
      opportunity_id: string;
      product_variant_key: string;
      external_product_id: string;
      external_variant_id: string;
      product_name: string;
      brand: string | null;
      packaging_label: string;
      store_name: string;
      opportunity_type: OpportunityType;
      label_es_co: string;
      baseline_price_cop: number;
      previous_price_cop: number | null;
      observed_price_cop: number;
      savings_cop: number;
      discount_percentage: number;
      confidence: ConfidenceLevel;
      detected_at: string;
    }>;

    const activeOpportunities: DashboardOpportunityItem[] = oppRows.map((r) => ({
      opportunityId: createPresentationOpportunityId(r.opportunity_id),
      productVariantKey: r.product_variant_key,
      externalProductId: r.external_product_id,
      externalVariantId: r.external_variant_id,
      productName: r.product_name,
      ...(r.brand !== null ? { brand: r.brand } : {}),
      packagingLabel: r.packaging_label,
      storeName: r.store_name,
      opportunityType: r.opportunity_type,
      labelEsCo: r.label_es_co,
      baselinePriceCop: createCopAmount(r.baseline_price_cop),
      ...(r.previous_price_cop !== null
        ? { previousPriceCop: createCopAmount(r.previous_price_cop) }
        : {}),
      observedPriceCop: createCopAmount(r.observed_price_cop),
      savingsCop: createCopAmount(r.savings_cop),
      discountPercentage: r.discount_percentage,
      confidence: r.confidence,
      detectedAt: r.detected_at,
    }));

    return {
      product: {
        productVariantKey: productRow.product_variant_key,
        externalProductId: productRow.external_product_id,
        externalVariantId: productRow.external_variant_id,
        productName: productRow.product_name,
        ...(productRow.brand !== null ? { brand: productRow.brand } : {}),
        packagingLabel: productRow.packaging_label,
        unitQuantity: productRow.unit_quantity,
        unitType: productRow.unit_type,
        categorySlug: productRow.category_slug,
        ...(productRow.canonical_product_url
          ? { canonicalProductUrl: productRow.canonical_product_url }
          : {}),
        storeName: productRow.store_name,
        externalStoreId: productRow.external_store_id,
        firstSeenAt: productRow.first_seen_at,
        lastSeenAt: productRow.last_seen_at,
      },
      statistics: {
        currentPriceCop,
        ...(previousPriceCop !== undefined ? { previousPriceCop } : {}),
        ...(priceDifferenceCop !== undefined ? { priceDifferenceCop } : {}),
        ...(priceDifferencePercentage !== undefined ? { priceDifferencePercentage } : {}),
        minPriceCop,
        maxPriceCop,
        averagePriceCop,
        observationCount,
        firstObservedAt,
        lastObservedAt,
        hasSufficientHistory: observationCount >= 2,
      },
      observations,
      activeOpportunities,
    };
  }

  /**
   * Returns a paginated list of active opportunities with search, type filter, and custom sorting (`P4`).
   */
  public listActiveOpportunities(
    options?: ListActiveOpportunitiesOptions,
  ): PaginatedResult<DashboardOpportunityItem> {
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options?.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const whereClauses: string[] = ["e.lifecycle_status = 'ACTIVE'"];
    const whereParams: Array<string | number> = [];

    const search = (options?.search ?? "").trim();
    if (search) {
      whereClauses.push(
        "(p.product_name LIKE ? OR p.external_product_id = ? OR e.label_es_co LIKE ?)",
      );
      const pattern = `%${search}%`;
      whereParams.push(pattern, search, pattern);
    }

    if (options?.type) {
      whereClauses.push("e.opportunity_type = ?");
      whereParams.push(options.type);
    }

    const whereSql = `WHERE ${whereClauses.join(" AND ")}`;

    let orderSql = "ORDER BY e.discount_basis_points DESC, e.detected_at DESC";
    switch (options?.sortBy) {
      case "DISCOUNT_ASC":
        orderSql = "ORDER BY e.discount_basis_points ASC, e.detected_at DESC";
        break;
      case "SAVINGS_DESC":
        orderSql = "ORDER BY e.savings_cop DESC, e.detected_at DESC";
        break;
      case "SAVINGS_ASC":
        orderSql = "ORDER BY e.savings_cop ASC, e.detected_at DESC";
        break;
      case "DATE_DESC":
        orderSql = "ORDER BY e.detected_at DESC, e.opportunity_id DESC";
        break;
      case "DATE_ASC":
        orderSql = "ORDER BY e.detected_at ASC, e.opportunity_id ASC";
        break;
      case "DISCOUNT_DESC":
      default:
        orderSql = "ORDER BY e.discount_basis_points DESC, e.detected_at DESC";
        break;
    }

    const countSql = `
      SELECT COUNT(*) as c
      FROM opportunity_events e
      JOIN products p ON p.product_variant_key = e.product_variant_key
      JOIN stores s ON s.store_key = e.store_key
      ${whereSql}
    `;

    const countRow = this.db.prepare(countSql).get(...whereParams) as
      { c: number } | undefined;
    const totalCount = Number(countRow?.c ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    if (totalCount === 0) {
      return {
        items: [],
        totalCount: 0,
        page,
        pageSize,
        totalPages: 1,
      };
    }

    const selectSql = `
      SELECT
        e.opportunity_id,
        e.product_variant_key,
        p.external_product_id,
        p.external_variant_id,
        p.product_name,
        p.brand,
        p.packaging_label,
        s.store_name,
        e.opportunity_type,
        e.label_es_co,
        e.baseline_price_cop,
        e.previous_price_cop,
        e.observed_price_cop,
        e.savings_cop,
        e.discount_percentage,
        e.confidence,
        e.detected_at
      FROM opportunity_events e
      JOIN products p ON p.product_variant_key = e.product_variant_key
      JOIN stores s ON s.store_key = e.store_key
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db
      .prepare(selectSql)
      .all(...whereParams, pageSize, offset) as Array<{
      opportunity_id: string;
      product_variant_key: string;
      external_product_id: string;
      external_variant_id: string;
      product_name: string;
      brand: string | null;
      packaging_label: string;
      store_name: string;
      opportunity_type: OpportunityType;
      label_es_co: string;
      baseline_price_cop: number;
      previous_price_cop: number | null;
      observed_price_cop: number;
      savings_cop: number;
      discount_percentage: number;
      confidence: ConfidenceLevel;
      detected_at: string;
    }>;

    const items: DashboardOpportunityItem[] = rows.map((r) => ({
      opportunityId: createPresentationOpportunityId(r.opportunity_id),
      productVariantKey: r.product_variant_key,
      externalProductId: r.external_product_id,
      externalVariantId: r.external_variant_id,
      productName: r.product_name,
      ...(r.brand !== null ? { brand: r.brand } : {}),
      packagingLabel: r.packaging_label,
      storeName: r.store_name,
      opportunityType: r.opportunity_type,
      labelEsCo: r.label_es_co,
      baselinePriceCop: createCopAmount(r.baseline_price_cop),
      ...(r.previous_price_cop !== null
        ? { previousPriceCop: createCopAmount(r.previous_price_cop) }
        : {}),
      observedPriceCop: createCopAmount(r.observed_price_cop),
      savingsCop: createCopAmount(r.savings_cop),
      discountPercentage: r.discount_percentage,
      confidence: r.confidence,
      detectedAt: r.detected_at,
    }));

    return {
      items,
      totalCount,
      page,
      pageSize,
      totalPages,
    };
  }
}

export interface DashboardOpportunityItem {
  readonly opportunityId: string;
  readonly productVariantKey: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly productName: string;
  readonly brand?: string;
  readonly packagingLabel: string;
  readonly storeName: string;
  readonly opportunityType: OpportunityType;
  readonly labelEsCo: string;
  readonly baselinePriceCop: CopAmount;
  readonly previousPriceCop?: CopAmount;
  readonly observedPriceCop: CopAmount;
  readonly savingsCop: CopAmount;
  readonly discountPercentage: number;
  readonly confidence: ConfidenceLevel;
  readonly detectedAt: string;
}

export interface ProductDetailObservationItem {
  readonly presentationId: string;
  readonly observedAt: string;
  readonly observedPriceCop: CopAmount;
  readonly declaredReferencePriceCop?: CopAmount;
  readonly availability: string;
  readonly storeName: string;
  readonly sourceViewKey?: string;
  readonly sourceViewLabel?: string;
}

export interface DashboardSummary {
  readonly counts: {
    readonly totalDistinctProducts: number;
    readonly totalActiveObservations: number;
    readonly activeOpportunitiesCount: number;
    readonly historicalLowsCount: number;
    readonly totalScanRuns: number;
    readonly totalInspectedViews: number;
  };
  readonly latestObservationAt?: string;
  readonly latestScanRun?: {
    readonly scanRunId: string;
    readonly startedAt: string;
    readonly sourceViewKey?: string;
    readonly sourceViewLabel?: string;
    readonly newProductsDiscovered: number;
  };
  readonly topOpportunities: readonly DashboardOpportunityItem[];
  readonly recentlyObservedProducts: readonly CatalogProductSummaryItem[];
  readonly freshnessStatus: "RECENT" | "MODERATE" | "STALE" | "EMPTY";
}

export interface ListCatalogProductsOptions {
  readonly search?: string;
  readonly sourceViewKey?: string;
  readonly priceChange?: "DROPPED" | "INCREASED" | "UNCHANGED" | "FIRST_OBSERVATION";
  readonly page?: number;
  readonly pageSize?: number;
  readonly sortBy?:
    | "NAME_ASC"
    | "NAME_DESC"
    | "PRICE_ASC"
    | "PRICE_DESC"
    | "LAST_SEEN_DESC"
    | "OBSERVATIONS_DESC";
}

export interface CatalogProductSummaryItem {
  readonly productVariantKey: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly productName: string;
  readonly brand?: string;
  readonly packagingLabel: string;
  readonly unitQuantity: number;
  readonly unitType: string;
  readonly categorySlug: string;
  readonly canonicalProductUrl?: string;
  readonly latestPriceCop: CopAmount;
  readonly previousPriceCop?: CopAmount;
  readonly priceDifferenceCop?: number;
  readonly priceDifferencePercentage?: number;
  readonly observationCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly storeName: string;
  readonly externalStoreId: string;
  readonly latestSourceViewKey?: string;
  readonly latestSourceViewLabel?: string;
  readonly activeOpportunity?: {
    readonly opportunityId: string;
    readonly type: OpportunityType;
    readonly labelEsCo: string;
    readonly savingsCop: CopAmount;
    readonly discountPercentage: number;
    readonly confidence: string;
  };
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface ProductDetailView {
  readonly product: {
    readonly productVariantKey: string;
    readonly externalProductId: string;
    readonly externalVariantId: string;
    readonly productName: string;
    readonly brand?: string;
    readonly packagingLabel: string;
    readonly unitQuantity: number;
    readonly unitType: string;
    readonly categorySlug: string;
    readonly canonicalProductUrl?: string;
    readonly storeName: string;
    readonly externalStoreId: string;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
  };
  readonly statistics: {
    readonly currentPriceCop: CopAmount;
    readonly previousPriceCop?: CopAmount;
    readonly priceDifferenceCop?: number;
    readonly priceDifferencePercentage?: number;
    readonly minPriceCop: CopAmount;
    readonly maxPriceCop: CopAmount;
    readonly averagePriceCop: CopAmount;
    readonly observationCount: number;
    readonly firstObservedAt: string;
    readonly lastObservedAt: string;
    readonly hasSufficientHistory: boolean;
  };
  readonly observations: readonly ProductDetailObservationItem[];
  readonly activeOpportunities: readonly DashboardOpportunityItem[];
}

export interface ListActiveOpportunitiesOptions {
  readonly search?: string;
  readonly type?: OpportunityType;
  readonly sortBy?:
    | "DISCOUNT_DESC"
    | "DISCOUNT_ASC"
    | "SAVINGS_DESC"
    | "SAVINGS_ASC"
    | "DATE_DESC"
    | "DATE_ASC";
  readonly page?: number;
  readonly pageSize?: number;
}
