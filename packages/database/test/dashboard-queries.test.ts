import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveredListing } from "@priceradar/domain";
import { createCopAmount } from "@priceradar/domain";
import type { SupervisedPersistenceContextInput } from "../src/sqlite-repository.ts";
import { SqlitePrivateHistoryRepository } from "../src/sqlite-repository.ts";

const VALID_CTX_HASH = "ctx-88be5762563932c5";

function makeProvisionalListing(overrides: {
  externalProductId: string;
  externalVariantId?: string;
  name: string;
  brand?: string;
  observedPriceCop: number;
  declaredReferencePriceCop?: number;
  sourceObservedAt?: string;
}): DiscoveredListing {
  return {
    providerId: "rappi-authenticated-inspector",
    store: {
      providerId: "rappi-authenticated-inspector",
      externalStoreId: "900130995-turbo-super",
      name: "Turbo Super",
      categorySlug: "supermercados",
    },
    variant: {
      externalProductId: overrides.externalProductId,
      externalVariantId:
        overrides.externalVariantId ?? `${overrides.externalProductId}-std`,
      name: overrides.name,
      ...(overrides.brand ? { brand: overrides.brand } : {}),
      categorySlug: "supermercados",
      categoryName: "Supermercados",
      packagingLabel: "1 unidad",
      unitQuantity: 1,
      unitType: "unit",
      productUrl: `https://www.rappi.com.co/p/${overrides.externalProductId}`,
    },
    geographicContext: {
      countryCode: "CO",
      citySlug: "bogota",
      cityName: "Bogotá D.C.",
      fulfillmentContextHash: VALID_CTX_HASH,
    },
    observedPriceCop: createCopAmount(overrides.observedPriceCop),
    ...(overrides.declaredReferencePriceCop !== undefined
      ? {
          declaredReferencePriceCop: createCopAmount(overrides.declaredReferencePriceCop),
        }
      : {}),
    availability: "IN_STOCK",
    provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    sourceObservedAt: overrides.sourceObservedAt ?? "2026-11-09T14:00:00.000Z",
  };
}

function makeSupervisedBatchInput(
  listings: readonly DiscoveredListing[],
  options: {
    scanRunId: string;
    observedAtIso?: string;
    sourceView?: { viewKey: string; ownerLabel?: string };
  },
): SupervisedPersistenceContextInput {
  const observedAtIso =
    options.observedAtIso ?? listings[0]?.sourceObservedAt ?? "2026-11-09T14:00:00.000Z";

  return {
    scanRunId: options.scanRunId,
    observedAtIso,
    gateStatus: "UNVERIFIED_FULFILLMENT_CONTEXT",
    hasSecurityChallenge: false,
    isLoginRequired: false,
    isDeliveryContextVerified: true,
    citySlug: "bogota",
    cityName: "Bogotá D.C.",
    fulfillmentContextHash: VALID_CTX_HASH,
    activeAddressSelection: "VERIFIED_ACTIVE_SELECTION",
    cityAndNeighborhoodMetadata: "VERIFIED_FROM_ACTIVE_CONTEXT",
    servingStoreBranch: "UNVERIFIED_STATIC_DEFAULT_BRANCH",
    productCatalogContext: "PROVISIONAL_LIVE_DOM_DIVERGES_FROM_STATIC_HYDRATION",
    pricingVerificationVerdict: "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
    navigationStates: {
      ADDRESS_SELECTED: true,
      STORE_OPENED_FROM_ADDRESS_CONTEXT: true,
      CATALOG_VISIBLE_IN_SESSION: true,
      ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
    },
    candidatesDiscoveredCount: listings.length,
    skippedMalformedCount: 0,
    duplicateSuppressedCount: 0,
    listings,
    ...(options.sourceView !== undefined
      ? {
          sourceView: {
            viewKey: options.sourceView.viewKey,
            pageKind: "STORE_SUBPATH" as const,
            labelSource: options.sourceView.ownerLabel
              ? ("OWNER_PROVIDED" as const)
              : ("NONE" as const),
            ...(options.sourceView.ownerLabel
              ? { ownerLabel: options.sourceView.ownerLabel }
              : {}),
          },
        }
      : {}),
  };
}

describe("Dashboard Query Methods & Read-Only Repository (Phase P4)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-p4-db-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("readOnly connection mode", () => {
    it("throws if opening a non-existent database file in read-only mode", () => {
      const nonExistent = path.join(tempDir, "does-not-exist.sqlite");
      expect(() => {
        new SqlitePrivateHistoryRepository(nonExistent, { readOnly: true });
      }).toThrow(/Cannot open read-only database: file does not exist/);
    });

    it("opens an existing database in read-only mode and rejects write operations", () => {
      // 1. Initialize writable database and seed 1 product
      const writer = new SqlitePrivateHistoryRepository(dbPath);
      const listings = [
        makeProvisionalListing({
          externalProductId: "prod-001",
          name: "Café Juan Valdez 500g",
          observedPriceCop: 32000,
        }),
      ];
      const ctx = makeSupervisedBatchInput(listings, { scanRunId: "scan-w1" });
      writer.persistApprovedInspectionBatch(ctx, { ownerConfirmed: true });
      writer.close();

      // 2. Open read-only connection
      const reader = new SqlitePrivateHistoryRepository(dbPath, { readOnly: true });
      expect(reader.getIsReadOnly()).toBe(true);

      // Verify queries work
      const summary = reader.getDashboardSummary();
      expect(summary.counts.totalDistinctProducts).toBe(1);
      expect(summary.counts.totalActiveObservations).toBe(1);

      // Verify write methods are strictly blocked at application level
      expect(() => {
        reader.withImmediateTransaction(() => {});
      }).toThrow(/Cannot perform 'withImmediateTransaction' on a read-only database/);

      expect(() => {
        reader.persistApprovedInspectionBatch(ctx, { ownerConfirmed: true });
      }).toThrow(
        /Cannot perform 'persistApprovedInspectionBatch' on a read-only database/,
      );

      expect(() => {
        reader.reevaluateLatestListingOpportunities();
      }).toThrow(
        /Cannot perform 'reevaluateLatestListingOpportunities' on a read-only database/,
      );

      expect(() => {
        reader.markObservationSuperseded("some-id", "test");
      }).toThrow(/Cannot perform 'withImmediateTransaction' on a read-only database/);

      reader.close();
    });
  });

  describe("getDashboardSummary()", () => {
    it("returns correct empty summary when database has zero scan runs", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);
      const summary = writer.getDashboardSummary();

      expect(summary.counts.totalDistinctProducts).toBe(0);
      expect(summary.counts.totalActiveObservations).toBe(0);
      expect(summary.counts.activeOpportunitiesCount).toBe(0);
      expect(summary.counts.historicalLowsCount).toBe(0);
      expect(summary.counts.totalScanRuns).toBe(0);
      expect(summary.counts.totalInspectedViews).toBe(0);
      expect(summary.freshnessStatus).toBe("EMPTY");
      expect(summary.topOpportunities).toHaveLength(0);
      expect(summary.recentlyObservedProducts).toHaveLength(0);
      expect(summary.latestScanRun).toBeUndefined();
      writer.close();
    });

    it("computes accurate counts, freshness status, top opportunities and recently observed products", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Batch 1: Baseline 1
      const ctx1 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "p1",
            name: "Aceite de Oliva 500ml",
            observedPriceCop: 60000,
            sourceObservedAt: "2026-11-07T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "p2",
            name: "Arroz Diana 1kg",
            observedPriceCop: 5000,
            sourceObservedAt: "2026-11-07T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-s1",
          observedAtIso: "2026-11-07T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/despensa", ownerLabel: "despensa" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx1, { ownerConfirmed: true });

      // Batch 2: Baseline 2 (second observation to establish 2 prior observations)
      const ctx2 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "p1",
            name: "Aceite de Oliva 500ml",
            observedPriceCop: 60000,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-s2",
          observedAtIso: "2026-11-08T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/despensa", ownerLabel: "despensa" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx2, { ownerConfirmed: true });

      // Batch 3: p1 drops to $45,000 (historical drop / low), p3 first observation with declared discount
      const ctx3 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "p1",
            name: "Aceite de Oliva 500ml",
            observedPriceCop: 45000,
            sourceObservedAt: "2026-11-09T12:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "p3",
            name: "Leche Entera 1L",
            observedPriceCop: 4200,
            declaredReferencePriceCop: 6000,
            sourceObservedAt: "2026-11-09T12:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-s3",
          observedAtIso: "2026-11-09T12:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/lacteos", ownerLabel: "lacteos" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx3, { ownerConfirmed: true });

      const summary = writer.getDashboardSummary();
      expect(summary.counts.totalDistinctProducts).toBe(3);
      expect(summary.counts.totalActiveObservations).toBe(5);
      expect(summary.counts.totalScanRuns).toBe(3);
      expect(summary.counts.totalInspectedViews).toBe(2);
      expect(summary.counts.activeOpportunitiesCount).toBeGreaterThanOrEqual(1);

      // p1 should be in top opportunities
      expect(summary.topOpportunities.some((o) => o.externalProductId === "p1")).toBe(
        true,
      );

      // Recently observed products should have 3 items
      expect(summary.recentlyObservedProducts.length).toBeLessThanOrEqual(6);
      expect(summary.recentlyObservedProducts[0]?.externalProductId).toBeDefined();

      // Latest scan run
      expect(summary.latestScanRun?.scanRunId).toBe("scan-s3");
      expect(summary.latestScanRun?.sourceViewKey).toBe("/tiendas/turbo/lacteos");
      expect(summary.latestScanRun?.sourceViewLabel).toBe("lacteos");

      writer.close();
    });
  });

  describe("listCatalogProducts()", () => {
    it("handles pagination, searching, sorting and price change filtering", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Scan 1: initial prices
      const ctx1 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "beer-1",
            name: "Cerveza Corona 355ml",
            brand: "Corona",
            observedPriceCop: 7500,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "beer-2",
            name: "Cerveza Stella Artois 330ml",
            brand: "Stella",
            observedPriceCop: 6800,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "snack-1",
            name: "Papas Margarita Pollo 105g",
            brand: "Margarita",
            observedPriceCop: 4500,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-c1",
          observedAtIso: "2026-11-08T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/licores", ownerLabel: "licores" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx1, { ownerConfirmed: true });

      // Scan 2: beer-1 dropped, beer-2 increased, snack-1 unchanged
      const ctx2 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "beer-1",
            name: "Cerveza Corona 355ml",
            brand: "Corona",
            observedPriceCop: 6000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "beer-2",
            name: "Cerveza Stella Artois 330ml",
            brand: "Stella",
            observedPriceCop: 7200,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "snack-1",
            name: "Papas Margarita Pollo 105g",
            brand: "Margarita",
            observedPriceCop: 4500,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "single-1",
            name: "Chocolate Corona Tradicional 500g",
            brand: "Corona",
            observedPriceCop: 12000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-c2",
          observedAtIso: "2026-11-09T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/licores", ownerLabel: "licores" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx2, { ownerConfirmed: true });

      // 1. Pagination check
      const page1 = writer.listCatalogProducts({ page: 1, pageSize: 2 });
      expect(page1.totalCount).toBe(4);
      expect(page1.items).toHaveLength(2);
      expect(page1.totalPages).toBe(2);
      expect(page1.page).toBe(1);

      // 2. Search check by name
      const searchRes = writer.listCatalogProducts({ search: "Corona" });
      expect(searchRes.items).toHaveLength(2);

      // 3. Search check by product ID
      const idSearch = writer.listCatalogProducts({ search: "beer-2" });
      expect(idSearch.items).toHaveLength(1);
      expect(idSearch.items[0]?.productName).toBe("Cerveza Stella Artois 330ml");

      // 4. Price change filter: DROPPED
      const dropped = writer.listCatalogProducts({ priceChange: "DROPPED" });
      expect(dropped.items).toHaveLength(1);
      expect(dropped.items[0]?.externalProductId).toBe("beer-1");
      expect(dropped.items[0]?.priceDifferenceCop).toBe(-1500);
      expect(dropped.items[0]?.priceDifferencePercentage).toBe(-20);

      // 5. Price change filter: INCREASED
      const increased = writer.listCatalogProducts({ priceChange: "INCREASED" });
      expect(increased.items).toHaveLength(1);
      expect(increased.items[0]?.externalProductId).toBe("beer-2");
      expect(increased.items[0]?.priceDifferenceCop).toBe(400);

      // 6. Price change filter: UNCHANGED
      const unchanged = writer.listCatalogProducts({ priceChange: "UNCHANGED" });
      expect(unchanged.items).toHaveLength(1);
      expect(unchanged.items[0]?.externalProductId).toBe("snack-1");
      expect(unchanged.items[0]?.priceDifferenceCop).toBe(0);

      // 7. Price change filter: FIRST_OBSERVATION
      const firstObs = writer.listCatalogProducts({ priceChange: "FIRST_OBSERVATION" });
      expect(firstObs.items).toHaveLength(1);
      expect(firstObs.items[0]?.externalProductId).toBe("single-1");
      expect(firstObs.items[0]?.previousPriceCop).toBeUndefined();

      // 8. Sorting by price desc
      const sortedPriceDesc = writer.listCatalogProducts({ sortBy: "PRICE_DESC" });
      expect(sortedPriceDesc.items[0]?.latestPriceCop).toBe(12000);

      writer.close();
    });
  });

  describe("getProductDetail()", () => {
    it("returns undefined for non-existent product", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);
      expect(writer.getProductDetail("non-existent-999")).toBeUndefined();
      writer.close();
    });

    it("returns correct details for a product with only one observation (insufficient history flag)", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);
      const ctx = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "single-prod",
            name: "Vino Tinto Malbec 750ml",
            observedPriceCop: 58000,
          }),
        ],
        { scanRunId: "scan-d1" },
      );
      writer.persistApprovedInspectionBatch(ctx, { ownerConfirmed: true });

      const detail = writer.getProductDetail("single-prod");
      expect(detail).toBeDefined();
      expect(detail?.product.productName).toBe("Vino Tinto Malbec 750ml");
      expect(detail?.statistics.currentPriceCop).toBe(58000);
      expect(detail?.statistics.previousPriceCop).toBeUndefined();
      expect(detail?.statistics.priceDifferenceCop).toBeUndefined();
      expect(detail?.statistics.minPriceCop).toBe(58000);
      expect(detail?.statistics.maxPriceCop).toBe(58000);
      expect(detail?.statistics.observationCount).toBe(1);
      expect(detail?.statistics.hasSufficientHistory).toBe(false);
      expect(detail?.observations).toHaveLength(1);

      writer.close();
    });

    it("returns full statistics, observations timeline, and active opportunities for multi-observation product", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Scan 1: $100.000 (declared ref $120.000)
      const ctx1 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "whisky-black",
            name: "Whisky Johnnie Walker Black 750ml",
            observedPriceCop: 100000,
            declaredReferencePriceCop: 120000,
            sourceObservedAt: "2026-11-07T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-m1",
          observedAtIso: "2026-11-07T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/whisky", ownerLabel: "whisky" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx1, { ownerConfirmed: true });

      // Scan 2: $100.000
      const ctx2 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "whisky-black",
            name: "Whisky Johnnie Walker Black 750ml",
            observedPriceCop: 100000,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-m2",
          observedAtIso: "2026-11-08T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/whisky", ownerLabel: "whisky" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx2, { ownerConfirmed: true });

      // Scan 3: $80.000 (historical drop to historical low)
      const ctx3 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "whisky-black",
            name: "Whisky Johnnie Walker Black 750ml",
            observedPriceCop: 80000,
            declaredReferencePriceCop: 120000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-m3",
          observedAtIso: "2026-11-09T10:00:00.000Z",
          sourceView: { viewKey: "/tiendas/turbo/whisky", ownerLabel: "whisky" },
        },
      );
      writer.persistApprovedInspectionBatch(ctx3, { ownerConfirmed: true });

      const detail = writer.getProductDetail("whisky-black");
      expect(detail).toBeDefined();
      expect(detail?.statistics.currentPriceCop).toBe(80000);
      expect(detail?.statistics.previousPriceCop).toBe(100000);
      expect(detail?.statistics.priceDifferenceCop).toBe(-20000);
      expect(detail?.statistics.priceDifferencePercentage).toBe(-20);
      expect(detail?.statistics.minPriceCop).toBe(80000);
      expect(detail?.statistics.maxPriceCop).toBe(100000);
      expect(detail?.statistics.averagePriceCop).toBe(93333);
      expect(detail?.statistics.observationCount).toBe(3);
      expect(detail?.statistics.hasSufficientHistory).toBe(true);

      // Timeline must be in chronological order
      expect(detail?.observations).toHaveLength(3);
      expect(detail?.observations[0]?.observedPriceCop).toBe(100000);
      expect(detail?.observations[2]?.observedPriceCop).toBe(80000);

      // Active opportunities should include the HISTORICAL_LOW
      expect(
        detail?.activeOpportunities.some((o) => o.opportunityType === "HISTORICAL_LOW"),
      ).toBe(true);

      writer.close();
    });
  });

  describe("listActiveOpportunities()", () => {
    it("filters by search and type, and sorts by discount, savings and date", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Seed baseline 1
      const ctx0 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "opp-1",
            name: "Producto A",
            observedPriceCop: 100000,
            sourceObservedAt: "2026-11-07T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "opp-2",
            name: "Producto B",
            observedPriceCop: 50000,
            sourceObservedAt: "2026-11-07T10:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-o0", observedAtIso: "2026-11-07T10:00:00.000Z" },
      );
      writer.persistApprovedInspectionBatch(ctx0, { ownerConfirmed: true });

      // Seed baseline 2
      const ctx1 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "opp-1",
            name: "Producto A",
            observedPriceCop: 100000,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "opp-2",
            name: "Producto B",
            observedPriceCop: 50000,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-o1", observedAtIso: "2026-11-08T10:00:00.000Z" },
      );
      writer.persistApprovedInspectionBatch(ctx1, { ownerConfirmed: true });

      // Seed drops: opp-1 drops by $30.000 (30%), opp-2 drops by $20.000 (40%)
      const ctx2 = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "opp-1",
            name: "Producto A",
            observedPriceCop: 70000,
            declaredReferencePriceCop: 100000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
          makeProvisionalListing({
            externalProductId: "opp-2",
            name: "Producto B",
            observedPriceCop: 30000,
            declaredReferencePriceCop: 50000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-o2", observedAtIso: "2026-11-09T10:00:00.000Z" },
      );
      writer.persistApprovedInspectionBatch(ctx2, { ownerConfirmed: true });

      // 1. Sort by discount desc: opp-2 (40%) before opp-1 (30%)
      const byDiscount = writer.listActiveOpportunities({ sortBy: "DISCOUNT_DESC" });
      expect(byDiscount.items[0]?.externalProductId).toBe("opp-2");

      // 2. Sort by savings desc: opp-1 ($30.000) before opp-2 ($20.000)
      const bySavings = writer.listActiveOpportunities({ sortBy: "SAVINGS_DESC" });
      expect(bySavings.items[0]?.externalProductId).toBe("opp-1");

      // 3. Search filter
      const searchRes = writer.listActiveOpportunities({ search: "Producto B" });
      expect(searchRes.items.length).toBeGreaterThanOrEqual(1);
      expect(searchRes.items.every((o) => o.externalProductId === "opp-2")).toBe(true);

      // 4. Type filter
      const typeRes = writer.listActiveOpportunities({ type: "HISTORICAL_LOW" });
      expect(typeRes.items.length).toBeGreaterThanOrEqual(1);
      expect(typeRes.items.every((o) => o.opportunityType === "HISTORICAL_LOW")).toBe(
        true,
      );

      writer.close();
    });
  });

  describe("F5-02: Multi-variant disambiguation and safe URL lookups", () => {
    it("returns separate detail views for different variants sharing the same externalProductId", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Seed 2 variants of the same product: 200ml ($15.000) and 400ml ($25.000)
      const listings = [
        makeProvisionalListing({
          externalProductId: "shampoo-100",
          externalVariantId: "shampoo-100-200ml",
          name: "Shampoo Anticaspa 200ml",
          observedPriceCop: 15000,
          sourceObservedAt: "2026-11-09T10:00:00.000Z",
        }),
        makeProvisionalListing({
          externalProductId: "shampoo-100",
          externalVariantId: "shampoo-100-400ml",
          name: "Shampoo Anticaspa 400ml",
          observedPriceCop: 25000,
          sourceObservedAt: "2026-11-09T10:00:00.000Z",
        }),
      ];

      const batch = makeSupervisedBatchInput(listings, { scanRunId: "scan-var-1" });
      writer.persistApprovedInspectionBatch(batch, { ownerConfirmed: true });

      const variantKey200 =
        "rappi-authenticated-inspector::shampoo-100::shampoo-100-200ml";
      const variantKey400 =
        "rappi-authenticated-inspector::shampoo-100::shampoo-100-400ml";

      // 1. Exact variant lookup for 200ml
      const detail200 = writer.getProductDetail(variantKey200);
      expect(detail200).toBeDefined();
      expect(detail200?.product.productName).toBe("Shampoo Anticaspa 200ml");
      expect(detail200?.product.productVariantKey).toBe(variantKey200);
      expect(detail200?.statistics.currentPriceCop).toBe(15000);
      expect(detail200?.observations).toHaveLength(1);
      expect(detail200?.observations[0]?.observedPriceCop).toBe(15000);

      // 2. Exact variant lookup for 400ml
      const detail400 = writer.getProductDetail(variantKey400);
      expect(detail400).toBeDefined();
      expect(detail400?.product.productName).toBe("Shampoo Anticaspa 400ml");
      expect(detail400?.product.productVariantKey).toBe(variantKey400);
      expect(detail400?.statistics.currentPriceCop).toBe(25000);
      expect(detail400?.observations).toHaveLength(1);
      expect(detail400?.observations[0]?.observedPriceCop).toBe(25000);

      // 3. Ambiguous bare externalProductId lookup returns undefined when >1 variants exist
      const ambiguousDetail = writer.getProductDetail("shampoo-100");
      expect(ambiguousDetail).toBeUndefined();

      writer.close();
    });

    it("safely resolves bare externalProductId if exactly one variant exists in the database", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      const listing = makeProvisionalListing({
        externalProductId: "unique-prod-999",
        externalVariantId: "unique-prod-999-std",
        name: "Aceite de Oliva 500ml",
        observedPriceCop: 38000,
      });

      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([listing], { scanRunId: "scan-unique-1" }),
        { ownerConfirmed: true },
      );

      // Querying by bare externalProductId succeeds because there is exactly 1 variant
      const detail = writer.getProductDetail("unique-prod-999");
      expect(detail).toBeDefined();
      expect(detail?.product.productName).toBe("Aceite de Oliva 500ml");
      expect(detail?.product.externalProductId).toBe("unique-prod-999");

      writer.close();
    });
  });

  describe("F5-03: Direct opportunity lookup avoids global truncation and variant mixing", () => {
    it("retrieves active opportunity without being truncated by global limits when >50 opportunities exist", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // 1. Create baseline for 55 products
      const count = 55;
      const baseListings: DiscoveredListing[] = [];
      for (let i = 1; i <= count; i++) {
        baseListings.push(
          makeProvisionalListing({
            externalProductId: `bulk-prod-${i.toString().padStart(3, "0")}`,
            name: `Bulk Product ${i}`,
            observedPriceCop: 100000,
            sourceObservedAt: "2026-11-07T10:00:00.000Z",
          }),
        );
      }
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(baseListings, {
          scanRunId: "scan-bulk-base",
          observedAtIso: "2026-11-07T10:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );

      // Baseline 2
      const baseListings2 = baseListings.map((l) => ({
        ...l,
        sourceObservedAt: "2026-11-08T10:00:00.000Z",
      }));
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(baseListings2, {
          scanRunId: "scan-bulk-base2",
          observedAtIso: "2026-11-08T10:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );

      // 2. Price drop for all 55 products to trigger 55 ACTIVE opportunities
      const dropListings: DiscoveredListing[] = [];
      for (let i = 1; i <= count; i++) {
        dropListings.push(
          makeProvisionalListing({
            externalProductId: `bulk-prod-${i.toString().padStart(3, "0")}`,
            name: `Bulk Product ${i}`,
            observedPriceCop: 80000,
            declaredReferencePriceCop: 100000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
        );
      }
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(dropListings, {
          scanRunId: "scan-bulk-drop",
          observedAtIso: "2026-11-09T10:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );

      // Total active opportunities should be >50 (both drops and historical lows generated)
      const allActive = writer.listActiveOpportunities({ pageSize: 100 });
      expect(allActive.totalCount).toBeGreaterThanOrEqual(55);

      // Verify that the 55th product's detail STILL retrieves its active opportunity
      const targetVariantKey =
        "rappi-authenticated-inspector::bulk-prod-055::bulk-prod-055-std";
      const targetDetail = writer.getProductDetail(targetVariantKey);

      expect(targetDetail).toBeDefined();
      expect(targetDetail?.activeOpportunities.length).toBeGreaterThanOrEqual(1);
      const activeOpp = targetDetail?.activeOpportunities[0];
      expect(activeOpp?.externalProductId).toBe("bulk-prod-055");
      expect(activeOpp?.opportunityType).toBe("HISTORICAL_LOW");
      expect(activeOpp?.discountPercentage).toBe(20);

      writer.close();
    });

    it("keeps active opportunities strictly scoped to their variant without cross-contamination", () => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Variant A and Variant B of the same external product
      const variantKeyA = "rappi-authenticated-inspector::split-prod::split-prod-A";
      const variantKeyB = "rappi-authenticated-inspector::split-prod::split-prod-B";

      // Baseline 1
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "split-prod",
              externalVariantId: "split-prod-A",
              name: "Split Product Variant A",
              observedPriceCop: 50000,
              sourceObservedAt: "2026-11-07T10:00:00.000Z",
            }),
            makeProvisionalListing({
              externalProductId: "split-prod",
              externalVariantId: "split-prod-B",
              name: "Split Product Variant B",
              observedPriceCop: 80000,
              sourceObservedAt: "2026-11-07T10:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-split-base1", observedAtIso: "2026-11-07T10:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );

      // Baseline 2
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "split-prod",
              externalVariantId: "split-prod-A",
              name: "Split Product Variant A",
              observedPriceCop: 50000,
              sourceObservedAt: "2026-11-08T10:00:00.000Z",
            }),
            makeProvisionalListing({
              externalProductId: "split-prod",
              externalVariantId: "split-prod-B",
              name: "Split Product Variant B",
              observedPriceCop: 80000,
              sourceObservedAt: "2026-11-08T10:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-split-base2", observedAtIso: "2026-11-08T10:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );

      // Only Variant A drops in price (50.000 -> 35.000)
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "split-prod",
              externalVariantId: "split-prod-A",
              name: "Split Product Variant A",
              observedPriceCop: 35000,
              declaredReferencePriceCop: 50000,
              sourceObservedAt: "2026-11-09T10:00:00.000Z",
            }),
            makeProvisionalListing({
              externalProductId: "split-prod",
              externalVariantId: "split-prod-B",
              name: "Split Product Variant B",
              observedPriceCop: 80000,
              sourceObservedAt: "2026-11-09T10:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-split-drop", observedAtIso: "2026-11-09T10:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );

      const detailA = writer.getProductDetail(variantKeyA);
      expect(detailA?.activeOpportunities.length).toBeGreaterThanOrEqual(1);
      expect(detailA?.activeOpportunities[0]?.productVariantKey).toBe(variantKeyA);
      expect(detailA?.activeOpportunities[0]?.discountPercentage).toBe(30);

      const detailB = writer.getProductDetail(variantKeyB);
      expect(detailB?.activeOpportunities).toHaveLength(0);

      writer.close();
    });
  });
});
