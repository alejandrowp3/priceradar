import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveredListing } from "@priceradar/domain";
import { buildCanonicalListingKey, createCopAmount } from "@priceradar/domain";
import type { SupervisedPersistenceContextInput } from "../src/index.ts";
import {
  assertDatabasePathOutsideRepository,
  assertNoSensitiveTextInPersistedString,
  assertPersistedFieldSafe,
  computeScanBatchFingerprint,
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
    categorySlug?: string;
    categoryName?: string;
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
      categorySlug: overrides.categorySlug ?? "supermercados",
    },
    variant: {
      externalProductId: overrides.externalProductId ?? "2111457819",
      externalVariantId: overrides.externalVariantId ?? "var-500ml",
      name: overrides.name ?? "Aceite de Oliva Extra Virgen",
      brand: "Carbonell",
      categorySlug: overrides.categorySlug ?? "supermercados",
      categoryName: overrides.categoryName ?? "Supermercados",
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
    ...(overrides.sourceView !== undefined ? { sourceView: overrides.sourceView } : {}),
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
      expect(status.schemaVersion).toBe(2);
      expect(status.directoryModeOctal).toBe("0700");
      expect(status.fileModeOctal).toBe("0600");

      const dirMode = fs.statSync(path.dirname(dbPath)).mode & 0o777;
      const fileMode = fs.statSync(dbPath).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);

      repo.close();
    });

    describe("F-P2-10: genuine v1 -> v2 migration", () => {
      const V1_LISTING_KEY = buildCanonicalListingKey({
        providerId: "rappi-authenticated-inspector",
        externalStoreId: "900130995-turbo-super",
        externalProductId: "2111457819",
        externalVariantId: "var-500ml",
        citySlug: "bogota",
        zoneCode: VALID_CTX_HASH_A,
      });
      const V1_PRODUCT_KEY = "rappi-authenticated-inspector::2111457819::var-500ml";
      const V1_STORE_KEY = "rappi-authenticated-inspector::900130995-turbo-super";
      const V1_PROVIDER = "rappi-authenticated-inspector";

      function buildLatestV1Batch(): SupervisedPersistenceContextInput {
        return makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "2111457819",
              observedPriceCop: 39_900,
              sourceObservedAt: "2026-11-07T14:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-v1-latest", observedAtIso: "2026-11-07T14:00:00.000Z" },
        );
      }

      /** Builds a deterministic, genuine v1 database from the pre-v2 schema fixture. */
      function createGenuineV1Database(targetPath: string): void {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        const schemaSql = fs.readFileSync(
          path.join(import.meta.dirname, "fixtures", "schema-v1-pre-v2.sql"),
          "utf8",
        );
        const raw = new DatabaseSync(targetPath);
        raw.exec("PRAGMA foreign_keys = ON;");
        raw.exec(schemaSql);
        raw
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, '001_initial_private_price_history_schema', '2026-11-01T00:00:00.000Z')",
          )
          .run();
        raw
          .prepare(
            `INSERT INTO fulfillment_contexts (fulfillment_context_id, provider_id, verified_city_slug, verified_city_name, context_verification_status, active_address_evidence, city_metadata_evidence, serving_branch_evidence, catalog_context_evidence, pricing_verification_verdict, first_seen_at, last_seen_at)
             VALUES (?, ?, 'bogota', 'Bogotá D.C.', 'PROVISIONAL_SESSION_CONTEXT', 'VERIFIED_ACTIVE_SELECTION', 'VERIFIED_FROM_ACTIVE_CONTEXT', 'UNVERIFIED_STATIC_DEFAULT_BRANCH', 'PROVISIONAL_LIVE_DOM_DIVERGES_FROM_STATIC_HYDRATION', 'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION', '2026-11-01T14:00:00.000Z', '2026-11-07T14:00:00.000Z')`,
          )
          .run(VALID_CTX_HASH_A, V1_PROVIDER);
        raw
          .prepare(
            `INSERT INTO stores (store_key, provider_id, external_store_id, storefront_slug, store_name, category_slug, verified_city_slug, verified_city_name, first_seen_at, last_seen_at)
             VALUES (?, ?, '900130995-turbo-super', '900130995-turbo-super', 'Turbo Super', 'supermercados', 'bogota', 'Bogotá D.C.', '2026-11-01T14:00:00.000Z', '2026-11-07T14:00:00.000Z')`,
          )
          .run(V1_STORE_KEY, V1_PROVIDER);
        raw
          .prepare(
            `INSERT INTO products (product_variant_key, provider_id, external_product_id, external_variant_id, product_name, brand, category_slug, packaging_label, unit_quantity, unit_type, canonical_product_url, first_seen_at, last_seen_at)
             VALUES (?, ?, '2111457819', 'var-500ml', 'Aceite de Oliva Extra Virgen', 'Carbonell', 'supermercados', '500 ml', 500, 'ml', 'https://www.rappi.com.co/p/aceite-oliva-2111457819', '2026-11-01T14:00:00.000Z', '2026-11-07T14:00:00.000Z')`,
          )
          .run(V1_PRODUCT_KEY, V1_PROVIDER);

        const latestFingerprint = computeScanBatchFingerprint(
          buildLatestV1Batch(),
          "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
          "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
        );
        const insertScan = raw.prepare(
          `INSERT INTO scan_runs (scan_run_id, batch_fingerprint, started_at, completed_at, status, provider_id, store_key, fulfillment_context_id, candidates_discovered, valid_observations, skipped_records, duplicate_records, opportunities_created)
           VALUES (?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, 1, 1, 0, 0, ?)`,
        );
        const insertObs = raw.prepare(
          `INSERT INTO price_observations (observation_id, idempotency_key, listing_key, scan_run_id, product_variant_key, store_key, fulfillment_context_id, city_slug, observed_price_cop, declared_reference_price_cop, availability, observed_at, provenance, geographic_verification_verdict, serving_branch_evidence, catalog_context_evidence, address_specific_pricing_verified, is_superseded)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'bogota', ?, NULL, 'IN_STOCK', ?, 'PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL', 'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION', 'UNVERIFIED_STATIC_DEFAULT_BRANCH', 'PROVISIONAL_LIVE_DOM_DIVERGES_FROM_STATIC_HYDRATION', 0, 0)`,
        );
        for (const [scanId, iso, price, fingerprint, opps] of [
          ["scan-v1-a", "2026-11-01T14:00:00.000Z", 65_000, "v1-fixture-fp-a", 0],
          ["scan-v1-b", "2026-11-02T14:00:00.000Z", 65_000, "v1-fixture-fp-b", 0],
          ["scan-v1-latest", "2026-11-07T14:00:00.000Z", 39_900, latestFingerprint, 1],
        ] as const) {
          insertScan.run(
            scanId,
            fingerprint,
            iso,
            iso,
            V1_PROVIDER,
            V1_STORE_KEY,
            VALID_CTX_HASH_A,
            opps,
          );
          insertObs.run(
            `obs-${scanId}`,
            `idem-${scanId}`,
            V1_LISTING_KEY,
            scanId,
            V1_PRODUCT_KEY,
            V1_STORE_KEY,
            VALID_CTX_HASH_A,
            price,
            iso,
          );
        }
        raw
          .prepare(
            `INSERT INTO opportunity_events (opportunity_id, deduplication_key, listing_key, observation_id, scan_run_id, product_variant_key, store_key, fulfillment_context_id, opportunity_type, label_es_co, baseline_price_cop, previous_price_cop, observed_price_cop, savings_cop, discount_basis_points, discount_percentage, historical_observation_count, historical_low_cop, historical_median_cop, confidence, requires_verification, provenance, geographic_verification_verdict, rationale_es_co, detected_at, lifecycle_status)
             VALUES ('opp-v1-fixture', 'v1-fixture-dedup', ?, 'obs-scan-v1-latest', 'scan-v1-latest', ?, ?, ?, 'HISTORICAL_LOW', 'Mínimo histórico', 65000, 65000, 39900, 25100, 3862, 39, 2, 65000, 65000, 'MEDIUM', 1, 'PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL', 'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION', 'Fixture determinista v1', '2026-11-07T14:00:00.000Z', 'ACTIVE')`,
          )
          .run(V1_LISTING_KEY, V1_PRODUCT_KEY, V1_STORE_KEY, VALID_CTX_HASH_A);
        raw.close();
      }

      function columnNames(raw: DatabaseSync, table: string): string[] {
        return (
          raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        ).map((c) => c.name);
      }

      function tableExists(raw: DatabaseSync, table: string): boolean {
        return (
          raw
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) !== undefined
        );
      }

      it("opens an authentic v1 database, migrates it to v2 preserving all data, and is idempotent on reopen", () => {
        createGenuineV1Database(dbPath);

        // 3. v2-only artifacts are absent before migration
        const before = new DatabaseSync(dbPath);
        expect(columnNames(before, "opportunity_events")).not.toContain("event_origin");
        expect(columnNames(before, "opportunity_events")).not.toContain(
          "reevaluation_run_id",
        );
        expect(tableExists(before, "reevaluation_runs")).toBe(false);
        expect(
          (
            before.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
              v: number;
            }
          ).v,
        ).toBe(1);
        before.close();

        // 4-5. open with the current repository
        const repo = new SqlitePrivateHistoryRepository(dbPath);
        const status = repo.getDatabaseStatus();
        expect(status.schemaVersion).toBe(2);
        expect(status.counts.activeObservations).toBe(3);
        expect(status.counts.scanRuns).toBe(3);

        const runs = repo.listRecentScanRuns();
        expect(runs).toHaveLength(3);
        expect(
          runs.find((r) => r.scanRunId === "scan-v1-latest")?.opportunitiesCreated,
        ).toBe(1);
        expect(runs.find((r) => r.scanRunId === "scan-v1-a")?.opportunitiesCreated).toBe(
          0,
        );

        const active = repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" });
        expect(active).toHaveLength(1);
        expect(active[0]?.opportunityId).toBe("opp-v1-fixture");
        expect(active[0]?.eventOrigin).toBe("ORIGINAL_SCAN");
        expect(active[0]?.reevaluationRunId).toBeUndefined();
        expect(active[0]?.baselinePriceCop).toBe(65_000);

        // successful idempotent replay of the original v1 scan after migration
        const replay = repo.persistApprovedInspectionBatch(buildLatestV1Batch(), {
          ownerConfirmed: true,
        });
        expect(replay.persisted).toBe(true);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.reason).toBe("IDEMPOTENT_SCAN_RUN_REPLAY");
        repo.close();

        // valid foreign keys + v2 artifacts present + reopen idempotency
        const after = new DatabaseSync(dbPath);
        after.exec("PRAGMA foreign_keys = ON;");
        expect(after.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
        expect(columnNames(after, "opportunity_events")).toContain("event_origin");
        expect(tableExists(after, "reevaluation_runs")).toBe(true);
        const migrationsAfterFirst = after
          .prepare(
            "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
          )
          .all();
        expect(
          migrationsAfterFirst.map((m) => (m as { version: number }).version),
        ).toEqual([1, 2]);
        after.close();

        const reopened = new SqlitePrivateHistoryRepository(dbPath);
        expect(reopened.getDatabaseStatus().schemaVersion).toBe(2);
        reopened.close();
        const afterReopen = new DatabaseSync(dbPath);
        expect(
          afterReopen
            .prepare(
              "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
            )
            .all(),
        ).toEqual(migrationsAfterFirst);
        afterReopen.close();
      });

      it("supports explicit reevaluation on a migrated v1 database: legacy event is preserved as SUPERSEDED and replaced by a HISTORICAL_REEVALUATION event", () => {
        createGenuineV1Database(dbPath);
        const repo = new SqlitePrivateHistoryRepository(dbPath);
        const reeval = repo.reevaluateLatestListingOpportunities({
          evaluationTimeIso: "2026-11-07T15:00:00.000Z",
        });
        expect(reeval.listingsEvaluated).toBe(1);
        expect(reeval.opportunitiesInserted).toBe(1);

        const active = repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" });
        expect(active).toHaveLength(1);
        expect(active[0]?.eventOrigin).toBe("HISTORICAL_REEVALUATION");
        const legacy = repo.listDetectedOpportunities({ lifecycleStatus: "SUPERSEDED" });
        expect(legacy.map((o) => o.opportunityId)).toContain("opp-v1-fixture");
        expect(
          repo.listRecentScanRuns().find((r) => r.scanRunId === "scan-v1-latest")
            ?.opportunitiesCreated,
        ).toBe(1);
        repo.close();
      });

      it("rolls back the entire v2 migration atomically when it fails midway, leaving a pristine v1 database that migrates on the next open", () => {
        createGenuineV1Database(dbPath);

        expect(
          () =>
            new SqlitePrivateHistoryRepository(dbPath, {
              simulateMigrationFailureAfterV2Step: "ADD_COLUMNS",
            }),
        ).toThrow(/simulated migration failure/i);

        const raw = new DatabaseSync(dbPath);
        expect(columnNames(raw, "opportunity_events")).not.toContain("event_origin");
        expect(columnNames(raw, "opportunity_events")).not.toContain(
          "reevaluation_run_id",
        );
        expect(tableExists(raw, "reevaluation_runs")).toBe(false);
        expect(
          (
            raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
              v: number;
            }
          ).v,
        ).toBe(1);
        expect(
          (
            raw.prepare("SELECT COUNT(*) AS c FROM opportunity_events").get() as {
              c: number;
            }
          ).c,
        ).toBe(1);
        raw.close();

        const repo = new SqlitePrivateHistoryRepository(dbPath);
        expect(repo.getDatabaseStatus().schemaVersion).toBe(2);
        expect(
          repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" }),
        ).toHaveLength(1);
        repo.close();
      });
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

  describe("Adversarial Review Round 2 — F-P2-06, F-P2-07 & Out-of-Order Import Regressions", () => {
    it("F-P2-06: replaying an existing observation after subsequent historical records must NOT generate new opportunities or supersede active opportunities", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      // 1. Original observation at T1 (2026-11-05T14:00:05.000Z) @ $45.000 — first observation ever (0 opportunities)
      const obsT1 = makeProvisionalListing({
        externalProductId: "2111457819",
        observedPriceCop: 45_000,
        sourceObservedAt: "2026-11-05T14:00:05.000Z",
      });
      const saveT1 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([obsT1], {
          scanRunId: "scan-t1-original",
          observedAtIso: "2026-11-05T14:00:05.000Z",
        }),
        { ownerConfirmed: true },
      );
      expect(saveT1.observationsInserted).toBe(1);
      expect(saveT1.opportunitiesInserted).toBe(0);

      // 2. Earlier baseline observations T0a (2026-11-01 @ $65.000) and T0b (2026-11-02 @ $65.000) are imported,
      //    followed by a newer observation T2 (2026-11-07 @ $39.900) which creates an ACTIVE HISTORICAL_LOW at $39.900
      repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "2111457819",
              observedPriceCop: 65_000,
              sourceObservedAt: "2026-11-01T14:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-t0a", observedAtIso: "2026-11-01T14:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );
      repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "2111457819",
              observedPriceCop: 65_000,
              sourceObservedAt: "2026-11-02T14:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-t0b", observedAtIso: "2026-11-02T14:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );

      const saveT2 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "2111457819",
              observedPriceCop: 39_900,
              sourceObservedAt: "2026-11-07T14:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-t2-latest", observedAtIso: "2026-11-07T14:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );
      expect(saveT2.observationsInserted).toBe(1);
      expect(saveT2.opportunitiesInserted).toBe(1);

      const activeBeforeReplay = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(activeBeforeReplay).toHaveLength(1);
      expect(activeBeforeReplay[0]?.observedPriceCop).toBe(39_900);

      // 3. Replay T1 ($45.000 at 2026-11-05T14:00:05.000Z or within same minute bucket 14:00:45.000Z)
      //    with evaluationTimeIso 3 hours after T2 (outside cooldown window):
      //    wasInserted is false -> MUST NOT create a new $45.000 opportunity and MUST NOT supersede T2's $39.900 opportunity!
      const replayT1 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([obsT1], {
          scanRunId: "scan-t1-replay",
          observedAtIso: "2026-11-07T18:00:00.000Z",
        }),
        { ownerConfirmed: true },
      );
      expect(replayT1.observationsInserted).toBe(0);
      expect(replayT1.observationsSkippedDuplicate).toBe(1);
      expect(replayT1.opportunitiesInserted).toBe(0);

      const activeAfterReplay = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(activeAfterReplay).toHaveLength(1);
      expect(activeAfterReplay[0]?.observedPriceCop).toBe(39_900);
      expect(repo.getDatabaseStatus().counts.activeObservations).toBe(4);
      expect(repo.getDatabaseStatus().counts.activeOpportunities).toBe(1);

      repo.close();
    });

    it("Targeted Check #1: out-of-order historical imports cannot emit stale current alerts or supersede newer active opportunities", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      // Persist T0a (Nov 1 @ $65k), T0b (Nov 2 @ $65k), and T3 (Nov 7 @ $39.9k -> ACTIVE opportunity)
      for (const [id, iso, price] of [
        ["scan-nov1", "2026-11-01T14:00:00.000Z", 65_000],
        ["scan-nov2", "2026-11-02T14:00:00.000Z", 65_000],
        ["scan-nov7", "2026-11-07T14:00:00.000Z", 39_900],
      ] as const) {
        repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput(
            [
              makeProvisionalListing({
                externalProductId: "2111457819",
                observedPriceCop: price,
                sourceObservedAt: iso,
              }),
            ],
            { scanRunId: id, observedAtIso: iso },
          ),
          { ownerConfirmed: true },
        );
      }

      expect(repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" })).toHaveLength(
        1,
      );
      expect(
        repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" })[0]
          ?.observedPriceCop,
      ).toBe(39_900);

      // Now import an out-of-order historical observation from Nov 4 @ $48.000 (older than Nov 7!)
      const backfillNov4 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "2111457819",
              observedPriceCop: 48_000,
              sourceObservedAt: "2026-11-04T14:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-backfill-nov4", observedAtIso: "2026-11-08T10:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );

      // The historical observation is recorded, but because a newer observation (Nov 7) already exists,
      // the Nov 4 backfill must NOT emit a misleading current opportunity or supersede Nov 7's $39.900 opportunity
      expect(backfillNov4.observationsInserted).toBe(1);
      expect(backfillNov4.opportunitiesInserted).toBe(0);

      const activeOpportunities = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(activeOpportunities).toHaveLength(1);
      expect(activeOpportunities[0]?.observedPriceCop).toBe(39_900);

      repo.close();
    });

    it("F-P2-07: enforces idempotent scan_run_id replay, preserves counters, rejects conflicting scan_run_id reuse, and recovers cleanly after partial failure", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      // Baseline history so scan-target creates 1 observation and 1 opportunity
      for (const [id, iso] of [
        ["scan-base-1", "2026-11-01T14:00:00.000Z"],
        ["scan-base-2", "2026-11-02T14:00:00.000Z"],
      ] as const) {
        repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput(
            [
              makeProvisionalListing({
                externalProductId: "2111457819",
                observedPriceCop: 65_000,
                sourceObservedAt: iso,
              }),
            ],
            { scanRunId: id, observedAtIso: iso },
          ),
          { ownerConfirmed: true },
        );
      }

      const targetBatch = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "2111457819",
            observedPriceCop: 39_900,
            sourceObservedAt: "2026-11-07T14:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-target", observedAtIso: "2026-11-07T14:00:00.000Z" },
      );

      // 1. Partial-failure recovery: first attempt with scan-target crashes mid-transaction -> rolled back
      const failedAttempt = repo.persistApprovedInspectionBatch(targetBatch, {
        ownerConfirmed: true,
        simulateCrashAfterObservationsInserted: 1,
      });
      expect(failedAttempt.persisted).toBe(false);
      expect(failedAttempt.reason).toBe("TRANSACTION_FAILED");
      expect(
        repo.listRecentScanRuns().find((r) => r.scanRunId === "scan-target"),
      ).toBeUndefined();

      // 2. Retry same scan-target after transient failure -> succeeds cleanly with validObservations=1, opportunitiesCreated=1
      const firstSuccess = repo.persistApprovedInspectionBatch(targetBatch, {
        ownerConfirmed: true,
      });
      expect(firstSuccess.persisted).toBe(true);
      expect(firstSuccess.observationsInserted).toBe(1);
      expect(firstSuccess.opportunitiesInserted).toBe(1);

      const runAfterSuccess = repo
        .listRecentScanRuns()
        .find((r) => r.scanRunId === "scan-target");
      expect(runAfterSuccess?.status).toBe("SUCCEEDED");
      expect(runAfterSuccess?.validObservations).toBe(1);
      expect(runAfterSuccess?.opportunitiesCreated).toBe(1);
      expect(runAfterSuccess?.duplicateRecords).toBe(0);

      // 3. Identical replay with the SAME scan_run_id ("scan-target") -> idempotent no-op, MUST NOT overwrite validObservations=1 or opportunitiesCreated=1!
      const identicalReplay = repo.persistApprovedInspectionBatch(targetBatch, {
        ownerConfirmed: true,
      });
      expect(identicalReplay.persisted).toBe(true);
      expect(identicalReplay.idempotentReplay).toBe(true);
      expect(identicalReplay.reason).toBe("IDEMPOTENT_SCAN_RUN_REPLAY");
      expect(identicalReplay.observationsInserted).toBe(0);
      expect(identicalReplay.opportunitiesInserted).toBe(0);

      const runAfterIdenticalReplay = repo
        .listRecentScanRuns()
        .find((r) => r.scanRunId === "scan-target");
      expect(runAfterIdenticalReplay?.status).toBe("SUCCEEDED");
      expect(runAfterIdenticalReplay?.validObservations).toBe(1);
      expect(runAfterIdenticalReplay?.opportunitiesCreated).toBe(1);
      expect(runAfterIdenticalReplay?.duplicateRecords).toBe(0);

      // 4. Conflicting replay with the SAME scan_run_id ("scan-target") but different batch data -> rejected without modifying scan-target!
      const conflictingBatch = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "9999999999",
            name: "Producto Conflicto",
            observedPriceCop: 12_000,
            sourceObservedAt: "2026-11-08T14:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-target", observedAtIso: "2026-11-08T14:00:00.000Z" },
      );
      const conflictingResult = repo.persistApprovedInspectionBatch(conflictingBatch, {
        ownerConfirmed: true,
      });
      expect(conflictingResult.persisted).toBe(false);
      expect(conflictingResult.reason).toBe("CONFLICTING_SCAN_RUN_ID");
      expect(repo.getProductPriceHistory("9999999999")).toHaveLength(0);

      const runAfterConflict = repo
        .listRecentScanRuns()
        .find((r) => r.scanRunId === "scan-target");
      expect(runAfterConflict?.status).toBe("SUCCEEDED");
      expect(runAfterConflict?.validObservations).toBe(1);
      expect(runAfterConflict?.opportunitiesCreated).toBe(1);

      repo.close();
    });

    it("F-P2-06: supports explicit reevaluateLatestListingOpportunities as a separate operation after historical backfills", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      // 1. Latest observation T1 (Nov 7 @ $39.900) is saved first -> 0 prior history -> 0 opportunities
      repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(
          [
            makeProvisionalListing({
              externalProductId: "2111457819",
              observedPriceCop: 39_900,
              sourceObservedAt: "2026-11-07T14:00:00.000Z",
            }),
          ],
          { scanRunId: "scan-nov7-first", observedAtIso: "2026-11-07T14:00:00.000Z" },
        ),
        { ownerConfirmed: true },
      );

      // 2. Backfill earlier observations Nov 1 ($65k) and Nov 2 ($65k) -> backfills do not implicitly emit alerts
      for (const [id, iso] of [
        ["scan-backfill-1", "2026-11-01T14:00:00.000Z"],
        ["scan-backfill-2", "2026-11-02T14:00:00.000Z"],
      ] as const) {
        repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput(
            [
              makeProvisionalListing({
                externalProductId: "2111457819",
                observedPriceCop: 65_000,
                sourceObservedAt: iso,
              }),
            ],
            { scanRunId: id, observedAtIso: iso },
          ),
          { ownerConfirmed: true },
        );
      }

      expect(repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" })).toHaveLength(
        0,
      );

      // 3. Explicit separate reevaluation evaluates the chronologically latest observation (Nov 7 @ $39.900) against Nov 1 & Nov 2
      const reeval = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T15:00:00.000Z",
      });
      expect(reeval.listingsEvaluated).toBe(1);
      expect(reeval.opportunitiesInserted).toBe(1);

      const activeAfterReeval = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(activeAfterReeval).toHaveLength(1);
      expect(activeAfterReeval[0]?.observedPriceCop).toBe(39_900);
      expect(activeAfterReeval[0]?.previousPriceCop).toBe(65_000);

      repo.close();
    });

    it("F-P2-08: replaying the original scan_run_id with identical batch fingerprint after reevaluateLatestListingOpportunities() must succeed without transaction-integrity failure while preserving immutable scan_runs.opportunities_created", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      // 1. Save a first observation at $39,900 with zero historical opportunities
      const firstBatch = makeSupervisedBatchInput(
        [
          makeProvisionalListing({
            externalProductId: "2111457819",
            observedPriceCop: 39_900,
            sourceObservedAt: "2026-11-07T14:00:00.000Z",
          }),
        ],
        { scanRunId: "scan-nov7-first", observedAtIso: "2026-11-07T14:00:00.000Z" },
      );

      const firstSave = repo.persistApprovedInspectionBatch(firstBatch, {
        ownerConfirmed: true,
      });
      expect(firstSave.persisted).toBe(true);
      expect(firstSave.observationsInserted).toBe(1);
      expect(firstSave.opportunitiesInserted).toBe(0);

      // 2. Backfill two older observations at $65,000
      for (const [id, iso] of [
        ["scan-backfill-1", "2026-11-01T14:00:00.000Z"],
        ["scan-backfill-2", "2026-11-02T14:00:00.000Z"],
      ] as const) {
        repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput(
            [
              makeProvisionalListing({
                externalProductId: "2111457819",
                observedPriceCop: 65_000,
                sourceObservedAt: iso,
              }),
            ],
            { scanRunId: id, observedAtIso: iso },
          ),
          { ownerConfirmed: true },
        );
      }

      // 3. Run reevaluateLatestListingOpportunities()
      const reeval = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T15:00:00.000Z",
      });

      // 4. Confirm that a new historical opportunity is created
      expect(reeval.opportunitiesInserted).toBe(1);
      expect(reeval.reevaluationRunId).toMatch(/^reeval::/);
      const activeOpportunities = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(activeOpportunities).toHaveLength(1);
      expect(activeOpportunities[0]?.observedPriceCop).toBe(39_900);
      expect(activeOpportunities[0]?.eventOrigin).toBe("HISTORICAL_REEVALUATION");
      expect(activeOpportunities[0]?.reevaluationRunId).toBe(reeval.reevaluationRunId);

      // 5. Replay the original scan_run_id ("scan-nov7-first") with the identical batch fingerprint
      const replayAfterReeval = repo.persistApprovedInspectionBatch(firstBatch, {
        ownerConfirmed: true,
      });

      // 6. Assert that legitimate reevaluation does NOT cause a transaction-integrity failure,
      //    and original scan_runs.opportunities_created remains immutably 0
      expect(replayAfterReeval.persisted).toBe(true);
      expect(replayAfterReeval.idempotentReplay).toBe(true);
      expect(replayAfterReeval.reason).toBe("IDEMPOTENT_SCAN_RUN_REPLAY");

      const originalRun = repo
        .listRecentScanRuns()
        .find((r) => r.scanRunId === "scan-nov7-first");
      expect(originalRun?.status).toBe("SUCCEEDED");
      expect(originalRun?.validObservations).toBe(1);
      expect(originalRun?.opportunitiesCreated).toBe(0);

      repo.close();
    });

    it("Round 3 Additional Check: superseding historical baseline observations recalculates or invalidates stale ACTIVE opportunity baselines on reevaluation", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      // 1. Save 4 historical observations: two inflated ($80,000) and two normal ($50,000),
      //    followed by latest observation at $39,900 -> produces HISTORICAL_LOW against median $65,000 (savings $25,100, 3862 bps)
      for (const [id, iso, price] of [
        ["scan-h1", "2026-11-01T14:00:00.000Z", 80_000],
        ["scan-h2", "2026-11-02T14:00:00.000Z", 80_000],
        ["scan-h3", "2026-11-03T14:00:00.000Z", 50_000],
        ["scan-h4", "2026-11-04T14:00:00.000Z", 50_000],
        ["scan-latest", "2026-11-07T14:00:00.000Z", 39_900],
      ] as const) {
        repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput(
            [
              makeProvisionalListing({
                externalProductId: "2111457819",
                observedPriceCop: price,
                sourceObservedAt: iso,
              }),
            ],
            { scanRunId: id, observedAtIso: iso },
          ),
          { ownerConfirmed: true },
        );
      }

      const initialActive = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(initialActive).toHaveLength(1);
      expect(initialActive[0]?.baselinePriceCop).toBe(65_000);
      expect(initialActive[0]?.savingsCop).toBe(25_100);
      expect(initialActive[0]?.discountBasisPoints).toBe(3862);
      expect(initialActive[0]?.historicalObservationCount).toBe(4);

      // 2. Mark the two erroneous $80,000 baseline observations (scan-h1, scan-h2) as superseded
      const allHistory = repo.getProductPriceHistory("2111457819");
      const h1Obs = allHistory.find((o) => o.scanRunId === "scan-h1");
      const h2Obs = allHistory.find((o) => o.scanRunId === "scan-h2");
      expect(h1Obs).toBeDefined();
      expect(h2Obs).toBeDefined();

      repo.markObservationSuperseded(
        h1Obs?.observationId ?? "",
        "Precio base erróneo corregido",
      );
      repo.markObservationSuperseded(
        h2Obs?.observationId ?? "",
        "Precio base erróneo corregido",
      );

      // 3. Reevaluate latest opportunities -> must supersede the stale $65,000-baseline opportunity
      //    and replace it with the recalculated $50,000-baseline opportunity (savings $10,100, 2020 bps, count=2)
      const reevalAfterCorrection = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T14:05:00.000Z",
      });
      expect(reevalAfterCorrection.opportunitiesSuperseded).toBe(1);
      expect(reevalAfterCorrection.opportunitiesInserted).toBe(1);

      const updatedActive = repo.listDetectedOpportunities({
        lifecycleStatus: "ACTIVE",
      });
      expect(updatedActive).toHaveLength(1);
      expect(updatedActive[0]?.baselinePriceCop).toBe(50_000);
      expect(updatedActive[0]?.savingsCop).toBe(10_100);
      expect(updatedActive[0]?.discountBasisPoints).toBe(2020);
      expect(updatedActive[0]?.historicalObservationCount).toBe(2);

      // 4. Now supersede scan-h3 ($50,000) so only 1 prior observation remains (< minHistoryForDrop=2):
      //    reevaluation must invalidate the active HISTORICAL_LOW so 0 stale ACTIVE opportunities remain!
      const h3Obs = allHistory.find((o) => o.scanRunId === "scan-h3");
      repo.markObservationSuperseded(
        h3Obs?.observationId ?? "",
        "Segundo ajuste de historial",
      );

      const reevalInvalidated = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T14:10:00.000Z",
      });
      expect(reevalInvalidated.opportunitiesSuperseded).toBe(1);
      expect(reevalInvalidated.opportunitiesInserted).toBe(0);
      expect(repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" })).toHaveLength(
        0,
      );

      repo.close();
    });
  });

  describe("Adversarial Review Round 4 — F-P2-09 reactivation semantics", () => {
    function seedBaselineAScenario(repo: SqlitePrivateHistoryRepository): void {
      for (const [id, iso, price] of [
        ["scan-h1", "2026-11-01T14:00:00.000Z", 80_000],
        ["scan-h2", "2026-11-02T14:00:00.000Z", 80_000],
        ["scan-h3", "2026-11-03T14:00:00.000Z", 50_000],
        ["scan-h4", "2026-11-04T14:00:00.000Z", 50_000],
        ["scan-latest", "2026-11-07T14:00:00.000Z", 39_900],
      ] as const) {
        repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput(
            [
              makeProvisionalListing({
                externalProductId: "2111457819",
                observedPriceCop: price,
                sourceObservedAt: iso,
              }),
            ],
            { scanRunId: id, observedAtIso: iso },
          ),
          { ownerConfirmed: true },
        );
      }
    }

    function obsId(repo: SqlitePrivateHistoryRepository, scanRunId: string): string {
      const found = repo
        .getProductPriceHistory("2111457819")
        .find((o) => o.scanRunId === scanRunId);
      if (!found) throw new Error(`missing observation for ${scanRunId}`);
      return found.observationId;
    }

    it("F-P2-09: A -> B -> A baseline cycle leaves exactly one ACTIVE opportunity with baseline A and preserves every event", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      seedBaselineAScenario(repo);
      const h1 = obsId(repo, "scan-h1");
      const h2 = obsId(repo, "scan-h2");

      // 1. baseline A (median 65.000, 4 observations)
      const initial = repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" });
      expect(initial).toHaveLength(1);
      expect(initial[0]?.baselinePriceCop).toBe(65_000);
      const eventAId = initial[0]?.opportunityId ?? "";

      // 2-3. correct history -> baseline B; A superseded, B active
      repo.markObservationSuperseded(h1, "corrección 1");
      repo.markObservationSuperseded(h2, "corrección 1");
      const toB = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T14:05:00.000Z",
      });
      expect(toB.opportunitiesSuperseded).toBe(1);
      expect(toB.opportunitiesInserted).toBe(1);
      const activeB = repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" });
      expect(activeB).toHaveLength(1);
      expect(activeB[0]?.baselinePriceCop).toBe(50_000);
      const supersededA = repo.listDetectedOpportunities({
        lifecycleStatus: "SUPERSEDED",
      });
      expect(supersededA.map((o) => o.opportunityId)).toContain(eventAId);

      // 4-5. correct history again -> baseline A valid again
      expect(repo.restoreSupersededObservation(h1)).toBe(true);
      expect(repo.restoreSupersededObservation(h2)).toBe(true);
      const backToA = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T14:10:00.000Z",
      });
      expect(backToA.opportunitiesSuperseded).toBe(1);
      expect(backToA.opportunitiesReactivated).toBe(1);
      expect(backToA.opportunitiesInserted).toBe(0);

      // 6. exactly one correct ACTIVE opportunity with baseline A
      const activeAgain = repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" });
      expect(activeAgain).toHaveLength(1);
      expect(activeAgain[0]?.baselinePriceCop).toBe(65_000);
      expect(activeAgain[0]?.historicalObservationCount).toBe(4);
      expect(activeAgain[0]?.opportunityId).toBe(eventAId);

      // B is preserved (auditable) as SUPERSEDED, never deleted
      const supersededNow = repo.listDetectedOpportunities({
        lifecycleStatus: "SUPERSEDED",
      });
      expect(supersededNow.map((o) => o.baselinePriceCop)).toContain(50_000);
      expect(supersededNow.every((o) => o.opportunityId !== eventAId)).toBe(true);

      // Append-only audit trail of A: ACTIVE -> SUPERSEDED -> ACTIVE
      const trail = repo.listOpportunityLifecycleTransitions(eventAId);
      expect(trail.map((t) => `${t.fromStatus}>${t.toStatus}`)).toEqual([
        "ACTIVE>SUPERSEDED",
        "SUPERSEDED>ACTIVE",
      ]);
      expect(trail[1]?.reason).toBe("BASELINE_VALID_AGAIN_AFTER_HISTORY_CORRECTION");
      expect(trail[1]?.reevaluationRunId).toBe(backToA.reevaluationRunId);

      // Reevaluation is idempotent: no inserts, supersessions, reactivations or new transitions
      const replay = repo.reevaluateLatestListingOpportunities({
        evaluationTimeIso: "2026-11-07T14:15:00.000Z",
      });
      expect(replay.opportunitiesInserted).toBe(0);
      expect(replay.opportunitiesSuperseded).toBe(0);
      expect(replay.opportunitiesReactivated).toBe(0);
      expect(repo.listOpportunityLifecycleTransitions(eventAId)).toHaveLength(2);
      expect(repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" })).toHaveLength(
        1,
      );

      repo.close();
    });

    it("F-P2-09: reevaluation never reactivates DISMISSED or EXPIRED opportunities", () => {
      for (const terminal of ["DISMISSED", "EXPIRED"] as const) {
        const terminalDbPath = path.join(
          tempDir,
          `terminal-${terminal}`,
          "history.sqlite",
        );
        const repo = new SqlitePrivateHistoryRepository(terminalDbPath);
        seedBaselineAScenario(repo);
        const h1 = obsId(repo, "scan-h1");
        const h2 = obsId(repo, "scan-h2");
        const eventAId =
          repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" })[0]
            ?.opportunityId ?? "";

        // Owner/time moves A into a terminal state
        (
          repo as unknown as {
            db: { prepare: (sql: string) => { run: (...args: string[]) => unknown } };
          }
        ).db
          .prepare(
            "UPDATE opportunity_events SET lifecycle_status = ? WHERE opportunity_id = ?",
          )
          .run(terminal, eventAId);

        // History moves to B (A is terminal, not ACTIVE, so only B is created)...
        repo.markObservationSuperseded(h1, "corrección");
        repo.markObservationSuperseded(h2, "corrección");
        repo.reevaluateLatestListingOpportunities({
          evaluationTimeIso: "2026-11-07T14:05:00.000Z",
        });
        // ...and returns to baseline A: terminal A must stay terminal
        repo.restoreSupersededObservation(h1);
        repo.restoreSupersededObservation(h2);
        const result = repo.reevaluateLatestListingOpportunities({
          evaluationTimeIso: "2026-11-07T14:10:00.000Z",
        });

        expect(result.opportunitiesReactivated).toBe(0);
        expect(result.opportunitiesInserted).toBe(0);
        expect(
          repo.listDetectedOpportunities({ lifecycleStatus: "ACTIVE" }),
        ).toHaveLength(0);
        const terminalRows = repo.listDetectedOpportunities({
          lifecycleStatus: terminal,
        });
        expect(terminalRows.map((o) => o.opportunityId)).toEqual([eventAId]);
        repo.close();
      }
    });
  });

  describe("P2 Hotfix — field-aware privacy validation (product-name false positive)", () => {
    const LEGIT_NAMES = [
      "Manzana 6 unidades",
      "Manzana Roja x 6 und",
      "Casa 12 Chocolate Premium",
      "Café Casa 12 Onzas",
      "Torre 5 Galletas Surtidas",
      "Bloque 3 Queso Mozzarella",
      "Interior 2 Piezas de Pollo",
      "Pack 3 Jabón Rey 300 g",
    ] as const;

    function withUrl(listing: DiscoveredListing, productUrl: string): DiscoveredListing {
      return { ...listing, variant: { ...listing.variant, productUrl } };
    }

    function fictionalBatch(count: number): DiscoveredListing[] {
      return Array.from({ length: count }, (_, i) =>
        makeProvisionalListing({
          externalProductId: `fx-${String(1000 + i)}`,
          externalVariantId: `fx-${String(1000 + i)}-500g`,
          name:
            i % 7 === 0
              ? `Manzana ${String((i % 9) + 1)} unidades fixture`
              : `Producto Ficticio ${String(i)}`,
          packagingLabel: i % 5 === 0 ? "Bloque 3 x 500 g" : "500 g",
          unitQuantity: 500,
          unitType: "g",
          observedPriceCop: 5_000 + i * 100,
        }),
      );
    }

    it("accepts legitimate grocery names and packaging labels containing casa/torre/bloque/manzana + number", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const listings = LEGIT_NAMES.map((name, i) =>
        makeProvisionalListing({
          externalProductId: `legit-${String(i)}`,
          externalVariantId: `legit-${String(i)}-1unit`,
          name,
          packagingLabel: "Manzana x 6 und",
          unitType: "unit",
          unitQuantity: 6,
        }),
      );
      const result = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(listings, { scanRunId: "scan-legit-names" }),
        { ownerConfirmed: true },
      );
      expect(result.errorSummary).toBeUndefined();
      expect(result.persisted).toBe(true);
      expect(result.observationsInserted).toBe(LEGIT_NAMES.length);
      repo.close();
    });

    it("persists an eligible 73-product fictional batch atomically and preserves it after reopening SQLite", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const batch = makeSupervisedBatchInput(fictionalBatch(73), {
        scanRunId: "scan-73-fixture",
      });
      const result = repo.persistApprovedInspectionBatch(batch, { ownerConfirmed: true });
      expect(result.errorSummary).toBeUndefined();
      expect(result.persisted).toBe(true);
      expect(result.observationsInserted).toBe(73);
      expect(repo.getDatabaseStatus().counts.activeObservations).toBe(73);
      repo.close();

      const reopened = new SqlitePrivateHistoryRepository(dbPath);
      expect(reopened.getDatabaseStatus().counts.activeObservations).toBe(73);
      const replay = reopened.persistApprovedInspectionBatch(batch, {
        ownerConfirmed: true,
      });
      expect(replay.idempotentReplay).toBe(true);
      reopened.close();
    });

    it("rejects an explicit delivery address in a product name without partial writes and without leaking the matched text", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const listings = fictionalBatch(73);
      listings[40] = makeProvisionalListing({
        externalProductId: "fx-unsafe",
        externalVariantId: "fx-unsafe-1unit",
        name: "Entrega en Calle 85 # 15-20 Apto 402",
      });
      const result = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(listings, { scanRunId: "scan-unsafe-address" }),
        { ownerConfirmed: true },
      );
      expect(result.persisted).toBe(false);
      expect(result.reason).toBe("TRANSACTION_FAILED");
      expect(result.errorSummary).toMatch(/field 'productName'/);
      expect(result.errorSummary).toMatch(/rule=ADDRESS_/);
      expect(result.errorSummary).toMatch(/subject=product-index=40/);
      expect(result.errorSummary).not.toMatch(/85|15-20|402|Calle/i);
      const counts = repo.getDatabaseStatus().counts;
      expect(counts.activeObservations).toBe(0);
      expect(counts.scanRuns).toBe(0);
      expect(counts.products).toBe(0);
      repo.close();
    });

    it("rejects credentials, session tokens and emails in labels and URLs, and validates packaging labels too", () => {
      const base = makeProvisionalListing({
        externalProductId: "cred-1",
        externalVariantId: "cred-1-1unit",
      });
      const unsafeListings: Array<[string, DiscoveredListing, RegExp]> = [
        [
          "token in name",
          makeProvisionalListing({
            externalProductId: "cred-2",
            externalVariantId: "cred-2-1unit",
            name: "Leche Bearer abcdefghijklmnop",
          }),
          /rule=AUTH_BEARER_TOKEN/,
        ],
        [
          "session assignment in name",
          makeProvisionalListing({
            externalProductId: "cred-3",
            externalVariantId: "cred-3-1unit",
            name: "Arroz cf_clearance=abc123",
          }),
          /rule=AUTH_SESSION_ASSIGNMENT/,
        ],
        [
          "email in packaging label",
          makeProvisionalListing({
            externalProductId: "cred-4",
            externalVariantId: "cred-4-1unit",
            packagingLabel: "dueno@example.com",
          }),
          /field 'packagingLabel'.*rule=PII_EMAIL/,
        ],
        [
          "token in URL query",
          withUrl(base, "https://www.rappi.com.co/p/leche-1?access_token=abc"),
          /field 'productUrl'.*rule=AUTH_SESSION_ASSIGNMENT/,
        ],
        [
          "benign-looking sensitive query parameter",
          withUrl(base, "https://www.rappi.com.co/p/leche-1?session=abc"),
          /rule=URL_SENSITIVE_QUERY_PARAMETER/,
        ],
        [
          "credentials in URL authority",
          withUrl(base, "https://user:pass@www.rappi.com.co/p/leche-1"),
          /rule=URL_EMBEDDED_CREDENTIALS/,
        ],
      ];
      let n = 0;
      for (const [label, listing, expected] of unsafeListings) {
        n += 1;
        const repo = new SqlitePrivateHistoryRepository(
          path.join(tempDir, `cred-${String(n)}`, "h.sqlite"),
        );
        const result = repo.persistApprovedInspectionBatch(
          makeSupervisedBatchInput([listing], { scanRunId: `scan-cred-${String(n)}` }),
          { ownerConfirmed: true },
        );
        expect(result.persisted, label).toBe(false);
        expect(result.errorSummary, label).toMatch(expected);
        expect(repo.getDatabaseStatus().counts.activeObservations, label).toBe(0);
        repo.close();
      }
    });

    it("accepts legitimate URLs whose path contains 10-digit ids starting with 3 and never treats them as phone numbers", () => {
      expect(() =>
        assertPersistedFieldSafe(
          "https://www.rappi.com.co/p/leche-3101234567",
          "productUrl",
          "PRODUCT_URL",
        ),
      ).not.toThrow();
      expect(() =>
        assertPersistedFieldSafe("3101234567-500g", "externalVariantId", "STRICT_ID"),
      ).not.toThrow();
    });

    it("keeps strict validation for free text, ids and opaque context identifiers", () => {
      for (const risky of ["Calle 85 # 15-20 Apto 402", "Torre 5", "Casa 12"]) {
        expect(() => assertPersistedFieldSafe(risky, "note", "FREE_TEXT")).toThrow(
          /Privacy violation prevented/,
        );
      }
      expect(() =>
        assertPersistedFieldSafe("Carrera 11 # 93-10", "productName", "PRODUCT_LABEL"),
      ).toThrow(/rule=ADDRESS_STREET_COMPLETE/);
      expect(() =>
        assertPersistedFieldSafe(
          "Calle 72 con Carrera 10",
          "productName",
          "PRODUCT_LABEL",
        ),
      ).toThrow(/rule=ADDRESS_STREET_CROSS/);
      expect(() =>
        assertPersistedFieldSafe("Manzana 6 Casa 12", "productName", "PRODUCT_LABEL"),
      ).toThrow(/rule=ADDRESS_MULTIPLE_UNIT_DESIGNATORS/);
      expect(() =>
        assertPersistedFieldSafe("+57 310 555 1234", "productName", "PRODUCT_LABEL"),
      ).toThrow(/rule=PII_PHONE/);
      expect(() =>
        assertPersistedFieldSafe("owner@example.com", "externalProductId", "STRICT_ID"),
      ).toThrow(/rule=PII_EMAIL/);
      expect(() =>
        assertPersistedFieldSafe("has space", "externalProductId", "STRICT_ID"),
      ).toThrow(/rule=ID_INVALID_FORMAT/);
      expect(() =>
        assertPersistedFieldSafe("ctx-not-opaque", "ctx", "OPAQUE_CONTEXT_ID"),
      ).toThrow(/rule=CONTEXT_ID_NOT_OPAQUE/);
      expect(() =>
        assertPersistedFieldSafe(VALID_CTX_HASH_A, "ctx", "OPAQUE_CONTEXT_ID"),
      ).not.toThrow();
    });

    it("keeps HMAC and provenance constraints intact for the 73-product path", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);
      const listings = fictionalBatch(73);
      const missingHmac = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(listings, {
          scanRunId: "scan-no-hmac",
          fulfillmentContextHash: "not-an-opaque-id",
          pricingVerificationVerdict: "UNVERIFIED_MISSING_HMAC_SECRET",
        }),
        { ownerConfirmed: true },
      );
      expect(missingHmac.persisted).toBe(false);
      expect(missingHmac.reason).toBe("INELIGIBLE_BATCH");

      const ok = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput(listings, { scanRunId: "scan-hmac-ok" }),
        { ownerConfirmed: true },
      );
      expect(ok.persisted).toBe(true);
      const history = repo.getProductPriceHistory("fx-1000");
      expect(history[0]?.provenance).toBe("PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL");
      repo.close();
    });
  });

  describe("Phase P3 — Supervised Catalog Coverage & Multi-View Ingestion", () => {
    it("reports new vs previously known products in batch preview and updates on progressive views", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      const prod1 = makeProvisionalListing({
        externalProductId: "prod-1",
        observedPriceCop: 10000,
      });
      const prod2 = makeProvisionalListing({
        externalProductId: "prod-2",
        observedPriceCop: 15000,
      });
      const prod3 = makeProvisionalListing({
        externalProductId: "prod-3",
        observedPriceCop: 20000,
      });

      // View 1 preview: all 3 products are new
      const preview1 = repo.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([prod1, prod2, prod3], {
          scanRunId: "p3-scan-1",
          sourceView: {
            viewKey: "/tiendas/turbo",
            pageKind: "STORE_ROOT",
            domCardsBeforeCap: 3,
            domCardCapReached: false,
            labelSource: "NONE",
          },
        }),
      );
      expect(preview1.isEligible).toBe(true);
      expect(preview1.newProductsCount).toBe(3);
      expect(preview1.previouslyKnownProductsCount).toBe(0);
      expect(preview1.sourceView?.pageKind).toBe("STORE_ROOT");

      // Persist View 1
      const save1 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([prod1, prod2, prod3], {
          scanRunId: "p3-scan-1",
          sourceView: {
            viewKey: "/tiendas/turbo",
            pageKind: "STORE_ROOT",
            domCardsBeforeCap: 3,
            domCardCapReached: false,
            labelSource: "NONE",
          },
        }),
        { ownerConfirmed: true },
      );
      expect(save1.persisted).toBe(true);
      expect(save1.newProductsDiscovered).toBe(3);
      expect(save1.existingProductsObserved).toBe(0);

      // View 2 preview: prod2 and prod3 are already known; prod4 is new
      const prod4 = makeProvisionalListing({
        externalProductId: "prod-4",
        observedPriceCop: 25000,
      });
      const preview2 = repo.previewInspectionBatchAgainstHistory(
        makeSupervisedBatchInput([prod2, prod3, prod4], {
          scanRunId: "p3-scan-2",
          sourceView: {
            viewKey: "/tiendas/turbo/lacteos",
            pageKind: "STORE_SUBPATH",
            ownerLabel: "Lácteos",
            domCardsBeforeCap: 3,
            domCardCapReached: false,
            labelSource: "OWNER_PROVIDED",
          },
        }),
      );
      expect(preview2.isEligible).toBe(true);
      expect(preview2.newProductsCount).toBe(1);
      expect(preview2.previouslyKnownProductsCount).toBe(2);

      repo.close();
    });

    it("persists progressive multi-view sessions and generates comprehensive catalog coverage reports", () => {
      const repo = new SqlitePrivateHistoryRepository(dbPath);

      const makeListingAt = (
        id: string,
        name: string,
        price: number,
        iso: string,
        categorySlug = "lacteos",
      ) =>
        makeProvisionalListing({
          externalProductId: id,
          name,
          observedPriceCop: price,
          sourceObservedAt: iso,
          categorySlug,
        });

      const p1 = makeListingAt(
        "p-1",
        "Leche Entera 1000 ml",
        4500,
        "2026-11-08T10:00:00.000Z",
        "lacteos",
      );
      const p2_v1 = makeListingAt(
        "p-2",
        "Yogurt Fresa 150 g",
        3200,
        "2026-11-08T10:00:00.000Z",
        "lacteos",
      );
      const p3_v1 = makeListingAt(
        "p-3",
        "Queso Tajado 200 g",
        8900,
        "2026-11-08T10:00:00.000Z",
        "lacteos",
      );

      const p2_v2 = makeListingAt(
        "p-2",
        "Yogurt Fresa 150 g",
        3200,
        "2026-11-08T10:05:00.000Z",
        "lacteos",
      );
      const p3_v2 = makeListingAt(
        "p-3",
        "Queso Tajado 200 g",
        8900,
        "2026-11-08T10:05:00.000Z",
        "lacteos",
      );
      const p4_v2 = makeListingAt(
        "p-4",
        "Jugo Naranja 1 L",
        6500,
        "2026-11-08T10:05:00.000Z",
        "bebidas",
      );

      const p4_v3 = makeListingAt(
        "p-4",
        "Jugo Naranja 1 L",
        6500,
        "2026-11-08T10:10:00.000Z",
        "bebidas",
      );
      const p5_v3 = makeListingAt(
        "p-5",
        "Café Molido 500 g",
        28000,
        "2026-11-08T10:10:00.000Z",
        "despensa",
      );

      // Run 1: Store Root (p1, p2, p3)
      const res1 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([p1, p2_v1, p3_v1], {
          scanRunId: "scan-view-root",
          observedAtIso: "2026-11-08T10:00:00.000Z",
          sourceView: {
            viewKey: "/tiendas/900130995-turbo-super",
            pageKind: "STORE_ROOT",
            domCardsBeforeCap: 3,
            domCardCapReached: false,
            labelSource: "NONE",
          },
        }),
        { ownerConfirmed: true },
      );
      expect(res1.persisted).toBe(true);
      expect(res1.newProductsDiscovered).toBe(3);
      expect(res1.existingProductsObserved).toBe(0);

      // Run 2: Category Lácteos (p2, p3, p4) -> 1 new (p4), 2 existing
      const res2 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([p2_v2, p3_v2, p4_v2], {
          scanRunId: "scan-view-lacteos",
          observedAtIso: "2026-11-08T10:05:00.000Z",
          sourceView: {
            viewKey: "/tiendas/900130995-turbo-super/lacteos",
            pageKind: "STORE_SUBPATH",
            ownerLabel: "Lácteos y Quesos",
            domCardsBeforeCap: 3,
            domCardCapReached: false,
            labelSource: "OWNER_PROVIDED",
          },
        }),
        { ownerConfirmed: true },
      );
      expect(res2.persisted).toBe(true);
      expect(res2.newProductsDiscovered).toBe(1);
      expect(res2.existingProductsObserved).toBe(2);

      // Run 3: Category Despensa (p4, p5) -> 1 new (p5), 1 existing
      const res3 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([p4_v3, p5_v3], {
          scanRunId: "scan-view-despensa",
          observedAtIso: "2026-11-08T10:10:00.000Z",
          sourceView: {
            viewKey: "/tiendas/900130995-turbo-super/despensa",
            pageKind: "STORE_SUBPATH",
            ownerLabel: "Despensa y Café",
            domCardsBeforeCap: 2,
            domCardCapReached: false,
            labelSource: "OWNER_PROVIDED",
          },
        }),
        { ownerConfirmed: true },
      );
      expect(res3.persisted).toBe(true);
      expect(res3.newProductsDiscovered).toBe(1);
      expect(res3.existingProductsObserved).toBe(1);

      // Verify listRecentScanRuns maps the view columns
      const recentRuns = repo.listRecentScanRuns(5);
      expect(recentRuns).toHaveLength(3);
      expect(recentRuns[0]?.sourceViewKey).toBe(
        "/tiendas/900130995-turbo-super/despensa",
      );
      expect(recentRuns[0]?.sourceViewLabel).toBe("Despensa y Café");
      expect(recentRuns[0]?.newProductsDiscovered).toBe(1);
      expect(recentRuns[0]?.existingProductsObserved).toBe(1);

      // Generate Catalog Coverage Report
      const coverage = repo.getCatalogCoverageReport();
      expect(coverage.totalDistinctProducts).toBe(5);
      expect(coverage.totalDistinctVariants).toBe(5);
      expect(coverage.totalActiveObservations).toBe(8); // 3 + 3 + 2
      expect(coverage.totalScanRuns).toBe(3);
      expect(coverage.totalInspectedViews).toBe(3);
      expect(coverage.views).toHaveLength(3);
      expect(coverage.categories.length).toBeGreaterThanOrEqual(2);
      expect(coverage.staleProductsCount).toBe(0);
      expect(coverage.newestProductsSample.length).toBeLessThanOrEqual(10);
      expect(coverage.newestProductsSample.length).toBeGreaterThan(0);

      // Test stale detection with a tight threshold or backfilled past observation
      const coverageWithStaleCheck = repo.getCatalogCoverageReport({ staleDays: 30 });
      expect(coverageWithStaleCheck.staleProductsCount).toBe(0);

      // Replay scan 2: must succeed idempotently without altering counters
      const replay2 = repo.persistApprovedInspectionBatch(
        makeSupervisedBatchInput([p2_v2, p3_v2, p4_v2], {
          scanRunId: "scan-view-lacteos",
          observedAtIso: "2026-11-08T10:05:00.000Z",
          sourceView: {
            viewKey: "/tiendas/900130995-turbo-super/lacteos",
            pageKind: "STORE_SUBPATH",
            ownerLabel: "Lácteos y Quesos",
            domCardsBeforeCap: 3,
            domCardCapReached: false,
            labelSource: "OWNER_PROVIDED",
          },
        }),
        { ownerConfirmed: true },
      );
      expect(replay2.persisted).toBe(true);
      expect(replay2.idempotentReplay).toBe(true);
      expect(replay2.observationsInserted).toBe(0);

      repo.close();
    });
  });
});
