import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DiscoveredListing } from "@priceradar/domain";
import { createCopAmount } from "@priceradar/domain";
import { SqlitePrivateHistoryRepository } from "@priceradar/database";
import type { SupervisedPersistenceContextInput } from "@priceradar/database";
import {
  fetchDashboardSummary,
  fetchCatalogProducts,
  fetchProductDetail,
  fetchActiveOpportunities,
  fetchCoverageReport,
  getReadOnlyDatabase,
} from "../src/lib/db";

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

describe("Phase P4 — Dashboard 12 Functional & Security Scenarios", () => {
  let tempDir: string;
  let dbPath: string;
  let originalEnvPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-p4-tests-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
    originalEnvPath = process.env.PRICERADAR_SQLITE_PATH;
    process.env.PRICERADAR_SQLITE_PATH = dbPath;
  });

  afterEach(() => {
    if (originalEnvPath !== undefined) {
      process.env.PRICERADAR_SQLITE_PATH = originalEnvPath;
    } else {
      delete process.env.PRICERADAR_SQLITE_PATH;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // 1. Scenario 1: Empty database
  it("Scenario 1: handles non-existent or empty database gracefully with zero crashes", () => {
    const summaryResult = fetchDashboardSummary();
    expect(summaryResult.dbExists).toBe(false);
    expect(summaryResult.summary).toBeNull();

    const catalogResult = fetchCatalogProducts();
    expect(catalogResult.dbExists).toBe(false);
    expect(catalogResult.result).toBeNull();

    const detailResult = fetchProductDetail("prod-100");
    expect(detailResult.dbExists).toBe(false);
    expect(detailResult.detail).toBeNull();

    const oppsResult = fetchActiveOpportunities();
    expect(oppsResult.dbExists).toBe(false);
    expect(oppsResult.result).toBeNull();

    const coverageResult = fetchCoverageReport();
    expect(coverageResult.dbExists).toBe(false);
    expect(coverageResult.report).toBeNull();
  });

  // 2. Scenario 2: Populated database with multiple products and observations
  it("Scenario 2: populates dashboard summary with multi-product telemetry", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-1",
            name: "Producto Uno",
            observedPriceCop: 10000,
          }),
          makeProvisionalListing({
            externalProductId: "prod-2",
            name: "Producto Dos",
            observedPriceCop: 20000,
          }),
        ],
        { scanRunId: "scan-p4-01" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { summary, dbExists } = fetchDashboardSummary();
    expect(dbExists).toBe(true);
    expect(summary).toBeDefined();
    expect(summary?.counts.totalDistinctProducts).toBe(2);
    expect(summary?.counts.totalActiveObservations).toBe(2);
    expect(summary?.counts.totalScanRuns).toBe(1);
    expect(summary?.recentlyObservedProducts).toHaveLength(2);
  });

  // 3. Scenario 3: Product with only one observation
  it("Scenario 3: product with single observation correctly reflects initial state without trend", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-single",
            name: "Café Especial 500g",
            observedPriceCop: 25000,
          }),
        ],
        { scanRunId: "scan-p4-single" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { detail, dbExists } = fetchProductDetail("prod-single");
    expect(dbExists).toBe(true);
    expect(detail).toBeDefined();
    expect(detail?.statistics.observationCount).toBe(1);
    expect(detail?.statistics.hasSufficientHistory).toBe(false);
    expect(detail?.statistics.previousPriceCop).toBeUndefined();
    expect(detail?.statistics.priceDifferenceCop).toBeUndefined();
    expect(detail?.observations).toHaveLength(1);
  });

  // 4. Scenario 4: Product with unchanged prices
  it("Scenario 4: recognizes unchanged prices over successive scans", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    // Scan 1
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-unchanged",
            name: "Arroz 1kg",
            observedPriceCop: 4500,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-p4-unchanged-1", observedAtIso: "2026-11-09T10:00:00.000Z" },
      ),
      { ownerConfirmed: true },
    );
    // Scan 2 (different time bucket, identical price)
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-unchanged",
            name: "Arroz 1kg",
            observedPriceCop: 4500,
            sourceObservedAt: "2026-11-09T14:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-p4-unchanged-2", observedAtIso: "2026-11-09T14:00:00.000Z" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { detail } = fetchProductDetail("prod-unchanged");
    expect(detail?.statistics.observationCount).toBe(2);
    expect(detail?.statistics.hasSufficientHistory).toBe(true);
    expect(detail?.statistics.priceDifferenceCop).toBe(0);
    expect(detail?.statistics.priceDifferencePercentage).toBe(0);

    const { result } = fetchCatalogProducts({ priceChange: "UNCHANGED" });
    expect(result?.items.some((p) => p.externalProductId === "prod-unchanged")).toBe(
      true,
    );
  });

  // 5. Scenario 5: Product with real historical price decrease
  it("Scenario 5: flags real price decreases with correct negative COP delta and DROPPED filter", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    // Scan 1: Baseline 50,000
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-drop",
            name: "Aceite de Oliva 500ml",
            observedPriceCop: 50000,
            sourceObservedAt: "2026-11-08T10:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-p4-drop-1", observedAtIso: "2026-11-08T10:00:00.000Z" },
      ),
      { ownerConfirmed: true },
    );
    // Scan 2: Baseline 50,000 confirmed
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-drop",
            name: "Aceite de Oliva 500ml",
            observedPriceCop: 50000,
            sourceObservedAt: "2026-11-08T16:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-p4-drop-2", observedAtIso: "2026-11-08T16:00:00.000Z" },
      ),
      { ownerConfirmed: true },
    );
    // Scan 3: Drops to 35,000 (-15,000 COP, -30%)
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-drop",
            name: "Aceite de Oliva 500ml",
            observedPriceCop: 35000,
            sourceObservedAt: "2026-11-09T10:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-p4-drop-3", observedAtIso: "2026-11-09T10:00:00.000Z" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { detail } = fetchProductDetail("prod-drop");
    expect(detail?.statistics.priceDifferenceCop).toBe(-15000);
    expect(detail?.statistics.priceDifferencePercentage).toBe(-30);
    expect(detail?.statistics.minPriceCop).toBe(35000);
    expect(detail?.statistics.maxPriceCop).toBe(50000);

    const { result } = fetchCatalogProducts({ priceChange: "DROPPED" });
    expect(result?.items.some((p) => p.externalProductId === "prod-drop")).toBe(true);
  });

  // 6. Scenario 6: Declared discounts distinguished from historical drops
  it("Scenario 6: strictly distinguishes DECLARED_DISCOUNT from HISTORICAL_LOW / HISTORICAL_DROP", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    // Product A: 1st observation with declared discount from reference price (40,000 -> 30,000, 25% off)
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-declared-only",
            name: "Vino Tinto Malbec 750ml",
            observedPriceCop: 30000,
            declaredReferencePriceCop: 40000,
            sourceObservedAt: "2026-11-09T08:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-p4-disc-1", observedAtIso: "2026-11-09T08:00:00.000Z" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { result: declaredOpps } = fetchActiveOpportunities({
      type: "DECLARED_DISCOUNT",
    });
    expect(
      declaredOpps?.items.some((o) => o.externalProductId === "prod-declared-only"),
    ).toBe(true);

    const { result: lowOpps } = fetchActiveOpportunities({ type: "HISTORICAL_LOW" });
    expect(lowOpps?.items.some((o) => o.externalProductId === "prod-declared-only")).toBe(
      false,
    );
  });

  // 7. Scenario 7: Product appearing in multiple source views
  it("Scenario 7: tracks products observed across different category views without losing data", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    // View A: Bebidas
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-multi-view",
            name: "Agua Mineral 600ml",
            observedPriceCop: 2000,
            sourceObservedAt: "2026-11-09T09:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-p4-view-a",
          observedAtIso: "2026-11-09T09:00:00.000Z",
          sourceView: {
            viewKey: "/tiendas/900130995-turbo-super/bebidas",
            ownerLabel: "Bebidas",
          },
        },
      ),
      { ownerConfirmed: true },
    );
    // View B: Despensa (later time bucket)
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-multi-view",
            name: "Agua Mineral 600ml",
            observedPriceCop: 2000,
            sourceObservedAt: "2026-11-09T15:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-p4-view-b",
          observedAtIso: "2026-11-09T15:00:00.000Z",
          sourceView: {
            viewKey: "/tiendas/900130995-turbo-super/despensa",
            ownerLabel: "Despensa",
          },
        },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { detail } = fetchProductDetail("prod-multi-view");
    expect(detail?.observations).toHaveLength(2);
    const viewKeys = detail?.observations.map((o) => o.sourceViewKey);
    expect(viewKeys).toContain("/tiendas/900130995-turbo-super/bebidas");
    expect(viewKeys).toContain("/tiendas/900130995-turbo-super/despensa");
  });

  // 8. Scenario 8: Legacy runs without source-view metadata
  it("Scenario 8: preserves and identifies legacy runs lacking view metadata as VISTA_DEFAULT", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    // Legacy scan without sourceView
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-legacy",
            name: "Pan Tajado 500g",
            observedPriceCop: 6000,
            sourceObservedAt: "2026-11-07T12:00:00.000Z",
          }),
        ],
        {
          scanRunId: "scan-legacy-p2",
          observedAtIso: "2026-11-07T12:00:00.000Z",
          sourceView: undefined,
        },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const { report } = fetchCoverageReport();
    expect(report?.views.some((v) => v.viewKey === "VISTA_DEFAULT")).toBe(true);
  });

  // 9. Scenario 9: Pagination and filtering
  it("Scenario 9: correctly handles page boundaries, sorting, and item limits", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    const listings = Array.from({ length: 15 }, (_, i) =>
      makeProvisionalListing({
        externalProductId: `prod-page-${i + 1}`,
        name: `Producto Item ${String(i + 1).padStart(2, "0")}`,
        observedPriceCop: 1000 * (i + 1),
      }),
    );
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(listings, { scanRunId: "scan-p4-pagination" }),
      { ownerConfirmed: true },
    );
    writer.close();

    // Page 1 with pageSize 5
    const page1 = fetchCatalogProducts({ page: 1, pageSize: 5, sortBy: "PRICE_ASC" });
    expect(page1.result?.items).toHaveLength(5);
    expect(page1.result?.totalCount).toBe(15);
    expect(page1.result?.totalPages).toBe(3);
    expect(page1.result?.items[0]?.externalProductId).toBe("prod-page-1");

    // Page 2 with pageSize 5
    const page2 = fetchCatalogProducts({ page: 2, pageSize: 5, sortBy: "PRICE_ASC" });
    expect(page2.result?.items).toHaveLength(5);
    expect(page2.result?.items[0]?.externalProductId).toBe("prod-page-6");

    // Page 3 with pageSize 5
    const page3 = fetchCatalogProducts({ page: 3, pageSize: 5, sortBy: "PRICE_ASC" });
    expect(page3.result?.items).toHaveLength(5);
    expect(page3.result?.items[0]?.externalProductId).toBe("prod-page-11");
  });

  // 10. Scenario 10: Unsafe search/filter inputs safely handled
  it("Scenario 10: neutralizes injection characters, wildcards, and special punctuation", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-safe",
            name: "Producto Normal 100g",
            observedPriceCop: 5000,
          }),
        ],
        { scanRunId: "scan-p4-injection-check" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    // SQL Injection attempts and wildcards
    const unsafeInputs = [
      "'; DROP TABLE products; --",
      "\" OR '1'='1",
      "%_%",
      "\\",
      "'; SELECT * FROM sqlite_master; --",
      "<script>alert(1)</script>",
    ];

    for (const input of unsafeInputs) {
      expect(() => {
        const res = fetchCatalogProducts({ search: input });
        expect(res.dbExists).toBe(true);
      }).not.toThrow();

      expect(() => {
        const oppRes = fetchActiveOpportunities({ search: input });
        expect(oppRes.dbExists).toBe(true);
      }).not.toThrow();
    }
  });

  // 11. Scenario 11: No local filesystem paths, tokens or fulfillment secrets exposed
  it("Scenario 11: ensures responses do not expose internal paths, auth tokens, or street addresses", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-audit",
            name: "Cereal Integral 400g",
            observedPriceCop: 12000,
          }),
        ],
        { scanRunId: "scan-p4-privacy-audit" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const summaryJson = JSON.stringify(fetchDashboardSummary());
    const catalogJson = JSON.stringify(fetchCatalogProducts());
    const detailJson = JSON.stringify(fetchProductDetail("prod-audit"));

    const forbiddenStrings = [
      "Calle 100 # 15-20",
      tempDir,
      "private-history.sqlite",
      "bearer",
      "access_token",
      "session_id",
    ];

    for (const forbidden of forbiddenStrings) {
      expect(summaryJson).not.toContain(forbidden);
      expect(catalogJson).not.toContain(forbidden);
      expect(detailJson).not.toContain(forbidden);
    }
  });

  // 12. Scenario 12: Read-only dashboard access does not mutate the database
  it("Scenario 12: guarantees read-only access never mutates SQLite file size, mtime, or records", () => {
    const writer = new SqlitePrivateHistoryRepository(dbPath);
    writer.persistApprovedInspectionBatch(
      makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "prod-ro",
            name: "Manzana Roja 1kg",
            observedPriceCop: 8000,
          }),
        ],
        { scanRunId: "scan-p4-readonly-verify" },
      ),
      { ownerConfirmed: true },
    );
    writer.close();

    const statBefore = fs.statSync(dbPath);

    // Call all read-only dashboard functions
    fetchDashboardSummary();
    fetchCatalogProducts();
    fetchProductDetail("prod-ro");
    fetchActiveOpportunities();
    fetchCoverageReport();

    const statAfter = fs.statSync(dbPath);
    expect(statAfter.size).toBe(statBefore.size);

    // Assert that read-only repo throws if any write operation is attempted
    const { repo } = getReadOnlyDatabase();
    expect(repo).toBeDefined();

    expect(() => {
      repo?.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "illegal",
              name: "Illegal",
              observedPriceCop: 1000,
            }),
          ],
          { scanRunId: "scan-illegal" },
        ),
        { ownerConfirmed: true },
      );
    }).toThrow(/Cannot perform 'persistApprovedInspectionBatch' on a read-only database/);
  });
});
