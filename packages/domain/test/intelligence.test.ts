import { describe, expect, it } from "vitest";
import type { DiscoveredListing, PriceObservationRecord } from "../src/index.ts";
import {
  buildCanonicalListingKey,
  calculateDiscountBasisPoints,
  compareObservationAgainstHistory,
  computeMedianCop,
  createCopAmount,
  evaluateListingOpportunities,
  formatCop,
  OPPORTUNITY_LABELS_ES_CO,
  PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
} from "../src/index.ts";

const SAMPLE_LISTING: DiscoveredListing = {
  providerId: "fixture-colombia",
  store: {
    providerId: "fixture-colombia",
    externalStoreId: "store-a",
    name: "Tienda A",
    categorySlug: "tecnologia",
  },
  variant: {
    externalProductId: "prod-100",
    externalVariantId: "var-500g",
    name: "Producto Prueba",
    brand: "MarcaCol",
    categorySlug: "tecnologia",
    categoryName: "Tecnología",
    packagingLabel: "500 g",
    unitQuantity: 500,
    unitType: "g",
    productUrl: "https://demo.priceradar.local/p/100",
  },
  geographicContext: {
    countryCode: "CO",
    citySlug: "bogota",
    cityName: "Bogotá D.C.",
  },
  observedPriceCop: createCopAmount(190_000),
  declaredReferencePriceCop: createCopAmount(400_000),
  availability: "IN_STOCK",
  provenance: "DEMO_FIXTURE",
  sourceObservedAt: "2026-11-07T12:00:00.000Z",
};

function makeObservation(
  priceCop: number,
  observedAt: string,
  overrides: Partial<PriceObservationRecord> = {},
): PriceObservationRecord {
  const listingKey = buildCanonicalListingKey({
    providerId: SAMPLE_LISTING.providerId,
    externalStoreId: SAMPLE_LISTING.store.externalStoreId,
    externalProductId: SAMPLE_LISTING.variant.externalProductId,
    externalVariantId: SAMPLE_LISTING.variant.externalVariantId,
    citySlug: SAMPLE_LISTING.geographicContext.citySlug,
  });

  return {
    observationId: `obs-${observedAt}`,
    listingKey,
    providerId: SAMPLE_LISTING.providerId,
    externalStoreId: SAMPLE_LISTING.store.externalStoreId,
    externalProductId: SAMPLE_LISTING.variant.externalProductId,
    externalVariantId: SAMPLE_LISTING.variant.externalVariantId,
    citySlug: SAMPLE_LISTING.geographicContext.citySlug,
    observedPriceCop: createCopAmount(priceCop),
    availability: "IN_STOCK",
    provenance: "DEMO_FIXTURE",
    observedAt,
    ...overrides,
  };
}

describe("Monetary integrity (SC-006)", () => {
  it("accepts non-negative safe integers for COP amounts", () => {
    expect(createCopAmount(0)).toBe(0);
    expect(createCopAmount(42_500)).toBe(42_500);
  });

  it("rejects floating-point numbers, negative numbers, and NaN", () => {
    expect(() => createCopAmount(19999.99)).toThrow(RangeError);
    expect(() => createCopAmount(-500)).toThrow(RangeError);
    expect(() => createCopAmount(Number.NaN)).toThrow(RangeError);
  });

  it("calculates basis points deterministically with integer math", () => {
    expect(
      calculateDiscountBasisPoints(createCopAmount(30_000), createCopAmount(40_000)),
    ).toBe(2500); // 25.00%
    expect(
      calculateDiscountBasisPoints(createCopAmount(45_000), createCopAmount(40_000)),
    ).toBe(0);
  });

  it("formats COP amounts using es-CO locale without decimals", () => {
    const formatted = formatCop(createCopAmount(480_000));
    expect(formatted).toContain("480.000");
  });

  it("computes integer medians even for even-length arrays", () => {
    const median = computeMedianCop([createCopAmount(10_001), createCopAmount(10_002)]);
    expect(Number.isSafeInteger(median)).toBe(true);
    expect(median).toBe(10_002);
  });
});

describe("Canonical listing identity & store/variant isolation", () => {
  it("keeps variants and stores strictly separated in canonical listing keys", () => {
    const key500g = buildCanonicalListingKey({
      providerId: "fixture-colombia",
      externalStoreId: "store-a",
      externalProductId: "prod-100",
      externalVariantId: "var-500g",
      citySlug: "bogota",
    });
    const key250g = buildCanonicalListingKey({
      providerId: "fixture-colombia",
      externalStoreId: "store-a",
      externalProductId: "prod-100",
      externalVariantId: "var-250g",
      citySlug: "bogota",
    });
    const keyOtherStore = buildCanonicalListingKey({
      providerId: "fixture-colombia",
      externalStoreId: "store-b",
      externalProductId: "prod-100",
      externalVariantId: "var-500g",
      citySlug: "bogota",
    });

    expect(key500g).not.toBe(key250g);
    expect(key500g).not.toBe(keyOtherStore);
  });
});

describe("Price intelligence rules & anomaly classification (SC-007)", () => {
  it("handles the zero-history (first observation ever) scenario safely without historical claims", () => {
    const opportunities = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: [],
    });

    // With 0 prior observations, only DECLARED_DISCOUNT is permitted (if declaredReferencePriceCop > observedPriceCop)
    expect(opportunities.map((o) => o.type)).toEqual(["DECLARED_DISCOUNT"]);
    expect(opportunities[0]?.historicalObservationCount).toBe(0);
    expect(opportunities[0]?.confidence).toBe("LOW");
    expect(opportunities[0]?.requiresVerification).toBe(true);

    // And if there is no declared reference price on a first observation, 0 opportunities are emitted
    const { declaredReferencePriceCop: _omitted, ...listingWithoutDeclaredRef } =
      SAMPLE_LISTING;
    const noRefOpportunities = evaluateListingOpportunities({
      listing: listingWithoutDeclaredRef,
      historicalObservations: [],
    });
    expect(noRefOpportunities).toHaveLength(0);
  });

  it("never triggers POTENTIAL_ANOMALY or HISTORICAL_DROP when history is sparse (< minHistory)", () => {
    // Only 2 prior observations (below minHistoryForDrop=3 and minHistoryForAnomaly=5)
    const sparseHistory = [
      makeObservation(400_000, "2026-11-05T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-06T12:00:00.000Z"),
    ];

    const opportunities = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: sparseHistory,
    });

    const types = opportunities.map((o) => o.type);
    expect(types).not.toContain("POTENTIAL_ANOMALY");
    expect(types).not.toContain("HISTORICAL_LOW");
    expect(types).not.toContain("HISTORICAL_DROP");
    // Only DECLARED_DISCOUNT is permitted when declared reference price exists
    expect(types).toEqual(["DECLARED_DISCOUNT"]);
  });

  it("excludes the current observation timestamp from the historical baseline", () => {
    // 4 prior observations at 400k + 1 observation at the exact current timestamp with 190k
    const historyIncludingCurrent = [
      makeObservation(400_000, "2026-11-03T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-04T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-05T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-06T12:00:00.000Z"),
      makeObservation(190_000, "2026-11-07T12:00:00.000Z"), // Same as SAMPLE_LISTING.sourceObservedAt
    ];

    const opportunities = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: historyIncludingCurrent,
    });

    // Because the current observation is excluded, only 4 prior observations remain (<5 required for anomaly)
    const anomaly = opportunities.find((o) => o.type === "POTENTIAL_ANOMALY");
    expect(anomaly).toBeUndefined();

    const historicalLow = opportunities.find((o) => o.type === "HISTORICAL_LOW");
    expect(historicalLow).toBeDefined();
    expect(historicalLow?.historicalObservationCount).toBe(4);
    expect(historicalLow?.historicalLowCop).toBe(400_000);
  });

  it("classifies POTENTIAL_ANOMALY with Spanish label and requiresVerification=true when >=5 prior observations support it", () => {
    const sufficientHistory = [
      makeObservation(400_000, "2026-11-01T12:00:00.000Z"),
      makeObservation(405_000, "2026-11-02T12:00:00.000Z"),
      makeObservation(398_000, "2026-11-03T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-04T12:00:00.000Z"),
      makeObservation(402_000, "2026-11-05T12:00:00.000Z"),
    ];

    const opportunities = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: sufficientHistory,
    });

    const anomaly = opportunities.find((o) => o.type === "POTENTIAL_ANOMALY");
    expect(anomaly).toBeDefined();
    expect(anomaly?.labelEsCo).toBe(OPPORTUNITY_LABELS_ES_CO.POTENTIAL_ANOMALY);
    expect(anomaly?.labelEsCo).toBe("Posible error de precio");
    expect(anomaly?.requiresVerification).toBe(true);
    expect(anomaly?.discountPercentage).toBe(53);

    // Mutual exclusivity of historical tiers: when POTENTIAL_ANOMALY fires, neither HISTORICAL_LOW nor HISTORICAL_DROP is redundantly emitted
    expect(opportunities.find((o) => o.type === "HISTORICAL_LOW")).toBeUndefined();
    expect(opportunities.find((o) => o.type === "HISTORICAL_DROP")).toBeUndefined();
    // Only POTENTIAL_ANOMALY (historical tier) + DECLARED_DISCOUNT (provider reference tier) are emitted
    expect(opportunities.map((o) => o.type)).toEqual([
      "POTENTIAL_ANOMALY",
      "DECLARED_DISCOUNT",
    ]);
  });

  it("suppresses misleading DECLARED_DISCOUNT when observed price is >= historical median", () => {
    const historyBelowDeclared = [
      makeObservation(180_000, "2026-11-01T12:00:00.000Z"),
      makeObservation(185_000, "2026-11-02T12:00:00.000Z"),
      makeObservation(180_000, "2026-11-03T12:00:00.000Z"),
    ];

    // SAMPLE_LISTING has observedPrice=190,000 and declaredReferencePrice=400,000 (-52% declared),
    // but historical median is 180,000 (so 190,000 is actually a price increase vs history!)
    const opportunities = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: historyBelowDeclared,
    });

    expect(opportunities).toHaveLength(0);
  });

  it("ignores observations belonging to a different variant or store", () => {
    const otherVariantKey = buildCanonicalListingKey({
      providerId: "fixture-colombia",
      externalStoreId: "store-a",
      externalProductId: "prod-100",
      externalVariantId: "var-1kg",
      citySlug: "bogota",
    });

    const mismatchedHistory = [
      makeObservation(400_000, "2026-11-01T12:00:00.000Z", {
        listingKey: otherVariantKey,
      }),
      makeObservation(400_000, "2026-11-02T12:00:00.000Z", {
        listingKey: otherVariantKey,
      }),
      makeObservation(400_000, "2026-11-03T12:00:00.000Z", {
        listingKey: otherVariantKey,
      }),
      makeObservation(400_000, "2026-11-04T12:00:00.000Z", {
        listingKey: otherVariantKey,
      }),
      makeObservation(400_000, "2026-11-05T12:00:00.000Z", {
        listingKey: otherVariantKey,
      }),
    ];

    const opportunities = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: mismatchedHistory,
    });

    expect(opportunities.some((o) => o.type === "POTENTIAL_ANOMALY")).toBe(false);
    expect(opportunities.some((o) => o.type === "HISTORICAL_LOW")).toBe(false);
  });

  it("suppresses duplicate opportunities within the cooldown window", () => {
    const history = [
      makeObservation(400_000, "2026-11-01T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-02T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-03T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-04T12:00:00.000Z"),
      makeObservation(400_000, "2026-11-05T12:00:00.000Z"),
    ];

    const firstPass = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: history,
      evaluationTimeIso: "2026-11-07T12:00:00.000Z",
    });

    expect(firstPass.length).toBeGreaterThan(0);

    const secondPass = evaluateListingOpportunities({
      listing: SAMPLE_LISTING,
      historicalObservations: history,
      existingOpportunities: firstPass,
      evaluationTimeIso: "2026-11-07T12:15:00.000Z", // 15 minutes later (within 120-min cooldown)
    });

    expect(secondPass).toHaveLength(0);
  });

  it("Task C: isolates historical baselines by provenance so provisional session or public observations never mix with verified LIVE_PRIVATE history", () => {
    const provisionalListing: DiscoveredListing = {
      ...SAMPLE_LISTING,
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    };

    // 5 prior observations exist for the same listingKey, but with PUBLIC_STOREFRONT_UNAUTHENTICATED and LIVE_PRIVATE provenance
    const mismatchedProvenanceHistory = [
      makeObservation(400_000, "2026-11-01T12:00:00.000Z", {
        provenance: "PUBLIC_STOREFRONT_UNAUTHENTICATED",
      }),
      makeObservation(400_000, "2026-11-02T12:00:00.000Z", {
        provenance: "PUBLIC_STOREFRONT_UNAUTHENTICATED",
      }),
      makeObservation(400_000, "2026-11-03T12:00:00.000Z", {
        provenance: "LIVE_PRIVATE",
      }),
      makeObservation(400_000, "2026-11-04T12:00:00.000Z", {
        provenance: "LIVE_PRIVATE",
      }),
      makeObservation(400_000, "2026-11-05T12:00:00.000Z", {
        provenance: "DEMO_FIXTURE",
      }),
    ];

    const opportunities = evaluateListingOpportunities({
      listing: provisionalListing,
      historicalObservations: mismatchedProvenanceHistory,
    });

    // Because none of the 5 observations match PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL,
    // historicalObservationCount must be 0 and no historical tier (POTENTIAL_ANOMALY / HISTORICAL_LOW / HISTORICAL_DROP) may fire
    expect(opportunities.map((o) => o.type)).toEqual(["DECLARED_DISCOUNT"]);
    expect(opportunities[0]?.historicalObservationCount).toBe(0);
    expect(opportunities[0]?.provenance).toBe(
      "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    );
  });

  it("Phase P2 Section 8 & 9: evaluates $65.000 -> $65.000 -> $39.900 with exact integer COP deltas and 38.62% drop", () => {
    const oliveOilListing: DiscoveredListing = {
      ...SAMPLE_LISTING,
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      observedPriceCop: createCopAmount(39_900),
      sourceObservedAt: "2026-11-07T15:00:00.000Z",
    };
    delete (oliveOilListing as { declaredReferencePriceCop?: unknown })
      .declaredReferencePriceCop;

    const listingKey = buildCanonicalListingKey({
      providerId: oliveOilListing.providerId,
      externalStoreId: oliveOilListing.store.externalStoreId,
      externalProductId: oliveOilListing.variant.externalProductId,
      externalVariantId: oliveOilListing.variant.externalVariantId,
      citySlug: oliveOilListing.geographicContext.citySlug,
    });

    const history = [
      makeObservation(65_000, "2026-11-05T15:00:00.000Z", {
        observationId: "obs-1",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
      makeObservation(65_000, "2026-11-06T15:00:00.000Z", {
        observationId: "obs-2",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
    ];

    const comparison = compareObservationAgainstHistory({
      listingKey,
      currentPriceCop: oliveOilListing.observedPriceCop,
      currentObservedAtIso: oliveOilListing.sourceObservedAt,
      provenance: oliveOilListing.provenance,
      historicalObservations: history,
    });

    expect(comparison.movement).toBe("PRICE_DECREASE");
    expect(comparison.priorObservationCount).toBe(2);
    expect(comparison.previousPriceCop).toBe(65_000);
    expect(comparison.baselineMedianCop).toBe(65_000);
    expect(comparison.absoluteDeltaCop).toBe(25_100);
    expect(comparison.changeBasisPoints).toBe(3862);
    expect(comparison.changePercentageDecimal).toBe(38.62);

    const opportunities = evaluateListingOpportunities({
      listing: oliveOilListing,
      historicalObservations: history,
      config: PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
    });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.type).toBe("HISTORICAL_LOW");
    expect(opportunities[0]?.savingsCop).toBe(25_100);
    expect(opportunities[0]?.discountBasisPoints).toBe(3862);
    expect(opportunities[0]?.discountPercentage).toBe(39);
    expect(opportunities[0]?.previousPriceCop).toBe(65_000);
  });

  it("Phase P2 Section 9: distinguishes FIRST_OBSERVATION, UNCHANGED_PRICE, and PRICE_INCREASE without false discount alerts", () => {
    const baseListing: DiscoveredListing = {
      ...SAMPLE_LISTING,
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      observedPriceCop: createCopAmount(65_000),
      sourceObservedAt: "2026-11-07T15:00:00.000Z",
    };
    delete (baseListing as { declaredReferencePriceCop?: unknown })
      .declaredReferencePriceCop;

    const listingKey = buildCanonicalListingKey({
      providerId: baseListing.providerId,
      externalStoreId: baseListing.store.externalStoreId,
      externalProductId: baseListing.variant.externalProductId,
      externalVariantId: baseListing.variant.externalVariantId,
      citySlug: baseListing.geographicContext.citySlug,
    });

    // 1. First observation
    const first = compareObservationAgainstHistory({
      listingKey,
      currentPriceCop: baseListing.observedPriceCop,
      currentObservedAtIso: baseListing.sourceObservedAt,
      provenance: baseListing.provenance,
      historicalObservations: [],
    });
    expect(first.movement).toBe("FIRST_OBSERVATION");
    expect(first.priorObservationCount).toBe(0);
    expect(
      evaluateListingOpportunities({
        listing: baseListing,
        historicalObservations: [],
        config: PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
      }),
    ).toHaveLength(0);

    // 2. Unchanged price (even if older prices were higher, if current == immediately preceding price, no new historical drop fires)
    const unchangedHistory = [
      makeObservation(80_000, "2026-11-04T15:00:00.000Z", {
        observationId: "obs-1",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
      makeObservation(80_000, "2026-11-05T15:00:00.000Z", {
        observationId: "obs-2",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
      makeObservation(65_000, "2026-11-06T15:00:00.000Z", {
        observationId: "obs-3",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
    ];
    const unchanged = compareObservationAgainstHistory({
      listingKey,
      currentPriceCop: baseListing.observedPriceCop,
      currentObservedAtIso: baseListing.sourceObservedAt,
      provenance: baseListing.provenance,
      historicalObservations: unchangedHistory,
    });
    expect(unchanged.movement).toBe("UNCHANGED_PRICE");
    expect(unchanged.absoluteDeltaCop).toBe(0);
    expect(
      evaluateListingOpportunities({
        listing: baseListing,
        historicalObservations: unchangedHistory,
        config: PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
      }),
    ).toHaveLength(0);

    // 3. Price increase vs previous observation
    const increasedListing: DiscoveredListing = {
      ...baseListing,
      observedPriceCop: createCopAmount(72_000),
    };
    const increased = compareObservationAgainstHistory({
      listingKey,
      currentPriceCop: increasedListing.observedPriceCop,
      currentObservedAtIso: increasedListing.sourceObservedAt,
      provenance: increasedListing.provenance,
      historicalObservations: unchangedHistory,
    });
    expect(increased.movement).toBe("PRICE_INCREASE");
    expect(increased.absoluteDeltaCop).toBe(7_000);
    expect(
      evaluateListingOpportunities({
        listing: increasedListing,
        historicalObservations: unchangedHistory,
        config: PRIVATE_HISTORY_INTELLIGENCE_CONFIG,
      }),
    ).toHaveLength(0);
  });

  it("Phase P2 Section 8: handles out-of-order observations and identical timestamps deterministically", () => {
    const listing: DiscoveredListing = {
      ...SAMPLE_LISTING,
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      observedPriceCop: createCopAmount(39_900),
      sourceObservedAt: "2026-11-07T18:00:00.000Z",
    };
    delete (listing as { declaredReferencePriceCop?: unknown }).declaredReferencePriceCop;

    const listingKey = buildCanonicalListingKey({
      providerId: listing.providerId,
      externalStoreId: listing.store.externalStoreId,
      externalProductId: listing.variant.externalProductId,
      externalVariantId: listing.variant.externalVariantId,
      citySlug: listing.geographicContext.citySlug,
    });

    // Out of chronological order + duplicate identical (timestamp, price) entry + tie-broken same timestamp
    const unorderedHistory = [
      makeObservation(65_000, "2026-11-06T10:00:00.000Z", {
        observationId: "obs-b",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
      makeObservation(60_000, "2026-11-06T10:00:00.000Z", {
        observationId: "obs-a",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
      makeObservation(65_000, "2026-11-06T10:00:00.000Z", {
        observationId: "obs-b-dup",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
      makeObservation(70_000, "2026-11-01T10:00:00.000Z", {
        observationId: "obs-0",
        provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      }),
    ];

    const comparison = compareObservationAgainstHistory({
      listingKey,
      currentPriceCop: listing.observedPriceCop,
      currentObservedAtIso: listing.sourceObservedAt,
      provenance: listing.provenance,
      historicalObservations: unorderedHistory,
    });

    // Deduplicated count is 3 (2026-11-01@70k, 2026-11-06@60k [obs-a], 2026-11-06@65k [obs-b])
    expect(comparison.priorObservationCount).toBe(3);
    // Because obs-b sorts after obs-a at the identical timestamp, previousPriceCop is 65_000
    expect(comparison.previousPriceCop).toBe(65_000);
    expect(comparison.baselineMedianCop).toBe(65_000);
  });
});
