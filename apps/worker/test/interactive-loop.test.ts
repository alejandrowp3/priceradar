import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import readline from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlitePrivateHistoryRepository } from "@priceradar/database";
import type { RawStorefrontSnapshot } from "@priceradar/providers";
import {
  promptOwnerConsentInTerminal,
  runInteractiveCatalogSession,
} from "../src/index.ts";

const TEST_HMAC_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeControlledSnapshot(
  viewKey: string,
  product: { id: string; name: string; priceText: string },
  ownerLabel?: string,
): RawStorefrontSnapshot {
  return {
    pageUrl: `https://www.rappi.com.co/tiendas/900130995-turbo-super/${viewKey}`,
    pageTitle: "Turbo Super | Rappi Colombia",
    observedAtIso: new Date().toISOString(),
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
    sourceView: {
      viewKey: `/tiendas/900130995-turbo-super/${viewKey}`,
      pageKind: "STORE_SUBPATH",
      ...(ownerLabel !== undefined
        ? { ownerLabel, labelSource: "OWNER_PROVIDED" as const }
        : { labelSource: "NONE" as const }),
    },
    rawCards: [
      {
        externalId: product.id,
        name: product.name,
        nameSource: "DOM_HEADING",
        brand: "Marca Prueba",
        brandSource: "DOM_EXPLICIT",
        packagingText: "750 ml",
        priceText: product.priceText,
        priceSource: "DOM_CARD_TEXT",
        availabilityText: "Agregar",
        inStockFlag: true,
        href: `https://www.rappi.com.co/p/${product.id}`,
      },
    ],
  };
}

describe("Interactive Catalog Coverage Session & Readline Lifecycle (P3 Hotfix)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-interactive-"));
    dbPath = path.join(tempDir, "private-history.sqlite");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("completes a multi-view interactive session without freezing on subsequent view prompts", async () => {
    const inputStream = new Readable({ read() {} });
    const responses = [
      "", // Iteration 1: Press enter to inspect
      "SI", // Iteration 1 consent confirmation
      "whisky", // Iteration 2: Label provided for next view (previously froze here!)
      "SI", // Iteration 2 consent confirmation
      "salir", // Iteration 3: Exit command
    ];
    let responseIdx = 0;

    const outputStream = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        if (
          text.includes("presiona ENTER aquí para inspeccionar") ||
          text.includes("¿Deseas guardar estas observaciones") ||
          text.includes("Siguiente vista")
        ) {
          const nextResp = responses[responseIdx++];
          if (nextResp !== undefined) {
            setTimeout(() => {
              inputStream.push(`${nextResp}\n`);
            }, 10);
          }
        }
        callback();
      },
    });

    const snapshots = [
      makeControlledSnapshot("cervezas", {
        id: "beer-001",
        name: "Cerveza Club Colombia Dorada",
        priceText: "$ 4.500",
      }),
      makeControlledSnapshot("whisky", {
        id: "whisky-001",
        name: "Whisky Johnnie Walker Black Label",
        priceText: "$ 149.900",
      }),
    ];

    const rl = readline.createInterface({
      input: inputStream,
      output: outputStream,
      terminal: false,
    });

    const stats = await runInteractiveCatalogSession({
      rl,
      dbPath,
      saveToPrivateHistory: true,
      allowProvisionalSessionObservations: true,
      captureSnapshot: async (iteration, currentLabel) => {
        const snap = snapshots[iteration - 1];
        if (!snap) {
          throw new Error(
            `Unexpected snapshot requested for iteration ${String(iteration)}`,
          );
        }
        return {
          snapshot: {
            ...snap,
            ...(snap.sourceView !== undefined
              ? {
                  sourceView: {
                    ...snap.sourceView,
                    ...(currentLabel !== undefined
                      ? {
                          ownerLabel: currentLabel,
                          labelSource: "OWNER_PROVIDED" as const,
                        }
                      : {}),
                  },
                }
              : {}),
          },
        };
      },
    });

    // Verify session stats returned from interactive loop
    expect(stats.viewsInspected).toBe(2);
    expect(stats.observationsInserted).toBe(2);
    expect(stats.newProductsDiscovered).toBe(2);

    // Verify SQLite repository has both batches intact
    const repo = new SqlitePrivateHistoryRepository(dbPath);
    const runs = repo.listRecentScanRuns(10);
    expect(runs).toHaveLength(2);

    const historyBeer = repo.getProductPriceHistory("beer-001");
    expect(historyBeer).toHaveLength(1);
    expect(historyBeer[0]?.productName).toBe("Cerveza Club Colombia Dorada");

    const historyWhisky = repo.getProductPriceHistory("whisky-001");
    expect(historyWhisky).toHaveLength(1);
    expect(historyWhisky[0]?.productName).toBe("Whisky Johnnie Walker Black Label");

    const coverage = repo.getCatalogCoverageReport();
    expect(coverage.totalInspectedViews).toBe(2);
    expect(coverage.totalDistinctProducts).toBe(2);
    expect(coverage.totalScanRuns).toBe(2);
    expect(coverage.views.some((v) => v.ownerLabel === "whisky")).toBe(true);

    repo.close();
  });

  it("handles user declining consent on first view and exits cleanly without writing observations", async () => {
    const inputStream = new Readable({ read() {} });
    const responses = [
      "", // Iteration 1: Press enter to inspect
      "no", // Iteration 1 consent declined
      "salir", // Iteration 2: Exit command
    ];
    let responseIdx = 0;

    const outputStream = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        if (
          text.includes("presiona ENTER aquí para inspeccionar") ||
          text.includes("¿Deseas guardar estas observaciones") ||
          text.includes("Siguiente vista")
        ) {
          const nextResp = responses[responseIdx++];
          if (nextResp !== undefined) {
            setTimeout(() => {
              inputStream.push(`${nextResp}\n`);
            }, 10);
          }
        }
        callback();
      },
    });

    const snapshot = makeControlledSnapshot("snacks", {
      id: "snack-001",
      name: "Papas Margarita Pollo",
      priceText: "$ 3.200",
    });

    const rl = readline.createInterface({
      input: inputStream,
      output: outputStream,
      terminal: false,
    });

    const stats = await runInteractiveCatalogSession({
      rl,
      dbPath,
      saveToPrivateHistory: true,
      allowProvisionalSessionObservations: true,
      captureSnapshot: async () => ({ snapshot }),
    });

    expect(stats.viewsInspected).toBe(1);
    expect(stats.observationsInserted).toBe(0);

    const repo = new SqlitePrivateHistoryRepository(dbPath);
    const runs = repo.listRecentScanRuns(10);
    expect(runs).toHaveLength(0);
    repo.close();
  });

  it("supports 'exit' command to terminate the session", async () => {
    const inputStream = new Readable({ read() {} });
    const responses = [
      "", // Iteration 1: Press enter to inspect
      "SI", // Iteration 1 consent confirmed
      "exit", // Iteration 2: 'exit' command
    ];
    let responseIdx = 0;

    const outputStream = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        if (
          text.includes("presiona ENTER aquí para inspeccionar") ||
          text.includes("¿Deseas guardar estas observaciones") ||
          text.includes("Siguiente vista")
        ) {
          const nextResp = responses[responseIdx++];
          if (nextResp !== undefined) {
            setTimeout(() => {
              inputStream.push(`${nextResp}\n`);
            }, 10);
          }
        }
        callback();
      },
    });

    const snapshot = makeControlledSnapshot("bebidas", {
      id: "drink-001",
      name: "Agua Manantial con Gas",
      priceText: "$ 2.800",
    });

    const rl = readline.createInterface({
      input: inputStream,
      output: outputStream,
      terminal: false,
    });

    const stats = await runInteractiveCatalogSession({
      rl,
      dbPath,
      saveToPrivateHistory: true,
      allowProvisionalSessionObservations: true,
      captureSnapshot: async () => ({ snapshot }),
    });

    expect(stats.viewsInspected).toBe(1);
    expect(stats.observationsInserted).toBe(1);

    const repo = new SqlitePrivateHistoryRepository(dbPath);
    expect(repo.listRecentScanRuns(10)).toHaveLength(1);
    repo.close();
  });

  it("preserves readline listener lifecycle when promptOwnerConsentInTerminal is called with existingRl", async () => {
    const inputStream = new Readable({ read() {} });
    const outputStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const rl = readline.createInterface({
      input: inputStream,
      output: outputStream,
      terminal: false,
    });

    const preview = {
      isEligible: true,
      items: [],
      geographicVerificationVerdict: "UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION" as const,
      addressSpecificPricingVerified: false,
      candidatesDiscoveredCount: 1,
      eligibleListingsCount: 1,
      skippedMalformedCount: 0,
      duplicateSuppressedCount: 0,
      newObservationsCount: 1,
      alreadyPersistedDuplicateCount: 0,
      newProductsCount: 1,
      previouslyKnownProductsCount: 0,
      priceDecreasesCount: 0,
      priceIncreasesCount: 0,
      unchangedPricesCount: 0,
      firstObservationsCount: 1,
      candidateOpportunitiesCount: 0,
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL" as const,
    };

    setTimeout(() => {
      inputStream.push("SI\n");
    }, 10);

    const confirmed = await promptOwnerConsentInTerminal(preview, dbPath, rl);
    expect(confirmed).toBe(true);

    // Verify rl is still completely functional and not closed!
    setTimeout(() => {
      inputStream.push("subsequent answer\n");
    }, 10);

    const nextAnswer = await rl.question("Next question: ");
    expect(nextAnswer).toBe("subsequent answer");

    rl.close();
  });
});
