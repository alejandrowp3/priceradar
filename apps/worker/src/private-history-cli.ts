import readline from "node:readline/promises";
import type {
  BatchPreviewSummary,
  PersistApprovedBatchOptions,
  PersistApprovedBatchResult,
  SupervisedPersistenceContextInput,
} from "@priceradar/database";
import {
  DEFAULT_PRIVATE_SQLITE_DB_PATH,
  SqlitePrivateHistoryRepository,
} from "@priceradar/database";
import { formatCop } from "@priceradar/domain";
import type {
  RawStorefrontSnapshot,
  StorefrontInspectionReport,
} from "@priceradar/providers";
import { inspectStorefrontSnapshot } from "@priceradar/providers";

export type PrivateHistoryCliCommandName =
  "status" | "runs" | "product" | "drops" | "anomalies" | "coverage" | "preview" | "save";

export interface PrivateHistoryCliExecutionInput {
  readonly command: PrivateHistoryCliCommandName;
  readonly dbPath?: string;
  readonly productQuery?: string;
  readonly limit?: number;
  readonly staleDays?: number;
  readonly snapshot?: RawStorefrontSnapshot;
  readonly scanRunId?: string;
  /**
   * Explicit owner consent callback for `save`.
   * In interactive CLI mode, prompts the user in the terminal and requires typing `SI`.
   */
  readonly confirmPersistence?: (preview: BatchPreviewSummary) => Promise<boolean>;
  readonly persistOptions?: Omit<PersistApprovedBatchOptions, "ownerConfirmed">;
}

export interface PrivateHistoryCliExecutionOutput {
  readonly exitCode: number;
  readonly command: PrivateHistoryCliCommandName;
  readonly titleEsCo: string;
  readonly messageEsCo: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Converts a `RawStorefrontSnapshot` into a `SupervisedPersistenceContextInput` by running
 * both strict geographic validation and provisional candidate normalization while strictly
 * preserving `UNVERIFIED_FULFILLMENT_CONTEXT` and `ADDRESS_SPECIFIC_PRICING_VERIFIED: false`
 * whenever branch/catalog binding is unverified (`Section 6`).
 */
export function buildSupervisedPersistenceContextFromSnapshot(
  snapshot: RawStorefrontSnapshot,
  scanRunId = `p2-run-${String(Date.now())}`,
): {
  readonly strictReport: StorefrontInspectionReport;
  readonly persistenceContext: SupervisedPersistenceContextInput;
} {
  const strictReport = inspectStorefrontSnapshot({
    ...snapshot,
    allowProvisionalSessionObservations: false,
  });

  const provisionalReport = inspectStorefrontSnapshot({
    ...snapshot,
    allowProvisionalSessionObservations: true,
  });

  const geo = strictReport.geographicValidation;
  const eb = geo.evidenceBreakdown;

  const persistenceContext: SupervisedPersistenceContextInput = {
    scanRunId,
    observedAtIso: snapshot.observedAtIso,
    gateStatus: strictReport.gateStatus,
    ...(snapshot.hasSecurityChallenge !== undefined
      ? { hasSecurityChallenge: snapshot.hasSecurityChallenge }
      : {}),
    ...(snapshot.isLoginRequired !== undefined
      ? { isLoginRequired: snapshot.isLoginRequired }
      : {}),
    isDeliveryContextVerified: geo.isDeliveryContextVerified,
    citySlug: geo.citySlug,
    cityName: geo.cityName,
    ...(geo.fulfillmentContextHash !== undefined
      ? { fulfillmentContextHash: geo.fulfillmentContextHash }
      : {}),
    activeAddressSelection: eb.activeAddressSelection,
    cityAndNeighborhoodMetadata: eb.cityAndNeighborhoodMetadata,
    servingStoreBranch: eb.servingStoreBranch,
    productCatalogContext: eb.productCatalogContext,
    pricingVerificationVerdict: eb.pricingVerificationVerdict,
    navigationStates: geo.navigationStates,
    candidatesDiscoveredCount:
      provisionalReport.diagnostics.productCounts.consolidatedUniqueCards,
    skippedMalformedCount: provisionalReport.skippedMalformedCount,
    duplicateSuppressedCount: provisionalReport.duplicateSuppressedCount,
    listings: provisionalReport.listings,
    ...(snapshot.sourceView !== undefined ? { sourceView: snapshot.sourceView } : {}),
  };

  return { strictReport, persistenceContext };
}

/**
 * Formats a redacted Spanish confirmation summary for the owner before any SQLite write (`Section 7`).
 * Never includes street addresses, cookies, tokens, or HMAC secrets.
 */
export function formatRedactedConsentSummaryEsCo(
  preview: BatchPreviewSummary,
  dbPath: string,
): string {
  if (!preview.isEligible) {
    return [
      "================================================================================",
      "PriceRadar P2 — Lote NO elegible para persistencia privada",
      "================================================================================",
      `Motivo de rechazo: ${preview.rejectionReason ?? "Requisitos mínimos no cumplidos."}`,
      `Veredicto geográfico: ${preview.geographicVerificationVerdict}`,
      "No se escribirá ningún dato en SQLite.",
      "================================================================================",
    ].join("\n");
  }

  return [
    "================================================================================",
    "PriceRadar P2 — Resumen Redactado de Observación Supervisada (Pre-Guardado)",
    "================================================================================",
    `Base de datos destino : ${dbPath}`,
    `Tienda observada      : ${preview.storeName ?? "Desconocida"} (${preview.storeId ?? "N/A"})`,
    `Vista de catálogo     : ${preview.sourceView?.ownerLabel ? `${preview.sourceView.ownerLabel} (${preview.sourceView.viewKey})` : (preview.sourceView?.viewKey ?? "Desconocida")}`,
    `Contexto opaco (HMAC) : ${preview.fulfillmentContextId ?? "N/A"} (sin dirección en texto plano)`,
    `Origen / Proveniencia : ${preview.provenance ?? "N/A"}`,
    `Veredicto geográfico  : ${preview.geographicVerificationVerdict}`,
    `Precio verificado por dirección exacta : ${preview.addressSpecificPricingVerified ? "SÍ" : "NO (Provisional de sesión)"}`,
    `Tarjetas evaluadas    : ${String(preview.candidatesDiscoveredCount)} (Elegibles: ${String(preview.eligibleListingsCount)}, Omitidas: ${String(preview.skippedMalformedCount)}, Duplicadas en página: ${String(preview.duplicateSuppressedCount)})`,
    `Productos en catálogo : Nuevos descubiertos=${String(preview.newProductsCount)}, Ya conocidos previamente=${String(preview.previouslyKnownProductsCount)}`,
    `Nuevas observaciones  : ${String(preview.newObservationsCount)} (Ya registradas idempotentes: ${String(preview.alreadyPersistedDuplicateCount)})`,
    `Comparación histórica : Primeras=${String(preview.firstObservationsCount)}, Bajadas=${String(preview.priceDecreasesCount)}, Subidas=${String(preview.priceIncreasesCount)}, Sin cambio=${String(preview.unchangedPricesCount)}`,
    `Oportunidades detectadas en lote : ${String(preview.candidateOpportunitiesCount)}`,
    "================================================================================",
  ].join("\n");
}

export async function promptOwnerConsentInTerminal(
  preview: BatchPreviewSummary,
  dbPath: string,
  existingRl?: readline.Interface,
): Promise<boolean> {
  console.log(formatRedactedConsentSummaryEsCo(preview, dbPath));
  if (!preview.isEligible) {
    return false;
  }
  const rl =
    existingRl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  try {
    const answer = await rl.question(
      "\n[Consentimiento Requerido] ¿Deseas guardar estas observaciones en tu SQLite privado local? Escribe 'SI' para confirmar [SI/no]: ",
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "si" || normalized === "sí" || normalized === "yes";
  } finally {
    if (!existingRl) {
      rl.close();
    }
  }
}

/**
 * Executes a private history CLI command programmatically (`Section 11`), returning a
 * structured Spanish response with sanitized payload and exit code.
 */
export async function executePrivateHistoryCliCommand(
  input: PrivateHistoryCliExecutionInput,
): Promise<PrivateHistoryCliExecutionOutput> {
  const dbPath = input.dbPath ?? DEFAULT_PRIVATE_SQLITE_DB_PATH;
  let repo: SqlitePrivateHistoryRepository;

  try {
    repo = new SqlitePrivateHistoryRepository(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      command: input.command,
      titleEsCo: "Error de acceso a la base de datos privada SQLite",
      messageEsCo: `No fue posible abrir o inicializar la base de datos en '${dbPath}': ${msg}`,
      payload: {
        error: msg,
        dbPath,
      },
    };
  }

  try {
    if (input.command === "status") {
      const status = repo.getDatabaseStatus();
      return {
        exitCode: 0,
        command: "status",
        titleEsCo: "Estado de la base de datos privada de PriceRadar",
        messageEsCo: `Base de datos activa en ${status.dbFilePath} (esquema v${String(status.schemaVersion)}, observaciones activas: ${String(status.counts.activeObservations)}, oportunidades activas: ${String(status.counts.activeOpportunities)}).`,
        payload: { status },
      };
    }

    if (input.command === "runs") {
      const runs = repo.listRecentScanRuns(input.limit ?? 20);
      return {
        exitCode: 0,
        command: "runs",
        titleEsCo: "Historial de ejecuciones de observación privada",
        messageEsCo: `Se encontraron ${String(runs.length)} ejecuciones registradas.`,
        payload: { runs },
      };
    }

    if (input.command === "product") {
      const query = (input.productQuery ?? "").trim();
      if (!query) {
        return {
          exitCode: 1,
          command: "product",
          titleEsCo: "Consulta de producto requerida",
          messageEsCo:
            "Debes especificar el ID o nombre del producto (ejemplo: pnpm history:cli product 4030655).",
          payload: { observations: [] },
        };
      }
      const history = repo.getProductPriceHistory(query);
      return {
        exitCode: 0,
        command: "product",
        titleEsCo: `Historial de precios para '${query}'`,
        messageEsCo: `Se encontraron ${String(history.length)} observaciones históricas para '${query}'.`,
        payload: {
          query,
          observations: history.map((row) => ({
            observationId: row.observationId,
            observedAt: row.observedAt,
            storeId: row.externalStoreId,
            storeName: row.storeName,
            productId: row.externalProductId,
            variantId: row.externalVariantId,
            productName: row.productName,
            packagingLabel: row.packagingLabel,
            fulfillmentContextId: row.fulfillmentContextId,
            observedPriceCop: row.observedPriceCop,
            formattedPrice: formatCop(row.observedPriceCop),
            declaredReferencePriceCop: row.declaredReferencePriceCop,
            availability: row.availability,
            provenance: row.provenance,
            geographicVerificationVerdict: row.geographicVerificationVerdict,
            addressSpecificPricingVerified: row.addressSpecificPricingVerified,
          })),
        },
      };
    }

    if (input.command === "drops") {
      const drops = repo.listDetectedOpportunities({
        types: ["HISTORICAL_LOW", "HISTORICAL_DROP"],
        limit: input.limit ?? 50,
      });
      return {
        exitCode: 0,
        command: "drops",
        titleEsCo: "Bajadas de precio y mínimos históricos detectados",
        messageEsCo: `Se encontraron ${String(drops.length)} bajadas históricas activas.`,
        payload: {
          drops: drops.map((d) => ({
            opportunityId: d.opportunityId,
            type: d.opportunityType,
            labelEsCo: d.labelEsCo,
            storeId: d.externalStoreId,
            productId: d.externalProductId,
            variantId: d.externalVariantId,
            productName: d.productName,
            packagingLabel: d.packagingLabel,
            fulfillmentContextId: d.fulfillmentContextId,
            previousPriceCop: d.previousPriceCop,
            previousPriceFormatted:
              d.previousPriceCop !== undefined
                ? formatCop(d.previousPriceCop)
                : undefined,
            baselineMedianCop: d.baselinePriceCop,
            baselineMedianFormatted: formatCop(d.baselinePriceCop),
            observedPriceCop: d.observedPriceCop,
            observedPriceFormatted: formatCop(d.observedPriceCop),
            savingsCop: d.savingsCop,
            savingsFormatted: formatCop(d.savingsCop),
            discountBasisPoints: d.discountBasisPoints,
            discountPercentage: `${String(d.discountPercentage)}%`,
            confidence: d.confidence,
            provenance: d.provenance,
            geographicVerificationVerdict: d.geographicVerificationVerdict,
            detectedAt: d.detectedAt,
          })),
        },
      };
    }

    if (input.command === "anomalies") {
      const anomalies = repo.listDetectedOpportunities({
        types: ["POTENTIAL_ANOMALY", "DECLARED_DISCOUNT"],
        limit: input.limit ?? 50,
      });
      return {
        exitCode: 0,
        command: "anomalies",
        titleEsCo: "Posibles anomalías de precio y descuentos anunciados",
        messageEsCo: `Se encontraron ${String(anomalies.length)} eventos activos que requieren verificación.`,
        payload: {
          anomalies: anomalies.map((a) => ({
            opportunityId: a.opportunityId,
            type: a.opportunityType,
            labelEsCo: a.labelEsCo,
            storeId: a.externalStoreId,
            productId: a.externalProductId,
            variantId: a.externalVariantId,
            productName: a.productName,
            packagingLabel: a.packagingLabel,
            fulfillmentContextId: a.fulfillmentContextId,
            baselinePriceCop: a.baselinePriceCop,
            baselinePriceFormatted: formatCop(a.baselinePriceCop),
            observedPriceCop: a.observedPriceCop,
            observedPriceFormatted: formatCop(a.observedPriceCop),
            savingsCop: a.savingsCop,
            savingsFormatted: formatCop(a.savingsCop),
            discountBasisPoints: a.discountBasisPoints,
            discountPercentage: `${String(a.discountPercentage)}%`,
            confidence: a.confidence,
            requiresVerification: a.requiresVerification,
            provenance: a.provenance,
            geographicVerificationVerdict: a.geographicVerificationVerdict,
            detectedAt: a.detectedAt,
          })),
        },
      };
    }

    if (input.command === "coverage") {
      const coverage = repo.getCatalogCoverageReport({
        ...(input.staleDays !== undefined ? { staleDays: input.staleDays } : {}),
      });
      return {
        exitCode: 0,
        command: "coverage",
        titleEsCo: "Reporte de cobertura de catálogo supervisado",
        messageEsCo: `Catálogo acumulado: ${String(coverage.totalDistinctProducts)} productos únicos (${String(coverage.totalDistinctVariants)} variantes) a través de ${String(coverage.totalInspectedViews)} vistas de tienda y ${String(coverage.totalScanRuns)} inspecciones.`,
        payload: { coverage },
      };
    }

    if (!input.snapshot) {
      return {
        exitCode: 1,
        command: input.command,
        titleEsCo: "Instantánea de tienda requerida",
        messageEsCo:
          "Los comandos 'preview' y 'save' requieren una instantánea supervisada de tienda.",
        payload: {},
      };
    }

    const { strictReport, persistenceContext } =
      buildSupervisedPersistenceContextFromSnapshot(
        input.snapshot,
        input.scanRunId ?? `p2-cli-${String(Date.now())}`,
      );

    const preview = repo.previewInspectionBatchAgainstHistory(
      persistenceContext,
      input.persistOptions?.intelligenceConfig,
    );

    if (input.command === "preview") {
      return {
        exitCode: preview.isEligible ? 0 : 1,
        command: "preview",
        titleEsCo: "Vista previa de lote de observaciones (sin escritura en SQLite)",
        messageEsCo: formatRedactedConsentSummaryEsCo(preview, repo.getDatabasePath()),
        payload: {
          strictGateStatus: strictReport.gateStatus,
          preview: {
            isEligible: preview.isEligible,
            rejectionReason: preview.rejectionReason,
            storeId: preview.storeId,
            storeName: preview.storeName,
            fulfillmentContextId: preview.fulfillmentContextId,
            provenance: preview.provenance,
            geographicVerificationVerdict: preview.geographicVerificationVerdict,
            addressSpecificPricingVerified: preview.addressSpecificPricingVerified,
            candidatesDiscoveredCount: preview.candidatesDiscoveredCount,
            eligibleListingsCount: preview.eligibleListingsCount,
            skippedMalformedCount: preview.skippedMalformedCount,
            duplicateSuppressedCount: preview.duplicateSuppressedCount,
            newObservationsCount: preview.newObservationsCount,
            alreadyPersistedDuplicateCount: preview.alreadyPersistedDuplicateCount,
            newProductsCount: preview.newProductsCount,
            previouslyKnownProductsCount: preview.previouslyKnownProductsCount,
            priceDecreasesCount: preview.priceDecreasesCount,
            priceIncreasesCount: preview.priceIncreasesCount,
            unchangedPricesCount: preview.unchangedPricesCount,
            firstObservationsCount: preview.firstObservationsCount,
            candidateOpportunitiesCount: preview.candidateOpportunitiesCount,
            ...(preview.sourceView ? { sourceView: preview.sourceView } : {}),
          },
        },
      };
    }

    // command === "save"
    if (!preview.isEligible) {
      return {
        exitCode: 1,
        command: "save",
        titleEsCo: "Lote rechazado por controles de elegibilidad y privacidad",
        messageEsCo:
          preview.rejectionReason ?? "El lote no cumple los requisitos de persistencia.",
        payload: {
          persisted: false,
          reason: "INELIGIBLE_BATCH",
          preview,
        },
      };
    }

    const confirmFn =
      input.confirmPersistence ??
      ((p: BatchPreviewSummary) =>
        promptOwnerConsentInTerminal(p, repo.getDatabasePath()));
    const ownerConfirmed = await confirmFn(preview);

    const persistResult: PersistApprovedBatchResult = repo.persistApprovedInspectionBatch(
      persistenceContext,
      {
        ownerConfirmed,
        ...(input.persistOptions?.intelligenceConfig !== undefined
          ? { intelligenceConfig: input.persistOptions.intelligenceConfig }
          : {}),
        ...(input.persistOptions?.simulateCrashAfterObservationsInserted !== undefined
          ? {
              simulateCrashAfterObservationsInserted:
                input.persistOptions.simulateCrashAfterObservationsInserted,
            }
          : {}),
      },
    );

    if (!persistResult.persisted) {
      const declined = persistResult.reason === "OWNER_DECLINED";
      return {
        exitCode: declined ? 0 : 1,
        command: "save",
        titleEsCo: declined
          ? "Persistencia cancelada por el propietario"
          : "Error al guardar el lote en SQLite",
        messageEsCo: declined
          ? "El propietario declinó guardar el lote. No se escribió ningún registro en SQLite."
          : `La transacción falló y fue revertida (ROLLBACK): ${persistResult.errorSummary ?? persistResult.reason}`,
        payload: {
          result: persistResult,
        },
      };
    }

    return {
      exitCode: 0,
      command: "save",
      titleEsCo: "Observaciones privadas guardadas exitosamente en SQLite",
      messageEsCo: `Se guardaron ${String(persistResult.observationsInserted)} observaciones (${String(persistResult.observationsSkippedDuplicate)} duplicadas omitidas) y ${String(persistResult.opportunitiesInserted)} oportunidades en una transacción atómica.`,
      payload: {
        result: persistResult,
      },
    };
  } finally {
    repo.close();
  }
}

async function runCliFromArgv(): Promise<void> {
  const args = process.argv.slice(2);
  const rawSubcommand = (args[0] ?? "status").toLowerCase();
  const validCommands = new Set<PrivateHistoryCliCommandName>([
    "status",
    "runs",
    "product",
    "drops",
    "anomalies",
    "coverage",
    "preview",
    "save",
  ]);

  if (!validCommands.has(rawSubcommand as PrivateHistoryCliCommandName)) {
    console.error(
      JSON.stringify(
        {
          service: "priceradar-private-history-cli",
          level: "ERROR",
          messageEsCo: `Comando desconocido '${rawSubcommand}'. Comandos válidos: status, runs, product <id|nombre>, drops, anomalies, coverage.`,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  let dbPath = DEFAULT_PRIVATE_SQLITE_DB_PATH;
  let productQuery: string | undefined;
  let limit = 20;
  let staleDays: number | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--db-path" && args[i + 1]) {
      dbPath = args[i + 1] ?? dbPath;
      i += 1;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[i + 1] ?? "20", 10) || 20;
      i += 1;
    } else if (arg === "--stale-days" && args[i + 1]) {
      staleDays = Number.parseInt(args[i + 1] ?? "14", 10) || 14;
      i += 1;
    } else if (!arg?.startsWith("--") && !productQuery) {
      productQuery = arg;
    }
  }

  const output = await executePrivateHistoryCliCommand({
    command: rawSubcommand as PrivateHistoryCliCommandName,
    dbPath,
    ...(productQuery !== undefined ? { productQuery } : {}),
    limit,
    ...(staleDays !== undefined ? { staleDays } : {}),
  });

  console.log(
    JSON.stringify(
      {
        service: "priceradar-private-history-cli",
        command: output.command,
        titleEsCo: output.titleEsCo,
        messageEsCo: output.messageEsCo,
        ...output.payload,
      },
      null,
      2,
    ),
  );

  if (output.exitCode !== 0) {
    process.exit(output.exitCode);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  runCliFromArgv().catch((err) => {
    console.error(
      JSON.stringify({
        service: "priceradar-private-history-cli",
        level: "ERROR",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
}
