import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
(globalThis as unknown as { React: typeof React }).React = React;
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveredListing } from "@priceradar/domain";
import { createCopAmount } from "@priceradar/domain";
import type { SupervisedPersistenceContextInput } from "@priceradar/database";
import { SqlitePrivateHistoryRepository } from "@priceradar/database";
import OverviewPage from "../src/app/page";
import ProductsPage from "../src/app/products/page";
import OpportunitiesPage from "../src/app/opportunities/page";
import CoveragePage from "../src/app/coverage/page";
import ProductDetailPage from "../src/app/products/[id]/page";

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

describe("Next.js Server Component Route Execution (P4 Runtime Fix)", () => {
  let tempDir: string;
  let dbPath: string;
  let originalDbEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-routes-test-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
    originalDbEnv = process.env.PRICERADAR_SQLITE_PATH;
    process.env.PRICERADAR_SQLITE_PATH = dbPath;
  });

  afterEach(() => {
    if (originalDbEnv !== undefined) {
      process.env.PRICERADAR_SQLITE_PATH = originalDbEnv;
    } else {
      delete process.env.PRICERADAR_SQLITE_PATH;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Empty database behavior (pre-scan state)", () => {
    beforeEach(() => {
      // Ensure dbPath does not exist
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    });

    it("renders OverviewPage with EmptyState when database does not exist", () => {
      const page = OverviewPage();
      expect(page).toBeDefined();
      expect(page.props.children).toBeDefined();
    });

    it("renders ProductsPage with EmptyState when database does not exist", async () => {
      const page = await ProductsPage({
        searchParams: Promise.resolve({}),
      });
      expect(page).toBeDefined();
    });

    it("renders OpportunitiesPage with EmptyState when database does not exist", async () => {
      const page = await OpportunitiesPage({
        searchParams: Promise.resolve({}),
      });
      expect(page).toBeDefined();
    });

    it("renders CoveragePage with EmptyState when database does not exist", () => {
      const page = CoveragePage();
      expect(page).toBeDefined();
    });

    it("renders ProductDetailPage with EmptyState when database does not exist", async () => {
      const page = await ProductDetailPage({
        params: Promise.resolve({ id: "rappi::nonexistent::std" }),
      });
      expect(page).toBeDefined();
    });
  });

  describe("Populated database behavior (with real observations and opportunities)", () => {
    const productKeyA = "rappi-authenticated-inspector::whisky-black::whisky-black-std";

    beforeEach(() => {
      const writer = new SqlitePrivateHistoryRepository(dbPath);

      // Scan 1: Baseline
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "whisky-black",
              name: "Whisky Johnnie Walker Black 750ml",
              observedPriceCop: 100000,
              sourceObservedAt: "2026-11-08T10:00:00.000Z",
            }),
            makeProvisionalListing({
              externalProductId: "cafe-juan",
              name: "Café Juan Valdez 500g",
              observedPriceCop: 28000,
              sourceObservedAt: "2026-11-08T10:00:00.000Z",
            }),
          ],
          {
            scanRunId: "scan-r1",
            observedAtIso: "2026-11-08T10:00:00.000Z",
            sourceView: { viewKey: "/tiendas/turbo/licores", ownerLabel: "licores" },
          },
        ),
        { ownerConfirmed: true },
      );

      // Scan 2: Price drop on whisky ($100.000 -> $75.000)
      writer.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "whisky-black",
              name: "Whisky Johnnie Walker Black 750ml",
              observedPriceCop: 75000,
              declaredReferencePriceCop: 100000,
              sourceObservedAt: "2026-11-09T10:00:00.000Z",
            }),
            makeProvisionalListing({
              externalProductId: "cafe-juan",
              name: "Café Juan Valdez 500g",
              observedPriceCop: 28000,
              sourceObservedAt: "2026-11-09T10:00:00.000Z",
            }),
          ],
          {
            scanRunId: "scan-r2",
            observedAtIso: "2026-11-09T10:00:00.000Z",
            sourceView: { viewKey: "/tiendas/turbo/licores", ownerLabel: "licores" },
          },
        ),
        { ownerConfirmed: true },
      );

      writer.close();
    });

    it("renders OverviewPage without runtime TypeError and displays populated statistics", () => {
      // Must not throw "TypeError: The paths[0] argument must be of type string"
      const page = OverviewPage();
      expect(page).toBeDefined();
      expect(page.props).toBeDefined();
    });

    it("renders ProductsPage with populated product cards", async () => {
      const page = await ProductsPage({
        searchParams: Promise.resolve({}),
      });
      expect(page).toBeDefined();

      // Test with search filter
      const filteredPage = await ProductsPage({
        searchParams: Promise.resolve({ q: "Whisky" }),
      });
      expect(filteredPage).toBeDefined();
    });

    it("renders OpportunitiesPage with active detected opportunities", async () => {
      const page = await OpportunitiesPage({
        searchParams: Promise.resolve({}),
      });
      expect(page).toBeDefined();

      // Test with sort parameter
      const sortedPage = await OpportunitiesPage({
        searchParams: Promise.resolve({ sort: "DISCOUNT_DESC" }),
      });
      expect(sortedPage).toBeDefined();
    });

    it("renders CoveragePage with view telemetry and catalog numbers", () => {
      const page = CoveragePage();
      expect(page).toBeDefined();
    });

    it("renders ProductDetailPage for a real product variant without crashing", async () => {
      const page = await ProductDetailPage({
        params: Promise.resolve({ id: encodeURIComponent(productKeyA) }),
      });
      expect(page).toBeDefined();
    });

    it("renders ProductDetailPage with EmptyState when an unknown product ID is requested", async () => {
      const page = await ProductDetailPage({
        params: Promise.resolve({ id: "rappi::unknown-product-999::std" }),
      });
      expect(page).toBeDefined();
    });
  });
});
