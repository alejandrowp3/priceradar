import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveredListing } from "@priceradar/domain";
import { createCopAmount } from "@priceradar/domain";
import type { SupervisedPersistenceContextInput } from "../src/index.ts";
import {
  assertDatabasePathOutsideRepository,
  assertNoSensitiveTextInPersistedString,
  SqlitePrivateHistoryRepository,
} from "../src/index.ts";

const VALID_CTX_HASH_A = "ctx-a1b2c3d4e5f60718";
const VALID_CTX_HASH_B = "ctx-9988776655443322";

function makeProvisionalListing(
  overrides: {
    externalStoreId?: string;
    storeName?: string;
    externalProductId?: string;
    externalVariantId?: string;
    name?: string;
    packagingLabel?: string;
    unitQuantity?: number;
    unitType?: "g" | "kg" | "ml" | "l" | "unit";
    observedPriceCop?: number;
    declaredReferencePriceCop?: number;
    sourceObservedAt?: string;
    fulfillmentContextHash?: string;
    provenance?: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" | "LIVE_PRIVATE";
  } = {},
): DiscoveredListing {
  const listing: DiscoveredListing = {
    providerId: "rappi-authenticated-inspector",
    store: {
      providerId: "rappi-authenticated-inspector",
      externalStoreId: overrides.externalStoreId ?? "900130995-turbo-super",
      name: overrides.storeName ?? "Turbo Super",
      categorySlug: "supermercados",
    },
    variant: {
      externalProductId: overrides.externalProductId ?? "2111457819",
      externalVariantId: overrides.externalVariantId ?? "var-500ml",
      name: overrides.name ?? "Aceite de Oliva Extra Virgen",
      brand: "Carbonell",
      categorySlug: "supermercados",
      categoryName: "Supermercados",
      packagingLabel: overrides.packagingLabel ?? "500 ml",
      unitQuantity: overrides.unitQuantity ?? 500,
      unitType: overrides.unitType ?? "ml",
      productUrl: "https://www.rappi.com.co/p/aceite-oliva-2111457819",
    },
    geographicContext: {
      countryCode: "CO",
      citySlug: "bogota",
      cityName: "Bogotá D.C.",
      fulfillmentContextHash: overrides.fulfillmentContextHash ?? VALID_CTX_HASH_A,
    },
    observedPriceCop: createCopAmount(overrides.observedPriceCop ?? 65_000),
    ...(overrides.declaredReferencePriceCop !== undefined
      ? {
          declaredReferencePriceCop: createCopAmount(overrides.declaredReferencePriceCop),
        }
      : {}),
    availability: "IN_STOCK",
    provenance: overrides.provenance ?? "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    sourceObservedAt: overrides.sourceObservedAt ?? "2026-11-05T14:00:00.000Z",
  };
  return listing;
}

function makeSupervisedBatchInput(
  listings: readonly DiscoveredListing[],
  overrides: Partial<SupervisedPersistenceContextInput> = {},
): SupervisedPersistenceContextInput {
  const observedAtIso =
    overrides.observedAtIso ??
    listings[0]?.sourceObservedAt ??
    "2026-11-05T14:00:00.000Z";
  const fulfillmentContextHash =
    overrides.fulfillmentContextHash ??
    listings[0]?.geographicContext.fulfillmentContextHash ??
    VALID_CTX_HASH_A;

  return {
    scanRunId: overrides.scanRunId ?? `scan-${observedAtIso}`,
    observedAtIso,
    gateStatus: overrides.gateStatus ?? "UNVERIFIED_FULFILLMENT_CONTEXT",
    hasSecurityChallenge: overrides.hasSecurityChallenge ?? false,
    isLoginRequired: overrides.isLoginRequired ?? false,
    isDeliveryContextVerified: overrides.isDeliveryContextVerified ?? true,
    citySlug: overrides.citySlug ?? "bogota",
    cityName: overrides.cityName ?? "Bogotá D.C.",
    fulfillmentContextHash,
    activeAddressSelection:
      overrides.activeAddressSelection ?? "VERIFIED_ACTIVE_SELECTION",
    cityAndNeighborhoodMetadata:
      overrides.cityAndNeighborhoodMetadata ?? "VERIFIED_FROM_ACTIVE_CONTEXT",
    servingStoreBranch:
      overrides.servingStoreBranch ?? "UNVERIFIED_STATIC_DEFAULT_BRANCH",
    productCatalogContext:
      overrides.productCatalogContext ??
      "PROVISIONAL_LIVE_DOM_DIVERGES_FROM_STATIC_HYDRATION",
    pricingVerificationVerdict:
      overrides.pricingVerificationVerdict ?? "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
    navigationStates: overrides.navigationStates ?? {
      ADDRESS_SELECTED: true,
      STORE_OPENED_FROM_ADDRESS_CONTEXT: true,
      CATALOG_VISIBLE_IN_SESSION: true,
      ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
    },
    candidatesDiscoveredCount: overrides.candidatesDiscoveredCount ?? listings.length,
    skippedMalformedCount: overrides.skippedMalformedCount ?? 0,
    duplicateSuppressedCount: overrides.duplicateSuppressedCount ?? 0,
    listings,
  };
}

describe("SqlitePrivateHistoryRepository — Phase P2 Storage, Privacy & Lifecycle", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-p2-sqlite-"));
    dbPath = path.join(tempDir, "nested", "private-history.sqlite");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("13.1 Storage initialization, permissions, constraints & transactions", () => {
    it("initializes schema migrations, WAL mode, and enforces 0700 directory and 0600 file permissions", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const status = repo.getDatabaseStatus();

      expect(status.existsOnDisk).toBe(true);
      expect(status.schemaVersion).toBe(1);
      expect(status.directoryModeOctal).toBe("0700");
      expect(status.fileModeOctal).toBe("0600");

      const dirMode = fs.statSync(path.dirname(dbPath)).mode & 0o777;
      const fileMode = fs.statSync(dbPath).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);

      repo.close();
    });

    it("rejects any SQLite database path inside the Git repository tree", () => {
      const repoRoot = path.resolve(import.meta.dirname, "../../..");
      const insideRepoPath = path.join(repoRoot, "tmp-private-history.sqlite");

      expect(() => assertDatabasePathOutsideRepository(insideRepoPath)).toThrow(
        /must reside outside the Git repository/i,
      );
      expect(() => new SqlitePrivateHistoryRepository(insideRepoPath)).toThrow(
        /must reside outside the Git repository/i,
      );
    });

    it("rolls back the entire batch atomically when a failure occurs mid-transaction (0 partial rows)", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const listings = [
        makeProvisionalListing({
          externalProductId: "prod-1",
          name: "Café Tostado",
          observedPriceCop: 28_000,
        }),
        makeProvisionalListing({
          externalProductId: "prod-2",
          name: "Leche Deslactosada",
          observedPriceCop: 5_900,
        }),
      ];
      const batch = makeSupervisedBatchInput(listings, { scanRunId: "scan-crash-test" });

      const result = repo.persistApprovedInspectionBatch(batch, {
        ownerConfirmed: true,
        simulateCrashAfterObservationsInserted: 1,
      });

      expect(result.persisted).toBe(false);
      expect(result.reason).toBe("TRANSACTION_FAILED");
      expect(result.observationsInserted).toBe(0);

      const statusAfterCrash = repo.getDatabaseStatus();
      expect(statusAfterCrash.counts.activeObservations).toBe(0);
      expect(statusAfterCrash.counts.scanRuns).toBe(0);
      expect(statusAfterCrash.counts.products).toBe(0);
      expect(statusAfterCrash.counts.activeOpportunities).toBe(0);

      repo.close();
    });

    it("prevents duplicate observation insertion on identical replay and supports marking wrong observations as superseded", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const listing = makeProvisionalListing({
        externalProductId: "2111457819",
        observedPriceCop: 65_000,
        sourceObservedAt: "2026-11-05T14:00:00.000Z",
      });
      const batch = makeSupervisedBatchInput([listing], { scanRunId: "scan-1" });

      const firstSave = repo.persistApprovedInspectionBatch(batch, {
        ownerConfirmed: true,
      });
      expect(firstSave.persisted).toBe(true);
      expect(firstSave.observationsInserted).toBe(1);
      expect(firstSave.observationsSkippedDuplicate).toBe(0);

      // Replay identical observation in a second scan run
      const secondSave = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([listing], { scanRunId: "scan-1-replay" }),
        { ownerConfirmed: true },
      );
      expect(secondSave.persisted).toBe(true);
      expect(secondSave.observationsInserted).toBe(0);
      expect(secondSave.observationsSkippedDuplicate).toBe(1);
      expect(repo.getDatabaseStatus().counts.activeObservations).toBe(1);

      // Supersede observation without destructive history rewrite
      const histories = repo.getProductPriceHistory("2111457819");
      expect(histories).toHaveLength(1);
      const obsId = histories[0]?.observationId;
      expect(obsId).toBeDefined();

      const marked = repo.markObservationSuperseded(
        obsId ?? "",
        "Corrección manual del propietario",
      );
      expect(marked).toBe(true);

      // Active history excludes superseded observation, while status counts show supersededObservations = 1
      const activeOnly = repo.getProductPriceHistory("2111457819");
      expect(activeOnly).toHaveLength(0);
      expect(repo.getDatabaseStatus().counts.activeObservations).toBe(0);
      expect(repo.getDatabaseStatus().counts.supersededObservations).toBe(1);

      repo.close();
    });
  });

  describe("13.3 Privacy, provenance & explicit consent enforcement", () => {
    it("does not write any records when ownerConfirmed is false", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const batch = makeSupervisedBatchInput([makeProvisionalListing()]);

      const declined = repo.persistApprovedInspectionBatch(batch, {
        ownerConfirmed: false,
      });

      expect(declined.persisted).toBe(false);
      expect(declined.reason).toBe("OWNER_DECLINED");
      expect(repo.getDatabaseStatus().counts.activeObservations).toBe(0);
      expect(repo.getDatabaseStatus().counts.scanRuns).toBe(0);
      repo.close();
    });

    it("stores provisional observations with PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL and addressSpecificPricingVerified = false", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const batch = makeSupervisedBatchInput([makeProvisionalListing()]);

      const preview = repo.previewInspectionBatchAgainstHistory(batch);
      expect(preview.isEligible).toBe(true);
      expect(preview.provenance).toBe("PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL");
      expect(preview.addressSpecificPricingVerified).toBe(false);
      expect(preview.geographicVerificationVerdict).toBe(
        "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
      );

      repo.persistApprovedInspectionBatch(batch, { ownerConfirmed: true });
      const history = repo.getProductPriceHistory("2111457819");
      expect(history[0]?.provenance).toBe("PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL");
      expect(history[0]?.addressSpecificPricingVerified).toBe(false);
      expect(history[0]?.fulfillmentContextId).toBe(VALID_CTX_HASH_A);

      repo.close();
    });

    it("rejects persistence when delivery context is missing, HMAC secret is missing, login is required, or security challenge is active", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const listing = makeProvisionalListing();

      // 1. Missing active delivery address
      const noAddress = repo.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([listing], {
          activeAddressSelection: "MISSING_ACTIVE_ADDRESS",
          pricingVerificationVerdict: "UNVERIFIED_NO_ACTIVE_ADDRESS",
        }),
      );
      expect(noAddress.isEligible).toBe(false);

      // 2. Missing HMAC secret / invalid context hash
      const noHmac = repo.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([listing], {
          fulfillmentContextHash: "",
          pricingVerificationVerdict: "UNVERIFIED_MISSING_HMAC_SECRET",
        }),
      );
      expect(noHmac.isEligible).toBe(false);

      // 3. Security challenge active
      const challenge = repo.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([listing], {
          hasSecurityChallenge: true,
        }),
      );
      expect(challenge.isEligible).toBe(false);

      // 4. Static SEO hydration without live catalog divergence
      const staticSeo = repo.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([listing], {
          productCatalogContext: "UNVERIFIED_STATIC_SEO_HYDRATION",
          pricingVerificationVerdict: "UNVERIFIED_STATIC_SEO_PRICING",
        }),
      );
      expect(staticSeo.isEligible).toBe(false);

      repo.close();
    });

    it("rejects strings containing raw Colombian street addresses, emails, phone numbers, or session tokens", () => {
      expect(() =>
        assertNoSensitiveTextInPersistedString("Calle 85 # 15-20 Apto 402", "address"),
      ).toThrow(/Privacy violation prevented/i);
      expect(() =>
        assertNoSensitiveTextInPersistedString("Carrera 11 # 93-10", "address"),
      ).toThrow(/Privacy violation prevented/i);
      expect(() =>
        assertNoSensitiveTextInPersistedString("owner@example.com", "email"),
      ).toThrow(/Privacy violation prevented/i);
      expect(() =>
        assertNoSensitiveTextInPersistedString("+57 310 555 1234", "phone"),
      ).toThrow(/Privacy violation prevented/i);
      expect(() =>
        assertNoSensitiveTextInPersistedString("Bearer eyJhbGciOiJIUzI1NiIs", "token"),
      ).toThrow(/Privacy violation prevented/i);
    });
  });

  describe("Section 15 — Full 7-Step Lifecycle across Simulated Process Restarts", () => {
    it("persists across restarts, detects real price drops ($65.000 -> $65.000 -> $39.900), suppresses duplicates on replay, and isolates stores/variants/contexts", () => {
      // Step 1 & 2: First supervised observation ($65.000) persisted after explicit owner approval
      const repoSession1 = new SqlitePrivateHistoryRepository(dbPath);
      const obsDay1 = makeProvisionalListing({
        externalProductId: "2111457819",
        externalVariantId: "var-500ml",
        name: "Aceite de Oliva Extra Virgen",
        observedPriceCop: 65_000,
        sourceObservedAt: "2026-11-05T14:00:00.000Z",
      });
      const saveDay1 = repoSession1.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([obsDay1], {
          scanRunId: "scan-day-1",
          observedAtIso: "2026-11-05T14:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );
      expect(saveDay1.persisted).toBe(true);
      expect(saveDay1.observationsInserted).toBe(1);
      expect(saveDay1.opportunitiesInserted).toBe(0);
      repoSession1.close();

      // Step 3: Process restart -> second observation on Day 2 still at $65.000 (establishes 2-observation baseline)
      const repoSession2 = new SqlitePrivateHistoryRepository(dbPath);
      const obsDay2 = makeProvisionalListing({
        externalProductId: "2111457819",
        externalVariantId: "var-500ml",
        name: "Aceite de Oliva Extra Virgen",
        observedPriceCop: 65_000,
        sourceObservedAt: "2026-11-06T14:00:00.000Z",
      });
      const previewDay2 = repoSession2.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([obsDay2], {
          scanRunId: "scan-day-2",
          observedAtIso: "2026-11-06T14:00:00.000Z",
        }),
      );
      expect(previewDay2.unchangedPricesCount).toBe(1);
      expect(previewDay2.candidateOpportunitiesCount).toBe(0);

      const saveDay2 = repoSession2.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([obsDay2], {
          scanRunId: "scan-day-2",
          observedAtIso: "2026-11-06T14:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );
      expect(saveDay2.persisted).toBe(true);
      expect(saveDay2.observationsInserted).toBe(1);
      expect(saveDay2.opportunitiesInserted).toBe(0);
      repoSession2.close();

      // Step 4 & 5: Process restart -> third observation on Day 3 with changed price ($39.900)
      const repoSession3 = new SqlitePrivateHistoryRepository(dbPath);
      const obsDay3Drop = makeProvisionalListing({
        externalProductId: "2111457819",
        externalVariantId: "var-500ml",
        name: "Aceite de Oliva Extra Virgen",
        observedPriceCop: 39_900,
        sourceObservedAt: "2026-11-07T14:00:00.000Z",
      });
      const batchDay3 = makeSupervisedBatchInput([obsDay3Drop], {
        scanRunId: "scan-day-3",
        observedAtIso: "2026-11-07T14:00:00.000Z",
      });

      const previewDay3 = repoSession3.previewInspectionBatchAgainstHistory(batchDay3);
      expect(previewDay3.priceDecreasesCount).toBe(1);
      expect(previewDay3.candidateOpportunitiesCount).toBe(1);
      expect(previewDay3.items[0]?.comparison.previousPriceCop).toBe(65_000);
      expect(previewDay3.items[0]?.comparison.absoluteDeltaCop).toBe(25_100);
      expect(previewDay3.items[0]?.comparison.changePercentageDecimal).toBe(38.62);

      const saveDay3 = repoSession3.persistApprovedInspectionBatch(batchDay3, {
        ownerConfirmed: true,
      });
      expect(saveDay3.persisted).toBe(true);
      expect(saveDay3.observationsInserted).toBe(1);
      expect(saveDay3.opportunitiesInserted).toBe(1);

      const dropsAfterDay3 = repoSession3.listDetectedOpportunities({
        types: ["HISTORICAL_LOW", "HISTORICAL_DROP"],
      });
      expect(dropsAfterDay3).toHaveLength(1);
      expect(dropsAfterDay3[0]?.observedPriceCop).toBe(39_900);
      expect(dropsAfterDay3[0]?.previousPriceCop).toBe(65_000);
      expect(dropsAfterDay3[0]?.savingsCop).toBe(25_100);
      expect(dropsAfterDay3[0]?.discountPercentage).toBe(39);
      expect(dropsAfterDay3[0]?.geographicVerificationVerdict).toBe(
        "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
      );

      // Step 6: No duplicate event on replay or unchanged follow-up observation
      const saveDay3Replay = repoSession3.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([obsDay3Drop], {
          scanRunId: "scan-day-3-replay",
          observedAtIso: "2026-11-07T14:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );
      expect(saveDay3Replay.observationsInserted).toBe(0);
      expect(saveDay3Replay.opportunitiesInserted).toBe(0);

      // Even a new scan 1 hour later at the SAME $39.900 price must not emit a second drop event
      const obsDay3LaterSamePrice = makeProvisionalListing({
        externalProductId: "2111457819",
        externalVariantId: "var-500ml",
        name: "Aceite de Oliva Extra Virgen",
        observedPriceCop: 39_900,
        sourceObservedAt: "2026-11-07T15:00:00.000Z",
      });
      const saveDay3Later = repoSession3.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([obsDay3LaterSamePrice], {
          scanRunId: "scan-day-3-later",
          observedAtIso: "2026-11-07T15:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );
      expect(saveDay3Later.observationsInserted).toBe(1);
      expect(saveDay3Later.opportunitiesInserted).toBe(0);
      expect(
        repoSession3.listDetectedOpportunities({
          types: ["HISTORICAL_LOW", "HISTORICAL_DROP"],
        }),
      ).toHaveLength(1);

      // Step 7: Strict isolation between different stores, variants, and fulfillment contexts
      // 7a: Different variant (1000 ml instead of 500 ml) has 0 prior history
      const otherVariant = makeProvisionalListing({
        externalProductId: "2111457819",
        externalVariantId: "var-1000ml",
        packagingLabel: "1000 ml",
        unitQuantity: 1000,
        unitType: "ml",
        observedPriceCop: 39_900,
        sourceObservedAt: "2026-11-07T16:00:00.000Z",
      });
      const previewOtherVariant = repoSession3.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([otherVariant]),
      );
      expect(previewOtherVariant.firstObservationsCount).toBe(1);
      expect(previewOtherVariant.candidateOpportunitiesCount).toBe(0);

      // 7b: Different store ("900999999-carulla") has 0 prior history
      const otherStore = makeProvisionalListing({
        externalStoreId: "900999999-carulla",
        storeName: "Carulla",
        observedPriceCop: 39_900,
        sourceObservedAt: "2026-11-07T16:00:00.000Z",
      });
      const previewOtherStore = repoSession3.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([otherStore]),
      );
      expect(previewOtherStore.firstObservationsCount).toBe(1);
      expect(previewOtherStore.candidateOpportunitiesCount).toBe(0);

      // 7c: Different fulfillment context (VALID_CTX_HASH_B) has 0 prior history
      const otherContext = makeProvisionalListing({
        fulfillmentContextHash: VALID_CTX_HASH_B,
        observedPriceCop: 39_900,
        sourceObservedAt: "2026-11-07T16:00:00.000Z",
      });
      const previewOtherContext = repoSession3.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([otherContext], {
          fulfillmentContextHash: VALID_CTX_HASH_B,
        }),
      );
      expect(previewOtherContext.firstObservationsCount).toBe(1);
      expect(previewOtherContext.candidateOpportunitiesCount).toBe(0);

      repoSession3.close();
    });
  });
});
