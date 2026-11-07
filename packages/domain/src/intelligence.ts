import type {
  ConfidenceLevel,
  DiscoveredListing,
  OpportunityCandidate,
  OpportunityType,
  PriceObservationRecord,
} from "./entities.ts";
import { buildCanonicalListingKey } from "./entities.ts";
import { OPPORTUNITY_LABELS_ES_CO } from "./localization.ts";
import type { CopAmount } from "./money.ts";
import {
  basisPointsToPercentage,
  calculateDiscountBasisPoints,
  createCopAmount,
  formatCop,
} from "./money.ts";

export interface PriceIntelligenceConfig {
  /** Minimum declared discount in basis points (e.g., 1500 = 15%) */
  readonly minDeclaredDiscountBps: number;
  /** Minimum historical drop vs median in basis points (e.g., 1500 = 15%) */
  readonly minHistoricalDropBps: number;
  /** Minimum historical low improvement vs median in basis points (e.g., 1000 = 10%) */
  readonly minHistoricalLowBps: number;
  /** Minimum anomaly drop vs median in basis points (e.g., 4500 = 45%) */
  readonly minAnomalyDropBps: number;
  /** Minimum prior observations required before evaluating HISTORICAL_DROP or HISTORICAL_LOW */
  readonly minHistoryForDrop: number;
  /** Minimum prior observations required before evaluating POTENTIAL_ANOMALY */
  readonly minHistoryForAnomaly: number;
  /** Maximum age of prior observations in days to be considered fresh baseline */
  readonly maxBaselineAgeDays: number;
  /** Cooldown window in minutes to suppress duplicate opportunity alerts for the same listing & price */
  readonly cooldownMinutes: number;
}

export const DEFAULT_PRICE_INTELLIGENCE_CONFIG: PriceIntelligenceConfig = {
  minDeclaredDiscountBps: 1500, // 15%
  minHistoricalDropBps: 1500, // 15%
  minHistoricalLowBps: 1000, // 10%
  minAnomalyDropBps: 4500, // 45%
  minHistoryForDrop: 3,
  minHistoryForAnomaly: 5,
  maxBaselineAgeDays: 45,
  cooldownMinutes: 120,
};

/**
 * Computes the deterministic integer median of a non-empty list of COP prices.
 * Uses integer floor division for even-length arrays to maintain strict integer COP invariants.
 */
export function computeMedianCop(prices: readonly CopAmount[]): CopAmount {
  if (prices.length === 0) {
    throw new Error("Cannot compute median of an empty price list.");
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const value = sorted[mid];
    if (value === undefined) {
      throw new Error("Unexpected undefined median element.");
    }
    return value;
  }
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) {
    throw new Error("Unexpected undefined median pair.");
  }
  return createCopAmount(Math.round((left + right) / 2));
}

export function computeMinCop(prices: readonly CopAmount[]): CopAmount {
  if (prices.length === 0) {
    throw new Error("Cannot compute minimum of an empty price list.");
  }
  let min = prices[0];
  if (min === undefined) {
    throw new Error("Unexpected undefined first price.");
  }
  for (let i = 1; i < prices.length; i += 1) {
    const current = prices[i];
    if (current !== undefined && current < min) {
      min = current;
    }
  }
  return min;
}

function determineConfidence(priorCount: number, type: OpportunityType): ConfidenceLevel {
  if (type === "DECLARED_DISCOUNT") {
    return priorCount >= 3 ? "MEDIUM" : "LOW";
  }
  if (priorCount >= 8) {
    return "HIGH";
  }
  if (priorCount >= 4) {
    return "MEDIUM";
  }
  return "LOW";
}

export interface EvaluateListingInput {
  readonly listing: DiscoveredListing;
  /**
   * All stored historical observations for this exact store + variant + city listing.
   * Any observation matching the current `sourceObservedAt` timestamp is excluded
   * so the baseline never includes the current observation.
   */
  readonly historicalObservations: readonly PriceObservationRecord[];
  readonly existingOpportunities?: readonly OpportunityCandidate[];
  readonly config?: PriceIntelligenceConfig;
  readonly evaluationTimeIso?: string;
}

/**
 * Deterministically evaluates a discovered listing against its historical observations
 * and returns classified OpportunityCandidates.
 *
 * Enforces:
 * - Store-aware and variant-aware comparisons (rejects mismatched listing keys)
 * - Baseline strictly excludes current observation
 * - Out-of-stock listings never generate active purchase opportunities
 * - Sparse history cannot trigger POTENTIAL_ANOMALY or HISTORICAL_DROP
 * - Cooldown & deduplication against existing opportunities
 */
export function evaluateListingOpportunities(
  input: EvaluateListingInput,
): OpportunityCandidate[] {
  const config = input.config ?? DEFAULT_PRICE_INTELLIGENCE_CONFIG;
  const nowIso = input.evaluationTimeIso ?? input.listing.sourceObservedAt;
  const nowMs = Date.parse(nowIso);

  if (
    input.listing.availability === "OUT_OF_STOCK" ||
    input.listing.availability === "UNKNOWN"
  ) {
    return [];
  }

  const listingKey = buildCanonicalListingKey({
    providerId: input.listing.providerId,
    externalStoreId: input.listing.store.externalStoreId,
    externalProductId: input.listing.variant.externalProductId,
    externalVariantId: input.listing.variant.externalVariantId,
    citySlug: input.listing.geographicContext.citySlug,
    ...(input.listing.geographicContext.zoneCode !== undefined
      ? { zoneCode: input.listing.geographicContext.zoneCode }
      : {}),
  });

  const maxAgeMs = config.maxBaselineAgeDays * 24 * 60 * 60 * 1000;

  // Filter strictly to matching listingKey, matching provenance, strictly prior to current observation, and within freshness window
  const priorObservations = input.historicalObservations.filter((obs) => {
    if (obs.listingKey !== listingKey) {
      return false;
    }
    if (obs.provenance !== input.listing.provenance) {
      return false;
    }
    if (obs.observedAt === input.listing.sourceObservedAt) {
      return false;
    }
    const obsMs = Date.parse(obs.observedAt);
    if (Number.isNaN(obsMs) || obsMs >= Date.parse(input.listing.sourceObservedAt)) {
      return false;
    }
    if (!Number.isNaN(nowMs) && nowMs - obsMs > maxAgeMs) {
      return false;
    }
    return true;
  });

  const priorPrices = priorObservations.map((obs) => obs.observedPriceCop);
  const priorCount = priorPrices.length;
  const currentPrice = input.listing.observedPriceCop;

  const candidates: OpportunityCandidate[] = [];

  const isDuplicateWithinCooldown = (type: OpportunityType): boolean => {
    if (!input.existingOpportunities || input.existingOpportunities.length === 0) {
      return false;
    }
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    return input.existingOpportunities.some((existing) => {
      if (
        existing.listingKey !== listingKey ||
        existing.type !== type ||
        existing.observedPriceCop !== currentPrice
      ) {
        return false;
      }
      const existingMs = Date.parse(existing.detectedAt);
      if (Number.isNaN(existingMs) || Number.isNaN(nowMs)) {
        return true;
      }
      return Math.abs(nowMs - existingMs) <= cooldownMs;
    });
  };

  // 1. Evaluate historical opportunities if sufficient prior observations exist.
  // Historical tiers (POTENTIAL_ANOMALY > HISTORICAL_LOW > HISTORICAL_DROP) are mutually exclusive
  // so a single price drop emits at most one historical classification.
  if (priorCount >= config.minHistoryForDrop) {
    const medianCop = computeMedianCop(priorPrices);
    const minCop = computeMinCop(priorPrices);
    const dropVsMedianBps = calculateDiscountBasisPoints(currentPrice, medianCop);

    // Tier 1: POTENTIAL_ANOMALY (strictly requires >= minHistoryForAnomaly, >= minAnomalyDropBps, and new all-time low)
    if (
      priorCount >= config.minHistoryForAnomaly &&
      dropVsMedianBps >= config.minAnomalyDropBps &&
      currentPrice < minCop
    ) {
      const type: OpportunityType = "POTENTIAL_ANOMALY";
      if (!isDuplicateWithinCooldown(type)) {
        const savingsCop = createCopAmount(medianCop - currentPrice);
        const pct = basisPointsToPercentage(dropVsMedianBps);
        candidates.push({
          opportunityKey: `${listingKey}::${type}::${String(currentPrice)}`,
          listingKey,
          type,
          labelEsCo: OPPORTUNITY_LABELS_ES_CO[type],
          observedPriceCop: currentPrice,
          baselinePriceCop: medianCop,
          savingsCop,
          discountBasisPoints: dropVsMedianBps,
          discountPercentage: pct,
          historicalObservationCount: priorCount,
          historicalLowCop: minCop,
          historicalMedianCop: medianCop,
          confidence: determineConfidence(priorCount, type),
          requiresVerification: true,
          rationaleEsCo: `Precio observado (${formatCop(currentPrice)}) está ${String(pct)}% por debajo de la mediana histórica (${formatCop(medianCop)}) en ${String(priorCount)} observaciones previas. Requiere verificación en tienda.`,
          provenance: input.listing.provenance,
          detectedAt: nowIso,
        });
      }
    } else if (currentPrice < minCop && dropVsMedianBps >= config.minHistoricalLowBps) {
      // Tier 2: HISTORICAL_LOW (strictly lower than all prior observations and meaningful vs median, but below anomaly threshold)
      const type: OpportunityType = "HISTORICAL_LOW";
      if (!isDuplicateWithinCooldown(type)) {
        const savingsCop = createCopAmount(medianCop - currentPrice);
        const pct = basisPointsToPercentage(dropVsMedianBps);
        candidates.push({
          opportunityKey: `${listingKey}::${type}::${String(currentPrice)}`,
          listingKey,
          type,
          labelEsCo: OPPORTUNITY_LABELS_ES_CO[type],
          observedPriceCop: currentPrice,
          baselinePriceCop: medianCop,
          savingsCop,
          discountBasisPoints: dropVsMedianBps,
          discountPercentage: pct,
          historicalObservationCount: priorCount,
          historicalLowCop: minCop,
          historicalMedianCop: medianCop,
          confidence: determineConfidence(priorCount, type),
          requiresVerification: false,
          rationaleEsCo: `Nuevo mínimo registrado (${formatCop(currentPrice)}), superando el mínimo anterior de ${formatCop(minCop)} (${String(pct)}% bajo la mediana de ${formatCop(medianCop)}).`,
          provenance: input.listing.provenance,
          detectedAt: nowIso,
        });
      }
    } else if (dropVsMedianBps >= config.minHistoricalDropBps) {
      // Tier 3: HISTORICAL_DROP (meaningful decline vs historical median, even if not an all-time low)
      const type: OpportunityType = "HISTORICAL_DROP";
      if (!isDuplicateWithinCooldown(type)) {
        const savingsCop = createCopAmount(medianCop - currentPrice);
        const pct = basisPointsToPercentage(dropVsMedianBps);
        candidates.push({
          opportunityKey: `${listingKey}::${type}::${String(currentPrice)}`,
          listingKey,
          type,
          labelEsCo: OPPORTUNITY_LABELS_ES_CO[type],
          observedPriceCop: currentPrice,
          baselinePriceCop: medianCop,
          savingsCop,
          discountBasisPoints: dropVsMedianBps,
          discountPercentage: pct,
          historicalObservationCount: priorCount,
          historicalLowCop: minCop,
          historicalMedianCop: medianCop,
          confidence: determineConfidence(priorCount, type),
          requiresVerification: false,
          rationaleEsCo: `Reducción verificada del ${String(pct)}% frente a la mediana histórica (${formatCop(medianCop)}) calculada sobre ${String(priorCount)} observaciones.`,
          provenance: input.listing.provenance,
          detectedAt: nowIso,
        });
      }
    }
  }

  // 2. Evaluate DECLARED_DISCOUNT (provider-advertised reference price vs observed price)
  if (
    input.listing.declaredReferencePriceCop !== undefined &&
    input.listing.declaredReferencePriceCop > currentPrice
  ) {
    const declaredRef = input.listing.declaredReferencePriceCop;
    const declaredBps = calculateDiscountBasisPoints(currentPrice, declaredRef);

    // Protect against false positives: if we have prior history showing the product normally sells
    // at or below currentPrice, do not promote a misleading declared discount unless it's genuinely below median
    const isGenuineAgainstHistory =
      priorCount === 0 || computeMedianCop(priorPrices) > currentPrice;

    if (declaredBps >= config.minDeclaredDiscountBps && isGenuineAgainstHistory) {
      const type: OpportunityType = "DECLARED_DISCOUNT";
      if (!isDuplicateWithinCooldown(type)) {
        const savingsCop = createCopAmount(declaredRef - currentPrice);
        const pct = basisPointsToPercentage(declaredBps);
        const historicalLow = priorCount > 0 ? computeMinCop(priorPrices) : currentPrice;
        const historicalMedian =
          priorCount > 0 ? computeMedianCop(priorPrices) : declaredRef;

        candidates.push({
          opportunityKey: `${listingKey}::${type}::${String(currentPrice)}`,
          listingKey,
          type,
          labelEsCo: OPPORTUNITY_LABELS_ES_CO[type],
          observedPriceCop: currentPrice,
          baselinePriceCop: declaredRef,
          savingsCop,
          discountBasisPoints: declaredBps,
          discountPercentage: pct,
          historicalObservationCount: priorCount,
          historicalLowCop: historicalLow,
          historicalMedianCop: historicalMedian,
          confidence: determineConfidence(priorCount, type),
          requiresVerification: true,
          rationaleEsCo: `Descuento del ${String(pct)}% anunciado por la tienda respecto al precio de referencia declarado (${formatCop(declaredRef)}).`,
          provenance: input.listing.provenance,
          detectedAt: nowIso,
        });
      }
    }
  }

  return candidates;
}
