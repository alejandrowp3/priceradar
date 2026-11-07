import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrivateDatabaseStatusSummary } from "@priceradar/database";
import type { RawStorefrontSnapshot } from "@priceradar/providers";
import {
  buildSupervisedPersistenceContextFromSnapshot,
  executePrivateHistoryCliCommand,
  formatRedactedConsentSummaryEsCo,
} from "../src/index.ts";

const TEST_HMAC_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeSupervisedProvisionalSnapshot(
  overrides: {
    observedAtIso?: string;
    currentPriceText?: string;
    referencePriceText?: string;
  } = {},
): RawStorefrontSnapshot {
  const observedAtIso = overrides.observedAtIso ?? "2026-11-05T14:00:00.000Z";
  const currentPriceText = overrides.currentPriceText ?? "$ 65.000";

  return {
    pageUrl: "https://www.rappi.com.co/tiendas/900130995-turbo-super",
    pageTitle: "Turbo Super | Rappi Colombia",
    observedAtIso,
    contextHmacSecret: TEST_HMAC_SECRET,
    hasSecurityChallenge: false,
    isLoginRequired: false,
    rawDeliveryHeaderLabel: "Calle 93 # 14-20, Chicó",
    detectedCityName: "Bogotá D.C.",
    cityMetadataSource: "ACTIVE_DELIVERY_CONTEXT",
    hasActiveDeliverySelector: true,
    storeId: "900130995-turbo-super",
    storeName: "Turbo Super",
    servingBranchId: "900130995",
    isServingBranchVerifiedForContext: false,
    catalogSource: "UNVERIFIED_LIVE_DOM",
    openedFromAddressDirectoryContext: true,
    categorySlug: "supermercados",
    rawCards: [
      {
        externalId: "2111457819",
        name: "Aceite de Oliva Extra Virgen",
        nameSource: "DOM_HEADING",
        brand: "Carbonell",
        brandSource: "DOM_EXPLICIT",
        packagingText: "500 ml",
        priceText: currentPriceText,
        priceSource: "DOM_CARD_TEXT",
        ...(overrides.referencePriceText !== undefined
          ? { referencePriceText: overrides.referencePriceText }
          : {}),
        availabilityText: "Agregar",
        inStockFlag: true,
        href: "https://www.rappi.com.co/p/aceite-oliva-2111457819",
      },
    ],
  };
}

describe("Private History CLI & Consent Workflow — Phase P2 (Section 13.4)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-p2-cli-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds a provisional persistence context without weakening UNVERIFIED_FULFILLMENT_CONTEXT and redacts raw addresses", () => {
    const snapshot = makeSupervisedProvisionalSnapshot();
    const { strictReport, persistenceContext } =
      buildSupervisedPersistenceContextFromSnapshot(snapshot, "scan-cli-1");

    expect(strictReport.gateStatus).toBe("UNVERIFIED_FULFILLMENT_CONTEXT");
    expect(persistenceContext.pricingVerificationVerdict).toBe(
      "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION",
    );
    expect(persistenceContext.navigationStates.ADDRESS_SPECIFIC_PRICING_VERIFIED).toBe(
      false,
    );
    expect(persistenceContext.fulfillmentContextHash).toMatch(/^ctx-[0-9a-f]{16}$/);
    expect(persistenceContext.listings).toHaveLength(1);
    expect(persistenceContext.listings[0]?.provenance).toBe(
      "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    );

    const jsonString = JSON.stringify(persistenceContext);
    expect(jsonString).not.toContain("Calle 93");
    expect(jsonString).not.toContain(TEST_HMAC_SECRET);
  });

  it("writes zero records when the owner declines persistence at the confirmation prompt", async () => {
    const snapshot = makeSupervisedProvisionalSnapshot();

    const saveDeclined = await executePrivateHistoryCliCommand({
      command: "save",
      dbPath,
      snapshot,
      scanRunId: "scan-declined",
      confirmPersistence: async () => false,
    });

    expect(saveDeclined.exitCode).toBe(0);
    expect(saveDeclined.titleEsCo).toContain("Persistencia cancelada por el propietario");

    const statusOut = await executePrivateHistoryCliCommand({
      command: "status",
      dbPath,
    });
    expect(statusOut.exitCode).toBe(0);
    const statusPayload = statusOut.payload.status as PrivateDatabaseStatusSummary;
    expect(statusPayload.counts.activeObservations).toBe(0);
    expect(statusPayload.counts.scanRuns).toBe(0);
  });

  it("persists approved snapshots across runs and serves status, runs, product, drops, and anomalies in Spanish without PII", async () => {
    // Run 1: $65.000
    const saveRun1 = await executePrivateHistoryCliCommand({
      command: "save",
      dbPath,
      snapshot: makeSupervisedProvisionalSnapshot({
        observedAtIso: "2026-11-05T14:00:00.000Z",
        currentPriceText: "$ 65.000",
      }),
      scanRunId: "scan-run-1",
      confirmPersistence: async (preview) => {
        const summary = formatRedactedConsentSummaryEsCo(preview, dbPath);
        expect(summary).toContain("NO (Provisional de sesión)");
        expect(summary).not.toContain("Calle 93");
        return true;
      },
    });
    expect(saveRun1.exitCode).toBe(0);

    // Run 2: $65.000
    const saveRun2 = await executePrivateHistoryCliCommand({
      command: "save",
      dbPath,
      snapshot: makeSupervisedProvisionalSnapshot({
        observedAtIso: "2026-11-06T14:00:00.000Z",
        currentPriceText: "$ 65.000",
      }),
      scanRunId: "scan-run-2",
      confirmPersistence: async () => true,
    });
    expect(saveRun2.exitCode).toBe(0);

    // Preview Run 3 at $39.900 before saving
    const previewRun3 = await executePrivateHistoryCliCommand({
      command: "preview",
      dbPath,
      snapshot: makeSupervisedProvisionalSnapshot({
        observedAtIso: "2026-11-07T14:00:00.000Z",
        currentPriceText: "$ 39.900",
      }),
      scanRunId: "scan-run-3-preview",
    });
    expect(previewRun3.exitCode).toBe(0);
    expect(previewRun3.messageEsCo).toContain("Bajadas=1");

    // Save Run 3 at $39.900
    const saveRun3 = await executePrivateHistoryCliCommand({
      command: "save",
      dbPath,
      snapshot: makeSupervisedProvisionalSnapshot({
        observedAtIso: "2026-11-07T14:00:00.000Z",
        currentPriceText: "$ 39.900",
      }),
      scanRunId: "scan-run-3",
      confirmPersistence: async () => true,
    });
    expect(saveRun3.exitCode).toBe(0);

    // Inspect status, runs, product, drops, anomalies
    const statusOut = await executePrivateHistoryCliCommand({
      command: "status",
      dbPath,
    });
    expect(statusOut.exitCode).toBe(0);
    expect(statusOut.messageEsCo).toContain("observaciones activas: 3");
    expect(statusOut.messageEsCo).toContain("oportunidades activas: 1");

    const runsOut = await executePrivateHistoryCliCommand({
      command: "runs",
      dbPath,
    });
    expect(runsOut.exitCode).toBe(0);
    const runsList = runsOut.payload.runs as Array<{ scanRunId: string }>;
    expect(runsList.map((r) => r.scanRunId)).toContain("scan-run-3");

    const productOut = await executePrivateHistoryCliCommand({
      command: "product",
      dbPath,
      productQuery: "Aceite de Oliva",
    });
    expect(productOut.exitCode).toBe(0);
    const observations = productOut.payload.observations as Array<{
      productName: string;
      observedPriceCop: number;
      provenance: string;
      addressSpecificPricingVerified: boolean;
    }>;
    expect(observations).toHaveLength(3);
    expect(observations[2]?.productName).toBe("Aceite de Oliva Extra Virgen");
    expect(observations[2]?.observedPriceCop).toBe(39_900);
    expect(observations[2]?.provenance).toBe("PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL");
    expect(observations[2]?.addressSpecificPricingVerified).toBe(false);

    const dropsOut = await executePrivateHistoryCliCommand({
      command: "drops",
      dbPath,
    });
    expect(dropsOut.exitCode).toBe(0);
    const drops = dropsOut.payload.drops as Array<{
      productName: string;
      discountPercentage: string;
      savingsCop: number;
    }>;
    expect(drops).toHaveLength(1);
    expect(drops[0]?.productName).toBe("Aceite de Oliva Extra Virgen");
    expect(drops[0]?.discountPercentage).toBe("39%");
    expect(drops[0]?.savingsCop).toBe(25_100);

    const anomaliesOut = await executePrivateHistoryCliCommand({
      command: "anomalies",
      dbPath,
    });
    expect(anomaliesOut.exitCode).toBe(0);
  });

  it("handles database path inside repository or mid-batch transaction failure cleanly with exitCode 1", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const forbiddenDbPath = path.join(repoRoot, "forbidden-history.sqlite");

    const badPathResult = await executePrivateHistoryCliCommand({
      command: "status",
      dbPath: forbiddenDbPath,
    });
    expect(badPathResult.exitCode).toBe(1);
    expect(badPathResult.titleEsCo).toContain("Error");

    // Partial batch failure rollback test via CLI
    const crashResult = await executePrivateHistoryCliCommand({
      command: "save",
      dbPath,
      snapshot: makeSupervisedProvisionalSnapshot(),
      scanRunId: "scan-crash",
      confirmPersistence: async () => true,
      persistOptions: {
        simulateCrashAfterObservationsInserted: 1,
      },
    });
    expect(crashResult.exitCode).toBe(1);
    expect(crashResult.titleEsCo).toContain("Error");

    const statusAfterCrash = await executePrivateHistoryCliCommand({
      command: "status",
      dbPath,
    });
    const statusPayload = statusAfterCrash.payload.status as PrivateDatabaseStatusSummary;
    expect(statusPayload.counts.activeObservations).toBe(0);
  });
});
