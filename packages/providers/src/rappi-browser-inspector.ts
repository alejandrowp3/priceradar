import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AvailabilityStatus,
  DataProvenance,
  DiscoveredListing,
  DiscoveryTarget,
  GeographicContext,
  PriceObservationRecord,
} from "@priceradar/domain";
import { buildCanonicalListingKey, createCopAmount } from "@priceradar/domain";
import type {
  CatalogProvider,
  DiscoveryOptions,
  DiscoveryResult,
  ProviderCapabilities,
} from "./contracts.ts";

export const RAPPI_BROWSER_PROVIDER_ID = "rappi-colombia-browser";

export const MIN_CONTEXT_HMAC_SECRET_BYTES = 32;

const FORBIDDEN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-32-byte-cryptographic-random-context-hmac-secret",
  "replace-with-32-byte-cryptographic-random-secret",
  "changeme",
  "default-secret",
  "development-secret",
]);

export type FieldVerificationStatus = "VERIFIED" | "PARTIAL" | "UNSUPPORTED" | "MISSING";

export interface FieldVerificationEntry {
  readonly field:
    | "productIdentity"
    | "name"
    | "brand"
    | "currentPriceCop"
    | "referencePriceCop"
    | "packagingAndVariant"
    | "storeIdentity"
    | "availability"
    | "productUrl";
  readonly status: FieldVerificationStatus;
  readonly verifiedCount: number;
  readonly totalEvaluated: number;
  readonly notes: string;
}

export type BrowserInspectionGateStatus =
  | "OK"
  | "CHALLENGE_DETECTED"
  | "AUTH_REQUIRED"
  | "MISSING_DELIVERY_CONTEXT"
  | "UNVERIFIED_FULFILLMENT_CONTEXT"
  | "UNSUPPORTED_DOM_STRUCTURE";

export type ActiveAddressSelectionEvidence =
  "VERIFIED_ACTIVE_SELECTION" | "PLACEHOLDER_OR_EMPTY" | "MISSING_HEADER_SELECTOR";

export type CityAndNeighborhoodMetadataEvidence =
  "VERIFIED_FROM_ACTIVE_CONTEXT" | "STATIC_SEO_METADATA_ONLY" | "MISSING";

export type ServingStoreBranchEvidence =
  "VERIFIED_BRANCH_SERVING_CONTEXT" | "UNVERIFIED_STATIC_DEFAULT_BRANCH" | "MISSING";

export type ProductCatalogContextEvidence =
  | "VERIFIED_CONTEXT_BOUND_CATALOG"
  | "UNVERIFIED_RENDERED_DOM_CATALOG"
  | "UNVERIFIED_STATIC_SEO_HYDRATION"
  | "EMPTY_CATALOG";

export type PricingVerificationVerdict =
  | "VERIFIED_ADDRESS_SPECIFIC_PRICING"
  | "UNVERIFIED_STATIC_SEO_PRICING"
  | "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION"
  | "UNVERIFIED_MISSING_HMAC_SECRET"
  | "UNVERIFIED_NO_ACTIVE_ADDRESS";

export interface FulfillmentContextEvidenceBreakdown {
  readonly activeAddressSelection: ActiveAddressSelectionEvidence;
  readonly cityAndNeighborhoodMetadata: CityAndNeighborhoodMetadataEvidence;
  readonly servingStoreBranch: ServingStoreBranchEvidence;
  readonly servingStoreBranchId?: string;
  readonly productCatalogContext: ProductCatalogContextEvidence;
  readonly pricingVerificationVerdict: PricingVerificationVerdict;
}

/**
 * Explicit 4-state navigation verification model (`Task A`).
 * Strictly separates user-driven session navigation states from independent
 * address-specific pricing attestation (`ADDRESS_SPECIFIC_PRICING_VERIFIED`).
 */
export interface NavigationVerificationStates {
  readonly ADDRESS_SELECTED: boolean;
  readonly STORE_OPENED_FROM_ADDRESS_CONTEXT: boolean;
  readonly CATALOG_VISIBLE_IN_SESSION: boolean;
  readonly ADDRESS_SPECIFIC_PRICING_VERIFIED: boolean;
}

export type ExtractedNameSource =
  "DOM_HEADING" | "DOM_ANCHOR_TEXT" | "DOM_IMAGE_ALT" | "NEXT_DATA_SSR";

export type ExtractedPriceSource = "DOM_CARD_TEXT" | "NEXT_DATA_SSR";

export type ExtractedBrandSource = "DOM_EXPLICIT" | "NEXT_DATA_SSR";

export interface RawDomProductCard {
  readonly externalId?: string;
  readonly name?: string;
  readonly nameSource?: ExtractedNameSource;
  readonly brand?: string;
  readonly brandSource?: ExtractedBrandSource;
  readonly priceText?: string;
  readonly priceSource?: ExtractedPriceSource;
  readonly referencePriceText?: string;
  readonly packagingText?: string;
  readonly availabilityText?: string;
  readonly inStockFlag?: boolean;
  readonly href?: string;
}

export interface StorefrontExtractionDiagnostics {
  readonly productCounts: {
    readonly rawInputCandidates: number;
    readonly consolidatedUniqueCards: number;
    readonly completeVerifiedCards: number;
    readonly incompleteSkippedCards: number;
    readonly conflictingPriceCardsSkipped: number;
  };
  readonly duplicateCounts: {
    readonly splitAnchorPairsMerged: number;
    readonly duplicateListingKeysSuppressed: number;
    readonly conflictingSameKeyCardsRejected: number;
    readonly suppressedListingKeys: readonly string[];
  };
  readonly extractionSources: {
    readonly name: {
      readonly domHeading: number;
      readonly domAnchorText: number;
      readonly domImageAlt: number;
      readonly nextDataSsr: number;
      readonly missing: number;
    };
    readonly currentPrice: {
      readonly domCardText: number;
      readonly nextDataSsr: number;
      readonly missingOrMalformed: number;
    };
    readonly brand: {
      readonly domExplicit: number;
      readonly nextDataSsr: number;
      readonly missing: number;
    };
  };
  readonly storeAndBranchStatus: {
    readonly displayedStoreSlug?: string;
    readonly displayedNumericStoreId?: string;
    readonly servingBranchId?: string;
    readonly branchVerificationStatus: ServingStoreBranchEvidence;
    readonly associations: {
      readonly activeDeliveryAddressDetected: boolean;
      readonly storefrontCurrentlyDisplayed: boolean;
      readonly branchServingSelectedAddressVerified: boolean;
      readonly catalogDemonstrablyLoadedForAddressVerified: boolean;
    };
  };
  readonly missingGeographicEvidence: readonly string[];
}

export interface RawStorefrontSnapshot {
  readonly pageUrl: string;
  readonly pageTitle?: string;
  readonly observedAtIso: string;
  /**
   * Whether the page visibly shows an active security/WAF/CAPTCHA challenge.
   */
  readonly hasSecurityChallenge?: boolean;
  /**
   * Whether the page is prompting the user to log in rather than showing an active session.
   */
  readonly isLoginRequired?: boolean;
  /**
   * Raw text of the delivery address widget in the header bar (if visible).
   * Passed strictly to the in-memory keyed HMAC privacy sanitizer to compute an opaque
   * fulfillment context token (`ctx-<16hex>`); NEVER logged or persisted!
   */
  readonly rawDeliveryHeaderLabel?: string;
  /**
   * Externally stored high-entropy secret (>= 32 bytes) used for keyed HMAC-SHA256
   * derivation of `fulfillmentContextHash` (`F-P1-01`). Never falls back to unkeyed hashing.
   */
  readonly contextHmacSecret?: string;
  /**
   * Optional previous HMAC secret during a key rotation window (`F-P1-01`).
   * When provided, the inspector also computes `previousFulfillmentContextHash` in memory
   * so existing local history records can be migrated without storing raw addresses.
   */
  readonly previousContextHmacSecret?: string;
  /**
   * Detected Colombian city name from header or storefront context (e.g., "Medellín", "Bogotá").
   */
  readonly detectedCityName?: string;
  /**
   * Optional neighborhood / locality metadata associated with the active context (coarse, non-PII).
   */
  readonly detectedNeighborhoodName?: string;
  /**
   * Provenance of the city/neighborhood metadata (`F-P1-02`).
   * Distinguishes active delivery context metadata from static SEO metadata (`seoStore.city`).
   */
  readonly cityMetadataSource?: "ACTIVE_DELIVERY_CONTEXT" | "STATIC_SEO_METADATA";
  /**
   * Whether the delivery context came from an authenticated user header selection
   * (`true`) or only from a generic static SEO store location (`false`).
   */
  readonly hasActiveDeliverySelector?: boolean;
  readonly storeId?: string;
  readonly storeName?: string;
  /**
   * Specific store branch / fulfillment keeper ID serving the active delivery context (`F-P1-02`).
   */
  readonly servingBranchId?: string;
  /**
   * Whether the page exposes explicit evidence that `servingBranchId` is the store branch
   * actively serving the selected delivery context (rather than a static default SEO branch).
   */
  readonly isServingBranchVerifiedForContext?: boolean;
  /**
   * Provenance of the product catalog (`F-P1-02`).
   * Distinguishes a client catalog verified as loaded for the selected delivery context
   * from unverified DOM cards or static `#__NEXT_DATA__` SSR hydration data.
   */
  readonly catalogSource?:
    "VERIFIED_CONTEXT_DOM" | "UNVERIFIED_LIVE_DOM" | "STATIC_NEXT_DATA_FALLBACK";
  /**
   * Whether the storefront was opened through Rappi's directory/UI during an active
   * address-selected session (`Task A`: `/tiendas/tipo/market` -> `/tiendas/{store_id}-...`).
   */
  readonly openedFromAddressDirectoryContext?: boolean;
  /**
   * Sanitized sequence of pathnames observed during the supervised browser session (`Task A`).
   */
  readonly sanitizedNavigationPathHistory?: readonly string[];
  /**
   * When `true`, allows in-memory normalization of provisional private session observations
   * (`PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL`) when `ADDRESS_SELECTED`,
   * `STORE_OPENED_FROM_ADDRESS_CONTEXT`, and `CATALOG_VISIBLE_IN_SESSION` all hold,
   * while keeping `ADDRESS_SPECIFIC_PRICING_VERIFIED = false` (`Task C`).
   */
  readonly allowProvisionalSessionObservations?: boolean;
  readonly categorySlug?: string;
  readonly rawCards?: readonly RawDomProductCard[];
  /**
   * Optional raw `#__NEXT_DATA__` JSON string if present in the document.
   */
  readonly nextDataJson?: string;
}

export interface SanitizedGeographicValidation {
  /**
   * `true` ONLY when all 5 layers of `evidenceBreakdown` are verified (`F-P1-02`)
   * AND a valid keyed HMAC secret (`F-P1-01`) was supplied.
   */
  readonly isDeliveryContextVerified: boolean;
  readonly citySlug: string;
  readonly cityName: string;
  /**
   * Privacy-preserving, keyed HMAC-SHA256 identifier (`ctx-<16hex>`) of the normalized
   * delivery context + citySlug using an externally stored secret (`F-P1-01`).
   * Resistant to offline dictionary guessing and stable across restarts.
   */
  readonly fulfillmentContextHash?: string;
  /**
   * Populated only when `previousContextHmacSecret` is supplied during key rotation (`F-P1-01`),
   * allowing deterministic migration of historical observations without storing raw addresses.
   */
  readonly previousFulfillmentContextHash?: string;
  /**
   * Explicit 5-layer fulfillment-context evidence breakdown (`F-P1-02`).
   */
  readonly evidenceBreakdown: FulfillmentContextEvidenceBreakdown;
  /**
   * Explicit 4-state navigation verification breakdown (`Task A`).
   */
  readonly navigationStates: NavigationVerificationStates;
  /**
   * Sanitized pathname sequence observed during the supervised browser session (`Task A`).
   */
  readonly sanitizedNavigationPathHistory?: readonly string[];
  readonly statusReason: string;
}

export interface StorefrontInspectionReport {
  readonly gateStatus: BrowserInspectionGateStatus;
  readonly gateMessage: string;
  readonly pageUrl: string;
  readonly observedAtIso: string;
  readonly geographicValidation: SanitizedGeographicValidation;
  readonly fieldVerification: readonly FieldVerificationEntry[];
  readonly diagnostics: StorefrontExtractionDiagnostics;
  readonly listings: readonly DiscoveredListing[];
  readonly skippedMalformedCount: number;
  readonly duplicateSuppressedCount: number;
}

const CHALLENGE_PATTERNS = [
  /cf-chl-bypass/i,
  /challenge-platform/i,
  /verifica que eres humano/i,
  /verify you are human/i,
  /attention required! \| cloudflare/i,
  /captcha/i,
  /access denied/i,
];

const PLACEHOLDER_ADDRESS_PATTERNS = [
  /^ingresa tu direcci[oó]n$/i,
  /^selecciona tu direcci[oó]n$/i,
  /^agregar direcci[oó]n$/i,
  /^¿d[oó]nde quieres recibir tu pedido\??$/i,
  /^ubicaci[oó]n$/i,
];

/**
 * Strips Colombian PUM (Precio por Unidad de Medida) expressions such as
 * `($ 63,50 / g)`, `($ 12.000/kg)`, or `$ 45 / ml` from raw card text so unit-price
 * annotations are never misclassified as product prices or packaging sizes.
 */
export function stripColombianPumExpressions(rawText: string): string {
  return rawText
    .replace(
      /\(\s*\$\s*[\d.,\s]+\s*(?:\/|por)\s*(?:kg|g|gr|gramos|ml|l|lt|litros|und|un|unidad|u)\s*\)/gi,
      " ",
    )
    .replace(
      /\$\s*[\d.,]+\s*(?:\/|por)\s*(?:kg|g|gr|gramos|ml|l|lt|litros|und|un|unidad|u)\b/gi,
      " ",
    )
    .replace(/\bpum\s*:?\s*\$?\s*[\d.,]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Consolidates split image-anchor + title-anchor DOM pairs that point to the exact same
 * canonical `/p/` product URL on a single storefront card (`Priority 1`).
 *
 * Rules:
 * - Never invents a fallback name if no anchor for that `/p/` URL has a valid name.
 * - If two anchors for the same `/p/` URL have conflicting valid COP prices, both are
 *   rejected (`conflictingPriceCardsSkipped`) to prevent mis-associated prices.
 * - If one anchor has no `name` (e.g., the image `<a href="/p/...">`) and a sibling anchor
 *   for the exact same `/p/` URL has a valid `name` with matching price, they are merged
 *   into one card and counted in `splitAnchorPairsMerged`.
 * - If two anchors are both complete cards (both have `name`), they are NOT merged here
 *   so `duplicateSuppressedCount` can track duplicate complete cards accurately.
 */
export function consolidateDomProductCardCandidates(
  rawCards: readonly RawDomProductCard[],
): {
  readonly consolidatedCards: readonly RawDomProductCard[];
  readonly splitAnchorPairsMerged: number;
  readonly conflictingPriceCardsSkipped: number;
} {
  const byHref = new Map<string, RawDomProductCard[]>();
  const withoutHref: RawDomProductCard[] = [];

  for (const card of rawCards) {
    const cleanHref = card.href?.trim();
    if (!cleanHref) {
      withoutHref.push(card);
      continue;
    }
    const existing = byHref.get(cleanHref);
    if (existing) {
      existing.push(card);
    } else {
      byHref.set(cleanHref, [card]);
    }
  }

  const consolidatedCards: RawDomProductCard[] = [];
  let splitAnchorPairsMerged = 0;
  let conflictingPriceCardsSkipped = 0;

  for (const [, group] of byHref) {
    if (group.length === 1) {
      const single = group[0];
      if (single) consolidatedCards.push(single);
      continue;
    }

    // Check if all cards in this same-href group that have a valid price agree on the price
    // UNLESS they have distinct packagingText (e.g., 500 g vs 250 g sharing a base product URL)
    const distinctVariantsInGroup = new Set(
      group.map((c) => `${c.packagingText?.trim() ?? ""}::${c.name?.trim() ?? ""}`),
    );
    const hasUnnamedAnchor = group.some((c) => !c.name?.trim());
    const namedCards = group.filter((c) => Boolean(c.name?.trim()));
    const unnamedCards = group.filter((c) => !c.name?.trim());

    if (hasUnnamedAnchor && namedCards.length > 0) {
      // Check for price conflict between the unnamed anchor(s) and named anchor(s)
      const distinctPrices = new Set<number>();
      for (const c of group) {
        const parsed = parseCopPriceText(c.priceText);
        if (parsed !== undefined) {
          distinctPrices.add(parsed);
        }
      }

      if (distinctPrices.size > 1 && distinctVariantsInGroup.size <= 2) {
        conflictingPriceCardsSkipped += group.length;
        continue;
      }

      // Merge unnamed image-anchor metadata into the first named title-anchor card
      const primary = namedCards[0];
      const fallbackUnnamed = unnamedCards[0];
      if (primary) {
        splitAnchorPairsMerged += unnamedCards.length;
        consolidatedCards.push({
          ...fallbackUnnamed,
          ...primary,
          ...(primary.name !== undefined ? { name: primary.name } : {}),
          ...(primary.nameSource !== undefined ? { nameSource: primary.nameSource } : {}),
          ...(primary.priceText !== undefined
            ? { priceText: primary.priceText }
            : fallbackUnnamed?.priceText !== undefined
              ? { priceText: fallbackUnnamed.priceText }
              : {}),
        });
        for (let i = 1; i < namedCards.length; i += 1) {
          const extraNamed = namedCards[i];
          if (extraNamed) consolidatedCards.push(extraNamed);
        }
      }
      continue;
    }

    // Otherwise preserve all cards in group (either all unnamed or all named)
    for (const c of group) {
      consolidatedCards.push(c);
    }
  }

  for (const c of withoutHref) {
    consolidatedCards.push(c);
  }

  return {
    consolidatedCards,
    splitAnchorPairsMerged,
    conflictingPriceCardsSkipped,
  };
}

/**
 * Validates that a candidate HMAC secret meets minimum length (>= 32 bytes)
 * and entropy requirements (`F-P1-01`). Never allows empty, short, or placeholder secrets.
 */
export function validateContextHmacSecret(secret: string | undefined): {
  readonly isValid: boolean;
  readonly reason?: string;
} {
  if (secret === undefined) {
    return {
      isValid: false,
      reason:
        "Missing contextHmacSecret (F-P1-01). An externally stored secret of at least 32 bytes is required to prevent dictionary guessing.",
    };
  }

  const trimmed = secret.trim();
  const byteLength = Buffer.byteLength(trimmed, "utf8");
  if (byteLength < MIN_CONTEXT_HMAC_SECRET_BYTES) {
    return {
      isValid: false,
      reason: `Weak contextHmacSecret (F-P1-01): expected at least ${String(MIN_CONTEXT_HMAC_SECRET_BYTES)} bytes, received ${String(byteLength)} bytes.`,
    };
  }

  if (FORBIDDEN_PLACEHOLDER_SECRETS.has(trimmed.toLowerCase())) {
    return {
      isValid: false,
      reason:
        "Forbidden placeholder contextHmacSecret detected (F-P1-01). Generate a real cryptographic secret.",
    };
  }

  const uniqueChars = new Set(trimmed).size;
  if (uniqueChars < 6) {
    return {
      isValid: false,
      reason:
        "Low-entropy contextHmacSecret rejected (F-P1-01): secret must contain sufficient character diversity.",
    };
  }

  return { isValid: true };
}

/**
 * Reads a specific environment variable key from a dotenv-formatted file (`.env.local`)
 * without mutating global `process.env` or exposing other secrets.
 */
export function readEnvVarFromFile(
  envFilePath: string | undefined,
  key: string,
): string | undefined {
  if (!envFilePath || !fs.existsSync(envFilePath)) {
    return undefined;
  }

  const content = fs.readFileSync(envFilePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const candidateKey = line.slice(0, eqIndex).trim();
    if (candidateKey !== key) continue;
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    return value || undefined;
  }

  return undefined;
}

/**
 * Resolves the context HMAC secret from an explicit value, `PRICERADAR_CONTEXT_HMAC_SECRET`
 * environment variable, an optional `.env.local` file, or an external local secret file
 * (`~/.local/share/priceradar/context-hmac.key`, permissions `0600`) so that delivery-context
 * identifiers remain stable across restarts (`F-P1-01`).
 */
export function resolveOrProvisionContextHmacSecret(options?: {
  readonly explicitSecret?: string;
  readonly envSecret?: string;
  readonly envFilePath?: string;
  readonly secretFilePath?: string;
  readonly allowCreateFile?: boolean;
}): string | undefined {
  const candidateExplicit = options?.explicitSecret?.trim();
  if (candidateExplicit && validateContextHmacSecret(candidateExplicit).isValid) {
    return candidateExplicit;
  }

  const candidateEnv = (
    options?.envSecret ?? process.env.PRICERADAR_CONTEXT_HMAC_SECRET
  )?.trim();
  if (candidateEnv && validateContextHmacSecret(candidateEnv).isValid) {
    return candidateEnv;
  }

  const candidateDotenv = readEnvVarFromFile(
    options?.envFilePath,
    "PRICERADAR_CONTEXT_HMAC_SECRET",
  );
  if (candidateDotenv && validateContextHmacSecret(candidateDotenv).isValid) {
    return candidateDotenv;
  }

  const filePath = options?.secretFilePath;
  if (!filePath) {
    return undefined;
  }

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (validateContextHmacSecret(existing).isValid) {
      return existing;
    }
    throw new Error(
      `Existing context HMAC secret file at ${filePath} failed validation (must be >= 32 bytes of high-entropy key material).`,
    );
  }

  if (options?.allowCreateFile === true) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const generatedSecret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(filePath, `${generatedSecret}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return generatedSecret;
  }

  return undefined;
}

/**
 * Normalizes a delivery header label before HMAC derivation (`F-P1-01`) so that
 * cosmetic UI differences (diacritics, "Enviar a:" / "Dirección:" prefixes,
 * punctuation, or repeated spaces) produce a stable context identifier.
 */
export function normalizeDeliveryHeaderLabel(rawLabel: string): string {
  return rawLabel
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(?:enviar a|entregar en|direccion|ubicacion)\s*:?\s*/i, "")
    .replace(/[.,;#\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Computes a privacy-preserving, keyed HMAC-SHA256 fingerprint (`ctx-<16hex>`)
 * from the active delivery label and `citySlug` using an externally stored secret (`F-P1-01`).
 */
export function computePrivacyPreservingContextHash(params: {
  readonly rawDeliveryLabel: string;
  readonly citySlug: string;
  readonly contextHmacSecret: string;
}): string {
  const validation = validateContextHmacSecret(params.contextHmacSecret);
  if (!validation.isValid) {
    throw new Error(validation.reason ?? "Invalid contextHmacSecret (F-P1-01).");
  }

  const normalized = normalizeDeliveryHeaderLabel(params.rawDeliveryLabel);
  if (normalized.length < 3) {
    throw new Error("Normalized delivery label is empty or too short (F-P1-01).");
  }

  const normalizedCity = normalizeCitySlug(params.citySlug).citySlug;
  const digest = crypto
    .createHmac("sha256", params.contextHmacSecret.trim())
    .update(`priceradar-hmac-v2::${normalizedCity}::${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return `ctx-${digest}`;
}

/**
 * Computes both the current `fulfillmentContextHash` and (when `previousSecret` is provided)
 * the `previousFulfillmentContextHash` in a single ephemeral in-memory pass (`F-P1-01`).
 */
export function computeKeyedContextIdentifiersWithRotation(params: {
  readonly rawDeliveryLabel: string;
  readonly citySlug: string;
  readonly currentSecret: string;
  readonly previousSecret?: string;
}): {
  readonly currentContextHash: string;
  readonly previousContextHash?: string;
} {
  const currentContextHash = computePrivacyPreservingContextHash({
    rawDeliveryLabel: params.rawDeliveryLabel,
    citySlug: params.citySlug,
    contextHmacSecret: params.currentSecret,
  });

  const trimmedPrev = params.previousSecret?.trim();
  if (
    trimmedPrev &&
    trimmedPrev !== params.currentSecret.trim() &&
    validateContextHmacSecret(trimmedPrev).isValid
  ) {
    const previousContextHash = computePrivacyPreservingContextHash({
      rawDeliveryLabel: params.rawDeliveryLabel,
      citySlug: params.citySlug,
      contextHmacSecret: trimmedPrev,
    });
    return { currentContextHash, previousContextHash };
  }

  return { currentContextHash };
}

const CONTEXT_HASH_FORMAT_REGEX = /^ctx-[0-9a-f]{16}$/;

/**
 * Migrates historical `PriceObservationRecord` entries from a previous `fulfillmentContextHash`
 * to a newly rotated `fulfillmentContextHash` (`F-P1-01`) without requiring the raw street address.
 */
export function migrateObservationsForRotatedContext(
  observations: readonly PriceObservationRecord[],
  migration: {
    readonly fromContextHash: string;
    readonly toContextHash: string;
  },
): readonly PriceObservationRecord[] {
  const fromToken = migration.fromContextHash.trim();
  const toToken = migration.toContextHash.trim();
  if (
    !CONTEXT_HASH_FORMAT_REGEX.test(fromToken) ||
    !CONTEXT_HASH_FORMAT_REGEX.test(toToken)
  ) {
    throw new Error(
      "Invalid context hash format for migration: expected ctx-<16hex> tokens.",
    );
  }
  if (fromToken === toToken) {
    return observations;
  }

  const suffixPattern = new RegExp(
    `::${fromToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=::|$)`,
    "g",
  );

  const rewritten = observations.map((obs) => {
    if (!obs.listingKey.includes(`::${fromToken}`)) {
      return obs;
    }
    return {
      ...obs,
      listingKey: obs.listingKey.replace(suffixPattern, `::${toToken}`),
      observationId: obs.observationId.replace(suffixPattern, `::${toToken}`),
    };
  });

  const seenIds = new Set<string>();
  const seenCompositeKeys = new Set<string>();
  const deduplicated: PriceObservationRecord[] = [];

  for (const item of rewritten) {
    const compositeKey = `${item.listingKey}@@${item.observedAt}`;
    if (seenIds.has(item.observationId) || seenCompositeKeys.has(compositeKey)) {
      continue;
    }
    seenIds.add(item.observationId);
    seenCompositeKeys.add(compositeKey);
    deduplicated.push(item);
  }

  return deduplicated;
}

export function normalizeCitySlug(cityName: string | undefined): {
  readonly citySlug: string;
  readonly cityName: string;
} {
  const trimmed = (cityName ?? "").trim();
  if (!trimmed) {
    return { citySlug: "colombia-unspecified", cityName: "Colombia (Sin ciudad)" };
  }
  const slug = trimmed
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return {
    citySlug: slug || "colombia-unspecified",
    cityName: trimmed,
  };
}

/**
 * Classifies the data provenance of a storefront observation based on the
 * 4-state navigation verification model (`Task A` & `Task C`):
 * - `LIVE_PRIVATE`: Independently verified address-specific pricing (`ADDRESS_SPECIFIC_PRICING_VERIFIED === true`)
 * - `PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL`: Observed in a store opened during an authenticated,
 *   address-selected session (`ADDRESS_SELECTED && STORE_OPENED_FROM_ADDRESS_CONTEXT && CATALOG_VISIBLE_IN_SESSION`),
 *   while `ADDRESS_SPECIFIC_PRICING_VERIFIED` remains `false`.
 * - `PUBLIC_STOREFRONT_UNAUTHENTICATED`: Public or unauthenticated storefront observation without
 *   an active address-selected navigation context.
 */
export function classifyObservationProvenance(
  geoValidation: SanitizedGeographicValidation,
): DataProvenance {
  const nav = geoValidation.navigationStates;
  if (nav.ADDRESS_SPECIFIC_PRICING_VERIFIED) {
    return "LIVE_PRIVATE";
  }
  if (
    nav.ADDRESS_SELECTED &&
    nav.STORE_OPENED_FROM_ADDRESS_CONTEXT &&
    nav.CATALOG_VISIBLE_IN_SESSION
  ) {
    return "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL";
  }
  return "PUBLIC_STOREFRONT_UNAUTHENTICATED";
}

/**
 * Evaluates all 5 required layers of fulfillment-context evidence (`F-P1-02`),
 * derives a keyed HMAC context identifier (`F-P1-01`), and computes the explicit
 * 4-state navigation verification breakdown (`Task A`).
 */
export function validateGeographicDeliveryContext(params: {
  readonly hasActiveDeliverySelector?: boolean;
  readonly rawDeliveryHeaderLabel?: string;
  readonly contextHmacSecret?: string;
  readonly previousContextHmacSecret?: string;
  readonly detectedCityName?: string;
  readonly cityMetadataSource?: "ACTIVE_DELIVERY_CONTEXT" | "STATIC_SEO_METADATA";
  readonly staticStoreId?: string;
  readonly servingBranchId?: string;
  readonly isServingBranchVerifiedForContext?: boolean;
  readonly catalogSource?:
    "VERIFIED_CONTEXT_DOM" | "UNVERIFIED_LIVE_DOM" | "STATIC_NEXT_DATA_FALLBACK";
  readonly openedFromAddressDirectoryContext?: boolean;
  readonly sanitizedNavigationPathHistory?: readonly string[];
}): SanitizedGeographicValidation {
  const { citySlug, cityName } = normalizeCitySlug(params.detectedCityName);
  const label = (params.rawDeliveryHeaderLabel ?? "").trim();

  const isPlaceholder =
    label.length < 4 ||
    PLACEHOLDER_ADDRESS_PATTERNS.some((pattern) => pattern.test(label));

  // Layer 1: Active address selection
  const activeAddressSelection: ActiveAddressSelectionEvidence =
    !params.hasActiveDeliverySelector
      ? "MISSING_HEADER_SELECTOR"
      : isPlaceholder
        ? "PLACEHOLDER_OR_EMPTY"
        : "VERIFIED_ACTIVE_SELECTION";

  // Layer 2: City and neighborhood metadata
  const cityAndNeighborhoodMetadata: CityAndNeighborhoodMetadataEvidence =
    !params.detectedCityName?.trim()
      ? "MISSING"
      : params.cityMetadataSource === "STATIC_SEO_METADATA" ||
          activeAddressSelection !== "VERIFIED_ACTIVE_SELECTION"
        ? "STATIC_SEO_METADATA_ONLY"
        : "VERIFIED_FROM_ACTIVE_CONTEXT";

  // Layer 3: Store branch actually serving the selected context
  const cleanBranchId = params.servingBranchId?.trim();
  const servingStoreBranch: ServingStoreBranchEvidence =
    params.isServingBranchVerifiedForContext === true && Boolean(cleanBranchId)
      ? "VERIFIED_BRANCH_SERVING_CONTEXT"
      : cleanBranchId || params.staticStoreId?.trim()
        ? "UNVERIFIED_STATIC_DEFAULT_BRANCH"
        : "MISSING";

  // Layer 4: Product catalog loaded for that context vs static SEO/hydration
  const productCatalogContext: ProductCatalogContextEvidence =
    params.catalogSource === "STATIC_NEXT_DATA_FALLBACK"
      ? "UNVERIFIED_STATIC_SEO_HYDRATION"
      : params.catalogSource === "VERIFIED_CONTEXT_DOM"
        ? "VERIFIED_CONTEXT_BOUND_CATALOG"
        : params.catalogSource === "UNVERIFIED_LIVE_DOM"
          ? "UNVERIFIED_RENDERED_DOM_CATALOG"
          : "EMPTY_CATALOG";

  const catalogVisibleInSession =
    productCatalogContext === "VERIFIED_CONTEXT_BOUND_CATALOG" ||
    productCatalogContext === "UNVERIFIED_RENDERED_DOM_CATALOG";

  const pathHistoryHasDirectoryTransition = Boolean(
    params.sanitizedNavigationPathHistory &&
    params.sanitizedNavigationPathHistory.some((p) =>
      /^\/tiendas\/tipo\/market/i.test(p),
    ) &&
    params.sanitizedNavigationPathHistory.some((p) =>
      /^\/tiendas\/(?!tipo\/)[^/?#]+/i.test(p),
    ),
  );

  if (activeAddressSelection !== "VERIFIED_ACTIVE_SELECTION") {
    return {
      isDeliveryContextVerified: false,
      citySlug,
      cityName,
      evidenceBreakdown: {
        activeAddressSelection,
        cityAndNeighborhoodMetadata,
        servingStoreBranch,
        ...(cleanBranchId !== undefined ? { servingStoreBranchId: cleanBranchId } : {}),
        productCatalogContext,
        pricingVerificationVerdict: "UNVERIFIED_NO_ACTIVE_ADDRESS",
      },
      navigationStates: {
        ADDRESS_SELECTED: false,
        STORE_OPENED_FROM_ADDRESS_CONTEXT: false,
        CATALOG_VISIBLE_IN_SESSION: catalogVisibleInSession,
        ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
      },
      ...(params.sanitizedNavigationPathHistory !== undefined
        ? { sanitizedNavigationPathHistory: params.sanitizedNavigationPathHistory }
        : {}),
      statusReason:
        "No active owner-selected delivery address detected in the header. Static city labels (e.g., Medellín SEO metadata) do not establish address-specific fulfillment pricing.",
    };
  }

  const secretCheck = validateContextHmacSecret(params.contextHmacSecret);
  if (!secretCheck.isValid || !params.contextHmacSecret) {
    return {
      isDeliveryContextVerified: false,
      citySlug,
      cityName,
      evidenceBreakdown: {
        activeAddressSelection,
        cityAndNeighborhoodMetadata,
        servingStoreBranch,
        ...(cleanBranchId !== undefined ? { servingStoreBranchId: cleanBranchId } : {}),
        productCatalogContext,
        pricingVerificationVerdict: "UNVERIFIED_MISSING_HMAC_SECRET",
      },
      navigationStates: {
        ADDRESS_SELECTED: false,
        STORE_OPENED_FROM_ADDRESS_CONTEXT: false,
        CATALOG_VISIBLE_IN_SESSION: catalogVisibleInSession,
        ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
      },
      ...(params.sanitizedNavigationPathHistory !== undefined
        ? { sanitizedNavigationPathHistory: params.sanitizedNavigationPathHistory }
        : {}),
      statusReason:
        secretCheck.reason ??
        "Missing or invalid contextHmacSecret (F-P1-01). Refusing to compute an unkeyed delivery-context hash.",
    };
  }

  const rotatedIds = computeKeyedContextIdentifiersWithRotation({
    rawDeliveryLabel: label,
    citySlug,
    currentSecret: params.contextHmacSecret,
    ...(params.previousContextHmacSecret !== undefined
      ? { previousSecret: params.previousContextHmacSecret }
      : {}),
  });

  const storeOpenedFromAddressContext =
    params.openedFromAddressDirectoryContext === true ||
    pathHistoryHasDirectoryTransition ||
    servingStoreBranch === "VERIFIED_BRANCH_SERVING_CONTEXT";

  if (
    productCatalogContext === "UNVERIFIED_STATIC_SEO_HYDRATION" ||
    cityAndNeighborhoodMetadata === "STATIC_SEO_METADATA_ONLY"
  ) {
    return {
      isDeliveryContextVerified: false,
      citySlug,
      cityName,
      fulfillmentContextHash: rotatedIds.currentContextHash,
      ...(rotatedIds.previousContextHash !== undefined
        ? { previousFulfillmentContextHash: rotatedIds.previousContextHash }
        : {}),
      evidenceBreakdown: {
        activeAddressSelection,
        cityAndNeighborhoodMetadata,
        servingStoreBranch,
        ...(cleanBranchId !== undefined ? { servingStoreBranchId: cleanBranchId } : {}),
        productCatalogContext,
        pricingVerificationVerdict: "UNVERIFIED_STATIC_SEO_PRICING",
      },
      navigationStates: {
        ADDRESS_SELECTED: true,
        STORE_OPENED_FROM_ADDRESS_CONTEXT: storeOpenedFromAddressContext,
        CATALOG_VISIBLE_IN_SESSION: catalogVisibleInSession,
        ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
      },
      ...(params.sanitizedNavigationPathHistory !== undefined
        ? { sanitizedNavigationPathHistory: params.sanitizedNavigationPathHistory }
        : {}),
      statusReason:
        "Active delivery address header is present, but product catalog or city metadata originates from unverified static SEO / SSR hydration (#__NEXT_DATA__). Address-specific pricing is NOT verified (F-P1-02).",
    };
  }

  if (
    servingStoreBranch !== "VERIFIED_BRANCH_SERVING_CONTEXT" ||
    productCatalogContext !== "VERIFIED_CONTEXT_BOUND_CATALOG"
  ) {
    return {
      isDeliveryContextVerified: false,
      citySlug,
      cityName,
      fulfillmentContextHash: rotatedIds.currentContextHash,
      ...(rotatedIds.previousContextHash !== undefined
        ? { previousFulfillmentContextHash: rotatedIds.previousContextHash }
        : {}),
      evidenceBreakdown: {
        activeAddressSelection,
        cityAndNeighborhoodMetadata,
        servingStoreBranch,
        ...(cleanBranchId !== undefined ? { servingStoreBranchId: cleanBranchId } : {}),
        productCatalogContext,
        pricingVerificationVerdict: "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
      },
      navigationStates: {
        ADDRESS_SELECTED: true,
        STORE_OPENED_FROM_ADDRESS_CONTEXT: storeOpenedFromAddressContext,
        CATALOG_VISIBLE_IN_SESSION: catalogVisibleInSession,
        ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
      },
      ...(params.sanitizedNavigationPathHistory !== undefined
        ? { sanitizedNavigationPathHistory: params.sanitizedNavigationPathHistory }
        : {}),
      statusReason:
        "Active delivery address header is present, but there is insufficient evidence associating the serving store branch and rendered product catalog with the selected delivery context (F-P1-02). Address-specific pricing is NOT verified.",
    };
  }

  return {
    isDeliveryContextVerified: true,
    citySlug,
    cityName,
    fulfillmentContextHash: rotatedIds.currentContextHash,
    ...(rotatedIds.previousContextHash !== undefined
      ? { previousFulfillmentContextHash: rotatedIds.previousContextHash }
      : {}),
    evidenceBreakdown: {
      activeAddressSelection,
      cityAndNeighborhoodMetadata,
      servingStoreBranch,
      ...(cleanBranchId !== undefined ? { servingStoreBranchId: cleanBranchId } : {}),
      productCatalogContext,
      pricingVerificationVerdict: "VERIFIED_ADDRESS_SPECIFIC_PRICING",
    },
    navigationStates: {
      ADDRESS_SELECTED: true,
      STORE_OPENED_FROM_ADDRESS_CONTEXT: true,
      CATALOG_VISIBLE_IN_SESSION: true,
      ADDRESS_SPECIFIC_PRICING_VERIFIED: true,
    },
    ...(params.sanitizedNavigationPathHistory !== undefined
      ? { sanitizedNavigationPathHistory: params.sanitizedNavigationPathHistory }
      : {}),
    statusReason:
      "All 5 fulfillment-context layers verified (active address selection, context city/neighborhood metadata, serving store branch, and context-bound catalog) with keyed HMAC-SHA256 context identifier.",
  };
}

/**
 * Parses a Colombian Peso (COP) price string (e.g., "$ 31.500", "$1.200.000", "31500")
 * or numeric value into a validated integer `CopAmount`.
 */
export function parseCopPriceText(
  rawInput: string | number | undefined,
): ReturnType<typeof createCopAmount> | undefined {
  if (rawInput === undefined || rawInput === null) {
    return undefined;
  }

  if (typeof rawInput === "number") {
    if (!Number.isSafeInteger(rawInput) || rawInput <= 0) {
      return undefined;
    }
    return createCopAmount(rawInput);
  }

  const text = rawInput.trim();
  if (!text) {
    return undefined;
  }

  if (text.includes("-") || /,\d+$/.test(text)) {
    return undefined;
  }

  const match = text.match(/^\$?\s*(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:\s*COP)?$/i);
  if (!match || !match[1]) {
    return undefined;
  }

  const digitsOnly = match[1].replace(/[.\s]/g, "");
  const parsed = Number.parseInt(digitsOnly, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return createCopAmount(parsed);
}

/**
 * Parses packaging/variant descriptions (e.g., "Bolsa 500 g", "1000 ml", "2.5 kg", "1.5 L", "6 und")
 * into structured unit quantities and normalized unit types so different packaging sizes
 * never collide under the same variant ID.
 */
export function parsePackagingVariant(
  packagingText: string | undefined,
  productName: string,
): {
  readonly packagingLabel: string;
  readonly unitQuantity: number;
  readonly unitType: "g" | "ml" | "unit" | "kg" | "l";
  readonly variantSlug: string;
  readonly hasExplicitQuantityUnit: boolean;
} {
  const cleanPackaging = stripColombianPumExpressions(packagingText ?? "");
  const cleanName = stripColombianPumExpressions(productName);
  const combinedSource = `${cleanPackaging} ${cleanName}`.trim();
  const qtyMatch = combinedSource.match(
    /\b(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gramos|ml|l|lt|litros|und|un|unidades|u)\b/i,
  );

  if (qtyMatch && qtyMatch[1] && qtyMatch[2]) {
    const rawNumber = Number.parseFloat(qtyMatch[1].replace(",", "."));
    const rawUnit = qtyMatch[2].toLowerCase();

    if (Number.isFinite(rawNumber) && rawNumber > 0) {
      if (rawUnit === "kg") {
        const grams = Math.round(rawNumber * 1000);
        return {
          packagingLabel: cleanPackaging || `${String(grams)} g`,
          unitQuantity: grams,
          unitType: "g",
          variantSlug: `${String(grams)}g`,
          hasExplicitQuantityUnit: true,
        };
      }
      if (rawUnit === "g" || rawUnit === "gr" || rawUnit === "gramos") {
        const grams = Math.round(rawNumber);
        return {
          packagingLabel: cleanPackaging || `${String(grams)} g`,
          unitQuantity: grams,
          unitType: "g",
          variantSlug: `${String(grams)}g`,
          hasExplicitQuantityUnit: true,
        };
      }
      if (rawUnit === "l" || rawUnit === "lt" || rawUnit === "litros") {
        const ml = Math.round(rawNumber * 1000);
        return {
          packagingLabel: cleanPackaging || `${String(ml)} ml`,
          unitQuantity: ml,
          unitType: "ml",
          variantSlug: `${String(ml)}ml`,
          hasExplicitQuantityUnit: true,
        };
      }
      if (rawUnit === "ml") {
        const ml = Math.round(rawNumber);
        return {
          packagingLabel: cleanPackaging || `${String(ml)} ml`,
          unitQuantity: ml,
          unitType: "ml",
          variantSlug: `${String(ml)}ml`,
          hasExplicitQuantityUnit: true,
        };
      }
      const units = Math.max(1, Math.round(rawNumber));
      return {
        packagingLabel: cleanPackaging || `${String(units)} und`,
        unitQuantity: units,
        unitType: "unit",
        variantSlug: `${String(units)}unit`,
        hasExplicitQuantityUnit: true,
      };
    }
  }

  const fallbackLabel = cleanPackaging || "Unidad estándar";
  const slug = fallbackLabel
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return {
    packagingLabel: fallbackLabel,
    unitQuantity: 1,
    unitType: "unit",
    variantSlug: slug || "1unit",
    hasExplicitQuantityUnit: false,
  };
}

export function parseAvailabilityStatus(params: {
  readonly inStockFlag?: boolean;
  readonly availabilityText?: string;
}): AvailabilityStatus {
  if (params.inStockFlag === true) {
    return "IN_STOCK";
  }
  if (params.inStockFlag === false) {
    return "OUT_OF_STOCK";
  }
  const text = (params.availabilityText ?? "").trim().toLowerCase();
  if (!text) {
    return "UNKNOWN";
  }
  if (
    text.includes("agotado") ||
    text.includes("sin stock") ||
    text.includes("no disponible")
  ) {
    return "OUT_OF_STOCK";
  }
  if (text.includes("pocas unidades") || text.includes("últimas")) {
    return "LOW_STOCK";
  }
  if (
    text.includes("agregar") ||
    text.includes("añadir") ||
    text.includes("disponible") ||
    text.includes("en stock")
  ) {
    return "IN_STOCK";
  }
  return "UNKNOWN";
}

function extractCardsFromNextData(nextDataJson: string): {
  readonly storeId?: string;
  readonly storeName?: string;
  readonly detectedCityName?: string;
  readonly cards: RawDomProductCard[];
} {
  const parsed = JSON.parse(nextDataJson) as Record<string, unknown>;
  const props = (parsed.props as Record<string, unknown> | undefined) ?? {};
  const pageProps = (props.pageProps as Record<string, unknown> | undefined) ?? {};

  const storeContext =
    (pageProps.storeContext as Record<string, unknown> | undefined) ?? {};
  const seoStore = (pageProps.seoStore as Record<string, unknown> | undefined) ?? {};

  const storeId =
    storeContext.store_id !== undefined
      ? String(storeContext.store_id)
      : typeof pageProps.seoFriendlyUrl === "string"
        ? pageProps.seoFriendlyUrl
        : undefined;
  const storeName =
    typeof pageProps.storeName === "string"
      ? pageProps.storeName
      : typeof storeContext.name === "string"
        ? storeContext.name
        : undefined;
  const detectedCityName = typeof seoStore.city === "string" ? seoStore.city : undefined;

  const fallback = (pageProps.fallback as Record<string, unknown> | undefined) ?? {};
  const cards: RawDomProductCard[] = [];

  for (const key of Object.keys(fallback)) {
    const entry = fallback[key] as Record<string, unknown> | undefined;
    const homeResp =
      (entry?.store_home_response as Record<string, unknown> | undefined) ?? {};
    const data = (homeResp.data as Record<string, unknown> | undefined) ?? {};
    const components = Array.isArray(data.components) ? data.components : [];

    for (const comp of components) {
      const resource =
        ((comp as Record<string, unknown>)?.resource as
          Record<string, unknown> | undefined) ?? {};
      const products = Array.isArray(resource.products) ? resource.products : [];
      for (const rawProd of products) {
        const p = rawProd as Record<string, unknown>;
        const masterId =
          p.master_product_id !== undefined
            ? String(p.master_product_id)
            : p.product_id !== undefined
              ? String(p.product_id)
              : p.id !== undefined
                ? String(p.id)
                : undefined;
        const name = typeof p.name === "string" ? p.name.trim() : undefined;
        const brand = typeof p.trademark === "string" ? p.trademark.trim() : undefined;
        const priceNum = typeof p.price === "number" ? p.price : undefined;
        const realPriceNum = typeof p.real_price === "number" ? p.real_price : undefined;
        const hasDeclaredDiscount =
          realPriceNum !== undefined && priceNum !== undefined && realPriceNum > priceNum;
        const qty =
          p.quantity !== undefined && typeof p.unit_type === "string"
            ? `${String(p.quantity)} ${p.unit_type}`
            : typeof p.presentation === "string"
              ? p.presentation
              : undefined;
        const inStock =
          typeof p.in_stock === "boolean"
            ? p.in_stock
            : typeof p.is_available === "boolean"
              ? p.is_available
              : undefined;
        const slug =
          name && masterId
            ? `/p/${name
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")}-${masterId}`
            : undefined;

        cards.push({
          ...(masterId !== undefined ? { externalId: masterId } : {}),
          ...(name ? { name, nameSource: "NEXT_DATA_SSR" as const } : {}),
          ...(brand ? { brand, brandSource: "NEXT_DATA_SSR" as const } : {}),
          ...(priceNum !== undefined
            ? { priceText: String(priceNum), priceSource: "NEXT_DATA_SSR" as const }
            : {}),
          ...(hasDeclaredDiscount ? { referencePriceText: String(realPriceNum) } : {}),
          ...(qty !== undefined ? { packagingText: qty } : {}),
          ...(inStock !== undefined ? { inStockFlag: inStock } : {}),
          ...(slug !== undefined ? { href: slug } : {}),
        });
      }
    }
  }

  return {
    ...(storeId !== undefined ? { storeId } : {}),
    ...(storeName !== undefined ? { storeName } : {}),
    ...(detectedCityName !== undefined ? { detectedCityName } : {}),
    cards,
  };
}

function buildMissingGeographicEvidenceList(
  geoValidation: SanitizedGeographicValidation,
): readonly string[] {
  const missing: string[] = [];
  const eb = geoValidation.evidenceBreakdown;

  if (eb.activeAddressSelection !== "VERIFIED_ACTIVE_SELECTION") {
    missing.push(
      `Active delivery address header (${eb.activeAddressSelection}): No non-placeholder address label was detected in the visible header.`,
    );
  }
  if (eb.pricingVerificationVerdict === "UNVERIFIED_MISSING_HMAC_SECRET") {
    missing.push(
      "Context HMAC secret (F-P1-01): Missing or weak PRICERADAR_CONTEXT_HMAC_SECRET / ~/.local/share/priceradar/context-hmac.key.",
    );
  }
  if (eb.cityAndNeighborhoodMetadata !== "VERIFIED_FROM_ACTIVE_CONTEXT") {
    missing.push(
      `City/neighborhood metadata (${eb.cityAndNeighborhoodMetadata}): UI only exposed static SEO city metadata (#__NEXT_DATA__.props.pageProps.seoStore.city) or omitted active context city metadata.`,
    );
  }
  if (eb.servingStoreBranch !== "VERIFIED_BRANCH_SERVING_CONTEXT") {
    missing.push(
      `Serving store branch (${eb.servingStoreBranch}): Storefront URL/SSR exposes store identity, but Rappi's DOM does not expose an explicit attribute proving this branch is bound to the selected header address.`,
    );
  }
  if (eb.productCatalogContext !== "VERIFIED_CONTEXT_BOUND_CATALOG") {
    missing.push(
      `Product catalog context (${eb.productCatalogContext}): Rendered product cards could not be independently proven bound to the active delivery address in DOM HTML.`,
    );
  }

  return missing;
}

/**
 * Evaluates a read-only storefront snapshot captured from an owner-supervised
 * Playwright Chromium page, enforcing all safety, keyed-HMAC privacy (`F-P1-01`),
 * 5-layer fulfillment-context validation (`F-P1-02`), and integer-COP invariants.
 */
export function inspectStorefrontSnapshot(
  snapshot: RawStorefrontSnapshot,
): StorefrontInspectionReport {
  const titleAndUrl = `${snapshot.pageTitle ?? ""} ${snapshot.pageUrl}`;
  const isChallenge =
    snapshot.hasSecurityChallenge === true ||
    CHALLENGE_PATTERNS.some((re) => re.test(titleAndUrl));

  let effectiveStoreId = snapshot.storeId?.trim();
  let effectiveStoreName = snapshot.storeName?.trim();
  let effectiveCityName = snapshot.detectedCityName?.trim();
  let effectiveCityMetadataSource = snapshot.cityMetadataSource;
  let effectiveCatalogSource = snapshot.catalogSource;
  let rawInputCards: readonly RawDomProductCard[] = snapshot.rawCards ?? [];

  if (snapshot.nextDataJson) {
    try {
      const extracted = extractCardsFromNextData(snapshot.nextDataJson);
      if (
        extracted.cards.length > 0 &&
        (rawInputCards.length === 0 ||
          effectiveCatalogSource === "STATIC_NEXT_DATA_FALLBACK")
      ) {
        rawInputCards = extracted.cards;
        effectiveCatalogSource = "STATIC_NEXT_DATA_FALLBACK";
      }
      if (!effectiveStoreId && extracted.storeId) {
        effectiveStoreId = extracted.storeId;
      }
      if (!effectiveStoreName && extracted.storeName) {
        effectiveStoreName = extracted.storeName;
      }
      if (!effectiveCityName && extracted.detectedCityName) {
        effectiveCityName = extracted.detectedCityName;
        effectiveCityMetadataSource = "STATIC_SEO_METADATA";
      }
    } catch {
      // Fall through to DOM rawCards
    }
  }

  const urlStoreMatch = snapshot.pageUrl.match(/\/tiendas\/([^/?#]+)/i);
  const displayedStoreSlug = urlStoreMatch?.[1] ?? effectiveStoreId;
  if (!effectiveStoreId && displayedStoreSlug) {
    effectiveStoreId = displayedStoreSlug;
  }
  const displayedNumericStoreId = effectiveStoreId?.match(/^(\d+)/)?.[1];

  if (!effectiveCatalogSource && rawInputCards.length > 0) {
    effectiveCatalogSource = "UNVERIFIED_LIVE_DOM";
  }

  const geoValidation = validateGeographicDeliveryContext({
    ...(snapshot.hasActiveDeliverySelector !== undefined
      ? { hasActiveDeliverySelector: snapshot.hasActiveDeliverySelector }
      : {}),
    ...(snapshot.rawDeliveryHeaderLabel !== undefined
      ? { rawDeliveryHeaderLabel: snapshot.rawDeliveryHeaderLabel }
      : {}),
    ...(snapshot.contextHmacSecret !== undefined
      ? { contextHmacSecret: snapshot.contextHmacSecret }
      : {}),
    ...(snapshot.previousContextHmacSecret !== undefined
      ? { previousContextHmacSecret: snapshot.previousContextHmacSecret }
      : {}),
    ...(effectiveCityName !== undefined ? { detectedCityName: effectiveCityName } : {}),
    ...(effectiveCityMetadataSource !== undefined
      ? { cityMetadataSource: effectiveCityMetadataSource }
      : {}),
    ...(effectiveStoreId !== undefined ? { staticStoreId: effectiveStoreId } : {}),
    ...(snapshot.servingBranchId !== undefined
      ? { servingBranchId: snapshot.servingBranchId }
      : {}),
    ...(snapshot.isServingBranchVerifiedForContext !== undefined
      ? {
          isServingBranchVerifiedForContext: snapshot.isServingBranchVerifiedForContext,
        }
      : {}),
    ...(effectiveCatalogSource !== undefined
      ? { catalogSource: effectiveCatalogSource }
      : {}),
    ...(snapshot.openedFromAddressDirectoryContext !== undefined
      ? { openedFromAddressDirectoryContext: snapshot.openedFromAddressDirectoryContext }
      : {}),
    ...(snapshot.sanitizedNavigationPathHistory !== undefined
      ? { sanitizedNavigationPathHistory: snapshot.sanitizedNavigationPathHistory }
      : {}),
  });

  const missingGeographicEvidence = buildMissingGeographicEvidenceList(geoValidation);

  const emptyDiagnostics: StorefrontExtractionDiagnostics = {
    productCounts: {
      rawInputCandidates: rawInputCards.length,
      consolidatedUniqueCards: 0,
      completeVerifiedCards: 0,
      incompleteSkippedCards: 0,
      conflictingPriceCardsSkipped: 0,
    },
    duplicateCounts: {
      splitAnchorPairsMerged: 0,
      duplicateListingKeysSuppressed: 0,
      conflictingSameKeyCardsRejected: 0,
      suppressedListingKeys: [],
    },
    extractionSources: {
      name: {
        domHeading: 0,
        domAnchorText: 0,
        domImageAlt: 0,
        nextDataSsr: 0,
        missing: 0,
      },
      currentPrice: {
        domCardText: 0,
        nextDataSsr: 0,
        missingOrMalformed: 0,
      },
      brand: {
        domExplicit: 0,
        nextDataSsr: 0,
        missing: 0,
      },
    },
    storeAndBranchStatus: {
      ...(displayedStoreSlug !== undefined ? { displayedStoreSlug } : {}),
      ...(displayedNumericStoreId !== undefined ? { displayedNumericStoreId } : {}),
      ...(snapshot.servingBranchId !== undefined
        ? { servingBranchId: snapshot.servingBranchId }
        : {}),
      branchVerificationStatus: geoValidation.evidenceBreakdown.servingStoreBranch,
      associations: {
        activeDeliveryAddressDetected:
          geoValidation.evidenceBreakdown.activeAddressSelection ===
          "VERIFIED_ACTIVE_SELECTION",
        storefrontCurrentlyDisplayed: Boolean(effectiveStoreId),
        branchServingSelectedAddressVerified:
          geoValidation.evidenceBreakdown.servingStoreBranch ===
          "VERIFIED_BRANCH_SERVING_CONTEXT",
        catalogDemonstrablyLoadedForAddressVerified:
          geoValidation.evidenceBreakdown.productCatalogContext ===
          "VERIFIED_CONTEXT_BOUND_CATALOG",
      },
    },
    missingGeographicEvidence,
  };

  if (isChallenge) {
    return {
      gateStatus: "CHALLENGE_DETECTED",
      gateMessage:
        "Security/WAF/CAPTCHA challenge detected on the page. Observation stopped immediately without retry or bypass.",
      pageUrl: snapshot.pageUrl,
      observedAtIso: snapshot.observedAtIso,
      geographicValidation: geoValidation,
      fieldVerification: [],
      diagnostics: emptyDiagnostics,
      listings: [],
      skippedMalformedCount: 0,
      duplicateSuppressedCount: 0,
    };
  }

  if (snapshot.isLoginRequired === true) {
    return {
      gateStatus: "AUTH_REQUIRED",
      gateMessage:
        "Authentication required. Please log in manually in the visible Chromium window outside agent control.",
      pageUrl: snapshot.pageUrl,
      observedAtIso: snapshot.observedAtIso,
      geographicValidation: geoValidation,
      fieldVerification: [],
      diagnostics: emptyDiagnostics,
      listings: [],
      skippedMalformedCount: 0,
      duplicateSuppressedCount: 0,
    };
  }

  // Consolidate split image-anchor + title-anchor pairs before evaluating cards
  const {
    consolidatedCards: rawCards,
    splitAnchorPairsMerged,
    conflictingPriceCardsSkipped,
  } = consolidateDomProductCardCandidates(rawInputCards);

  if (rawCards.length === 0 || !effectiveStoreId) {
    if (
      geoValidation.evidenceBreakdown.activeAddressSelection !==
      "VERIFIED_ACTIVE_SELECTION"
    ) {
      return {
        gateStatus: "MISSING_DELIVERY_CONTEXT",
        gateMessage: geoValidation.statusReason,
        pageUrl: snapshot.pageUrl,
        observedAtIso: snapshot.observedAtIso,
        geographicValidation: geoValidation,
        fieldVerification: [],
        diagnostics: {
          ...emptyDiagnostics,
          productCounts: {
            ...emptyDiagnostics.productCounts,
            conflictingPriceCardsSkipped,
            incompleteSkippedCards: conflictingPriceCardsSkipped,
          },
          duplicateCounts: {
            ...emptyDiagnostics.duplicateCounts,
            splitAnchorPairsMerged,
          },
        },
        listings: [],
        skippedMalformedCount: conflictingPriceCardsSkipped,
        duplicateSuppressedCount: 0,
      };
    }

    return {
      gateStatus: "UNSUPPORTED_DOM_STRUCTURE",
      gateMessage:
        "No recognizable storefront product cards or store identity found on the current page. DOM structure may have changed or is not a storefront corridor.",
      pageUrl: snapshot.pageUrl,
      observedAtIso: snapshot.observedAtIso,
      geographicValidation: geoValidation,
      fieldVerification: [],
      diagnostics: {
        ...emptyDiagnostics,
        productCounts: {
          ...emptyDiagnostics.productCounts,
          conflictingPriceCardsSkipped,
          incompleteSkippedCards: conflictingPriceCardsSkipped,
        },
        duplicateCounts: {
          ...emptyDiagnostics.duplicateCounts,
          splitAnchorPairsMerged,
        },
      },
      listings: [],
      skippedMalformedCount: conflictingPriceCardsSkipped,
      duplicateSuppressedCount: 0,
    };
  }

  const totalCards = rawCards.length;
  let idCount = 0;
  let nameCount = 0;
  let brandCount = 0;
  let priceCount = 0;
  let refPriceCount = 0;
  let packagingCount = 0;
  let availabilityCount = 0;
  let urlCount = 0;

  let nameDomHeadingCount = 0;
  let nameDomAnchorCount = 0;
  let nameDomImageAltCount = 0;
  let nameNextDataCount = 0;
  let nameMissingCount = 0;

  let priceDomCount = 0;
  let priceNextDataCount = 0;
  let priceMissingOrMalformedCount = 0;

  let brandDomCount = 0;
  let brandNextDataCount = 0;
  let brandMissingCount = 0;

  let skippedMalformedCount = conflictingPriceCardsSkipped;
  let duplicateSuppressedCount = 0;
  let conflictingSameKeyCardsRejected = 0;
  const suppressedListingKeys: string[] = [];
  const seenListingsByKey = new Map<string, DiscoveredListing>();
  const conflictedListingKeys = new Set<string>();
  const listings: DiscoveredListing[] = [];

  const canonicalStoreIdentifier =
    geoValidation.evidenceBreakdown.servingStoreBranch ===
      "VERIFIED_BRANCH_SERVING_CONTEXT" &&
    geoValidation.evidenceBreakdown.servingStoreBranchId
      ? geoValidation.evidenceBreakdown.servingStoreBranchId
      : effectiveStoreId;

  const geographicContext: GeographicContext = {
    countryCode: "CO",
    citySlug: geoValidation.citySlug,
    cityName: geoValidation.cityName,
    ...(geoValidation.fulfillmentContextHash !== undefined
      ? { zoneCode: geoValidation.fulfillmentContextHash }
      : {}),
  };

  const observationProvenance = classifyObservationProvenance(geoValidation);

  for (const card of rawCards) {
    const cleanName = card.name?.trim();
    const cleanHref = card.href?.trim();
    const derivedIdFromHref = cleanHref?.match(/-(\d+)(?:[/?#]|$)/)?.[1];
    const cleanId = card.externalId?.trim() || derivedIdFromHref;
    const cleanBrand = card.brand?.trim();
    const parsedPrice = parseCopPriceText(card.priceText);
    const parsedRefPrice = parseCopPriceText(card.referencePriceText);
    const hasValidRefPrice =
      parsedRefPrice !== undefined &&
      parsedPrice !== undefined &&
      parsedRefPrice > parsedPrice;

    const packaging = parsePackagingVariant(card.packagingText, cleanName ?? "");
    const availability = parseAvailabilityStatus({
      ...(card.inStockFlag !== undefined ? { inStockFlag: card.inStockFlag } : {}),
      ...(card.availabilityText !== undefined
        ? { availabilityText: card.availabilityText }
        : {}),
    });

    if (cleanId) idCount += 1;
    if (cleanName) {
      nameCount += 1;
      if (card.nameSource === "NEXT_DATA_SSR") nameNextDataCount += 1;
      else if (card.nameSource === "DOM_IMAGE_ALT") nameDomImageAltCount += 1;
      else if (card.nameSource === "DOM_ANCHOR_TEXT") nameDomAnchorCount += 1;
      else nameDomHeadingCount += 1;
    } else {
      nameMissingCount += 1;
    }

    if (cleanBrand) {
      brandCount += 1;
      if (card.brandSource === "NEXT_DATA_SSR") brandNextDataCount += 1;
      else brandDomCount += 1;
    } else {
      brandMissingCount += 1;
    }

    if (parsedPrice !== undefined) {
      priceCount += 1;
      if (card.priceSource === "NEXT_DATA_SSR") priceNextDataCount += 1;
      else priceDomCount += 1;
    } else {
      priceMissingOrMalformedCount += 1;
    }

    if (hasValidRefPrice) refPriceCount += 1;
    if (packaging.hasExplicitQuantityUnit || Boolean(card.packagingText?.trim())) {
      packagingCount += 1;
    }
    if (availability !== "UNKNOWN") availabilityCount += 1;
    if (cleanHref) urlCount += 1;

    // A valid normalized listing requires product identity, name, valid integer COP price, and canonical product URL
    if (!cleanId || !cleanName || parsedPrice === undefined || !cleanHref) {
      skippedMalformedCount += 1;
      continue;
    }

    // Task B: When a card has no explicit unit quantity or packaging label (falling back to "unidad-estandar"),
    // include a normalized name disambiguator so distinct unit-less presentations sharing a base product ID never merge.
    const unitlessNameDisambiguator =
      !packaging.hasExplicitQuantityUnit && !card.packagingText?.trim()
        ? `-${cleanName
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32)}`
        : "";
    const externalVariantId = `${cleanId}-${packaging.variantSlug}${unitlessNameDisambiguator}`;

    const listingKey = buildCanonicalListingKey({
      providerId: RAPPI_BROWSER_PROVIDER_ID,
      externalStoreId: canonicalStoreIdentifier,
      externalProductId: cleanId,
      externalVariantId,
      citySlug: geoValidation.citySlug,
      ...(geoValidation.fulfillmentContextHash !== undefined
        ? { zoneCode: geoValidation.fulfillmentContextHash }
        : {}),
    });

    if (conflictedListingKeys.has(listingKey)) {
      conflictingSameKeyCardsRejected += 1;
      skippedMalformedCount += 1;
      continue;
    }

    const existingListing = seenListingsByKey.get(listingKey);
    if (existingListing) {
      const isIdenticalMultiCarouselDuplicate =
        existingListing.variant.externalProductId === cleanId &&
        existingListing.variant.externalVariantId === externalVariantId &&
        existingListing.store.externalStoreId === canonicalStoreIdentifier &&
        existingListing.geographicContext.zoneCode === geographicContext.zoneCode &&
        existingListing.observedPriceCop === parsedPrice &&
        existingListing.variant.name.trim().toLowerCase() === cleanName.toLowerCase();

      if (isIdenticalMultiCarouselDuplicate) {
        duplicateSuppressedCount += 1;
        suppressedListingKeys.push(listingKey);
        continue;
      }

      // Task B: Conflicting price or identity on the same canonical listingKey must NEVER be merged silently.
      // Remove the earlier listing and reject both cards as a same-key conflict.
      const existingIdx = listings.indexOf(existingListing);
      if (existingIdx !== -1) {
        listings.splice(existingIdx, 1);
      }
      seenListingsByKey.delete(listingKey);
      conflictedListingKeys.add(listingKey);
      conflictingSameKeyCardsRejected += 2;
      skippedMalformedCount += 2;
      continue;
    }

    const canonicalUrl = cleanHref.startsWith("http")
      ? cleanHref
      : `https://www.rappi.com.co${cleanHref.startsWith("/") ? "" : "/"}${cleanHref}`;

    const candidateListing: DiscoveredListing = {
      providerId: RAPPI_BROWSER_PROVIDER_ID,
      store: {
        providerId: RAPPI_BROWSER_PROVIDER_ID,
        externalStoreId: canonicalStoreIdentifier,
        name: effectiveStoreName || canonicalStoreIdentifier,
        categorySlug: snapshot.categorySlug ?? "supermercado",
      },
      variant: {
        externalProductId: cleanId,
        externalVariantId,
        name: cleanName,
        brand: cleanBrand || "Sin marca especificada",
        categorySlug: snapshot.categorySlug ?? "supermercado",
        categoryName: "Supermercado",
        packagingLabel: packaging.packagingLabel,
        unitQuantity: packaging.unitQuantity,
        unitType: packaging.unitType,
        productUrl: canonicalUrl,
      },
      geographicContext,
      observedPriceCop: parsedPrice,
      ...(hasValidRefPrice ? { declaredReferencePriceCop: parsedRefPrice } : {}),
      availability,
      provenance: observationProvenance,
      sourceObservedAt: snapshot.observedAtIso,
    };

    seenListingsByKey.set(listingKey, candidateListing);
    listings.push(candidateListing);
  }

  const classifyField = (count: number, optional = false): FieldVerificationStatus => {
    if (count === totalCards && totalCards > 0) return "VERIFIED";
    if (count > 0) return "PARTIAL";
    return optional ? "UNSUPPORTED" : "MISSING";
  };

  const fieldVerification: FieldVerificationEntry[] = [
    {
      field: "productIdentity",
      status: classifyField(idCount),
      verifiedCount: idCount,
      totalEvaluated: totalCards,
      notes:
        "Extracted from product permalink ID or hydrated product_id / master_product_id.",
    },
    {
      field: "name",
      status: classifyField(nameCount),
      verifiedCount: nameCount,
      totalEvaluated: totalCards,
      notes: `Extracted from rendered product title (heading: ${String(nameDomHeadingCount)}, anchor: ${String(nameDomAnchorCount)}, imgAlt: ${String(nameDomImageAltCount)}, ssr: ${String(nameNextDataCount)}, missing: ${String(nameMissingCount)}).`,
    },
    {
      field: "brand",
      status: classifyField(brandCount, true),
      verifiedCount: brandCount,
      totalEvaluated: totalCards,
      notes:
        "Present in SSR state (`trademark`), omitted in compact DOM cards (never fabricated).",
    },
    {
      field: "currentPriceCop",
      status: classifyField(priceCount),
      verifiedCount: priceCount,
      totalEvaluated: totalCards,
      notes: "Validated as positive safe integer CopAmount (PUM unit prices stripped).",
    },
    {
      field: "referencePriceCop",
      status: classifyField(refPriceCount, true),
      verifiedCount: refPriceCount,
      totalEvaluated: totalCards,
      notes:
        "Counted only on discounted items where strikethrough referencePriceCop > currentPriceCop.",
    },
    {
      field: "packagingAndVariant",
      status: classifyField(packagingCount, true),
      verifiedCount: packagingCount,
      totalEvaluated: totalCards,
      notes:
        "Parsed from explicit presentation label or title quantity after stripping Colombian PUM unit-price strings.",
    },
    {
      field: "storeIdentity",
      status: canonicalStoreIdentifier ? "VERIFIED" : "MISSING",
      verifiedCount: canonicalStoreIdentifier ? totalCards : 0,
      totalEvaluated: totalCards,
      notes: `Store ID: ${canonicalStoreIdentifier} (branch verification: ${geoValidation.evidenceBreakdown.servingStoreBranch})`,
    },
    {
      field: "availability",
      status: classifyField(availabilityCount, true),
      verifiedCount: availabilityCount,
      totalEvaluated: totalCards,
      notes:
        "Determined from explicit Agregar/Agotado DOM control or SSR in_stock boolean (UNKNOWN when absent).",
    },
    {
      field: "productUrl",
      status: classifyField(urlCount),
      verifiedCount: urlCount,
      totalEvaluated: totalCards,
      notes: "Canonical /p/{slug}-{id} product URL.",
    },
  ];

  const totalConflictingPriceCardsSkipped =
    conflictingPriceCardsSkipped + conflictingSameKeyCardsRejected;

  const populatedDiagnostics: StorefrontExtractionDiagnostics = {
    productCounts: {
      rawInputCandidates: rawInputCards.length,
      consolidatedUniqueCards: totalCards,
      completeVerifiedCards: listings.length,
      incompleteSkippedCards: skippedMalformedCount,
      conflictingPriceCardsSkipped: totalConflictingPriceCardsSkipped,
    },
    duplicateCounts: {
      splitAnchorPairsMerged,
      duplicateListingKeysSuppressed: duplicateSuppressedCount,
      conflictingSameKeyCardsRejected,
      suppressedListingKeys,
    },
    extractionSources: {
      name: {
        domHeading: nameDomHeadingCount,
        domAnchorText: nameDomAnchorCount,
        domImageAlt: nameDomImageAltCount,
        nextDataSsr: nameNextDataCount,
        missing: nameMissingCount,
      },
      currentPrice: {
        domCardText: priceDomCount,
        nextDataSsr: priceNextDataCount,
        missingOrMalformed: priceMissingOrMalformedCount,
      },
      brand: {
        domExplicit: brandDomCount,
        nextDataSsr: brandNextDataCount,
        missing: brandMissingCount,
      },
    },
    storeAndBranchStatus: emptyDiagnostics.storeAndBranchStatus,
    missingGeographicEvidence,
  };

  if (!geoValidation.isDeliveryContextVerified) {
    const isMissingAddressOrSecret =
      geoValidation.evidenceBreakdown.activeAddressSelection !==
        "VERIFIED_ACTIVE_SELECTION" ||
      geoValidation.evidenceBreakdown.pricingVerificationVerdict ===
        "UNVERIFIED_MISSING_HMAC_SECRET";

    // Task C: When provisional session observations are explicitly enabled and the 3 session-navigation
    // states (`ADDRESS_SELECTED`, `STORE_OPENED_FROM_ADDRESS_CONTEXT`, `CATALOG_VISIBLE_IN_SESSION`) hold,
    // emit in-memory listings tagged strictly as `PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL` while
    // keeping `ADDRESS_SPECIFIC_PRICING_VERIFIED: false`.
    if (
      snapshot.allowProvisionalSessionObservations === true &&
      observationProvenance === "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" &&
      listings.length > 0
    ) {
      return {
        gateStatus: "OK",
        gateMessage: `Normalized ${String(listings.length)} provisional private session listings (PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL). ADDRESS_SPECIFIC_PRICING_VERIFIED remains false.`,
        pageUrl: snapshot.pageUrl,
        observedAtIso: snapshot.observedAtIso,
        geographicValidation: geoValidation,
        fieldVerification,
        diagnostics: populatedDiagnostics,
        listings,
        skippedMalformedCount,
        duplicateSuppressedCount,
      };
    }

    return {
      gateStatus: isMissingAddressOrSecret
        ? "MISSING_DELIVERY_CONTEXT"
        : "UNVERIFIED_FULFILLMENT_CONTEXT",
      gateMessage: geoValidation.statusReason,
      pageUrl: snapshot.pageUrl,
      observedAtIso: snapshot.observedAtIso,
      geographicValidation: geoValidation,
      fieldVerification,
      diagnostics: populatedDiagnostics,
      listings: [],
      skippedMalformedCount,
      duplicateSuppressedCount,
    };
  }

  if (listings.length === 0) {
    return {
      gateStatus: "UNSUPPORTED_DOM_STRUCTURE",
      gateMessage:
        "Product cards were found, but zero cards contained the minimum required valid fields (ID, name, integer COP price, and product URL).",
      pageUrl: snapshot.pageUrl,
      observedAtIso: snapshot.observedAtIso,
      geographicValidation: geoValidation,
      fieldVerification,
      diagnostics: populatedDiagnostics,
      listings: [],
      skippedMalformedCount,
      duplicateSuppressedCount,
    };
  }

  return {
    gateStatus: "OK",
    gateMessage: `Successfully normalized ${String(listings.length)} private in-memory listings with verified fulfillment-context association.`,
    pageUrl: snapshot.pageUrl,
    observedAtIso: snapshot.observedAtIso,
    geographicValidation: geoValidation,
    fieldVerification,
    diagnostics: populatedDiagnostics,
    listings,
    skippedMalformedCount,
    duplicateSuppressedCount,
  };
}

/**
 * Read-only, in-memory `CatalogProvider` adapter wrapping a single owner-supervised
 * browser storefront snapshot so it can be evaluated directly by `@priceradar/worker`
 * and `@priceradar/domain` without any network crawling or external database writes.
 */
export class SupervisedBrowserSnapshotProvider implements CatalogProvider {
  public readonly id = RAPPI_BROWSER_PROVIDER_ID;
  public readonly displayName =
    "Rappi Colombia (Inspección Manual Supervisada — Privado)";
  private readonly report: StorefrontInspectionReport;
  private readonly seedHistory: readonly PriceObservationRecord[];

  public constructor(
    snapshot: RawStorefrontSnapshot,
    seedHistory: readonly PriceObservationRecord[] = [],
  ) {
    this.report = inspectStorefrontSnapshot(snapshot);
    this.seedHistory = seedHistory;
  }

  public getInspectionReport(): StorefrontInspectionReport {
    return this.report;
  }

  public getCapabilities(): ProviderCapabilities {
    return {
      supportsCatalogExploration: false,
      supportsCategoryDiscovery: false,
      supportsPagination: false,
      supportsStoreSpecificListings: true,
      supportsStableProductIdentity: true,
      supportsProductVariants: true,
      supportsDeclaredReferencePrice: true,
      supportsAvailabilityStatus: true,
      supportsGeographicContext:
        this.report.geographicValidation.isDeliveryContextVerified,
      supportsProductImages: false,
      supportsSourceTimestamps: true,
      isSimulatedFixture: false,
    };
  }

  public getDefaultTargets(): readonly DiscoveryTarget[] {
    const first = this.report.listings[0];
    return [
      {
        targetId: "supervised-browser-current-page",
        providerId: this.id,
        storeId: first?.store.externalStoreId ?? "unknown-store",
        categorySlug: first?.store.categorySlug ?? "supermercado",
        geographicContext: first?.geographicContext ?? {
          countryCode: "CO",
          citySlug: this.report.geographicValidation.citySlug,
          cityName: this.report.geographicValidation.cityName,
        },
        enabled: this.report.gateStatus === "OK",
        priority: 1,
      },
    ];
  }

  public getSeedHistoricalObservations(): readonly PriceObservationRecord[] {
    return this.seedHistory;
  }

  public async discover(
    target: DiscoveryTarget,
    options: DiscoveryOptions = {},
  ): Promise<DiscoveryResult> {
    if (this.report.gateStatus !== "OK") {
      throw new Error(`[${this.report.gateStatus}] ${this.report.gateMessage}`);
    }

    const nowIso = options.nowIso ?? this.report.observedAtIso;
    return {
      providerId: this.id,
      targetId: target.targetId,
      listings: this.report.listings,
      hasMore: false,
      fetchedAt: nowIso,
      totalAvailableInTarget: this.report.listings.length,
    };
  }
}
