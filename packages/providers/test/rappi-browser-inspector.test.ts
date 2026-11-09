import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCanonicalListingKey, createCopAmount } from "@priceradar/domain";
import type { RawStorefrontSnapshot } from "../src/index.ts";
import {
  classifyObservationProvenance,
  buildSourceViewDescriptor,
  computeKeyedContextIdentifiersWithRotation,
  computePrivacyPreservingContextHash,
  consolidateDomProductCardCandidates,
  inspectStorefrontSnapshot,
  migrateObservationsForRotatedContext,
  parseCopPriceText,
  parsePackagingVariant,
  RAPPI_BROWSER_PROVIDER_ID,
  resolveOrProvisionContextHmacSecret,
  stripColombianPumExpressions,
  SupervisedBrowserSnapshotProvider,
  validateContextHmacSecret,
  validateGeographicDeliveryContext,
} from "../src/index.ts";

const TEST_HMAC_SECRET =
  "a3f89012e4b7c65d18293a4b5c6d7e8f90123456789abcdef0123456789abcde";
const ROTATED_HMAC_SECRET =
  "f91e0234c8b7a65d18293a4b5c6d7e8f90123456789abcdef0123456789f91e0";

const BASE_CARD = {
  externalId: "4030655",
  name: "Café Especial Tostión Media Bolsa 500 g",
  brand: "Sierra Dorada",
  priceText: "$ 31.500",
  referencePriceText: "$ 42.000",
  packagingText: "500 g",
  availabilityText: "Agregar",
  inStockFlag: true,
  href: "/p/cafe-especial-tostion-media-500g-4030655",
} as const;

const BASE_SNAPSHOT: RawStorefrontSnapshot = {
  pageUrl: "https://www.rappi.com.co/tiendas/900129753-turbo-super",
  pageTitle: "Turbo | Supermercados a Domicilio en Medellín - Rappi",
  observedAtIso: "2026-11-07T13:20:00.000Z",
  hasSecurityChallenge: false,
  isLoginRequired: false,
  hasActiveDeliverySelector: true,
  rawDeliveryHeaderLabel: "Apartamento Poblado — Medellín",
  contextHmacSecret: TEST_HMAC_SECRET,
  detectedCityName: "Medellín",
  cityMetadataSource: "ACTIVE_DELIVERY_CONTEXT",
  storeId: "900129753-turbo-super",
  storeName: "Turbo",
  servingBranchId: "900129753-branch-poblado-z4",
  isServingBranchVerifiedForContext: true,
  catalogSource: "VERIFIED_CONTEXT_DOM",
  categorySlug: "supermercado",
  rawCards: [BASE_CARD],
};

describe("Phase P1 — Supervised Rappi Browser Inspector (Step 6 + F-P1-01 + F-P1-02 Test Suite)", () => {
  it("1. Missing price: skips cards with missing priceText and counts them in skippedMalformedCount", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      rawCards: [
        BASE_CARD,
        {
          externalId: "999001",
          name: "Producto Sin Precio Visible",
          brand: "MarcaX",
          packagingText: "500 g",
          availabilityText: "Agregar",
          inStockFlag: true,
          href: "/p/producto-sin-precio-999001",
        },
      ],
    });

    expect(report.gateStatus).toBe("OK");
    expect(report.listings).toHaveLength(1);
    expect(report.skippedMalformedCount).toBe(1);
    const priceField = report.fieldVerification.find(
      (f) => f.field === "currentPriceCop",
    );
    expect(priceField?.status).toBe("PARTIAL");
    expect(priceField?.verifiedCount).toBe(1);
    expect(priceField?.totalEvaluated).toBe(2);
  });

  it("2. Malformed price: rejects negative, zero, decimal-cent, or non-numeric COP strings", () => {
    expect(parseCopPriceText(undefined)).toBeUndefined();
    expect(parseCopPriceText("")).toBeUndefined();
    expect(parseCopPriceText("Gratis")).toBeUndefined();
    expect(parseCopPriceText("$ 0")).toBeUndefined();
    expect(parseCopPriceText("-$ 15.000")).toBeUndefined();
    expect(parseCopPriceText("$ 31.500,50")).toBeUndefined();
    expect(parseCopPriceText(19999.99)).toBeUndefined();
    expect(parseCopPriceText("$ 31.500")).toBe(31_500);

    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      rawCards: [
        {
          externalId: "888001",
          name: "Producto Precio Corrupto",
          priceText: "$ 31.500,99",
          href: "/p/producto-corrupto-888001",
        },
      ],
    });

    expect(report.gateStatus).toBe("UNSUPPORTED_DOM_STRUCTURE");
    expect(report.listings).toHaveLength(0);
    expect(report.skippedMalformedCount).toBe(1);
  });

  it("3. Different packaging: distinguishes 500 g vs 250 g and 1.5 L vs 500 ml into distinct variant IDs", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      rawCards: [
        {
          externalId: "4030655",
          name: "Café Especial Origen Huila",
          priceText: "$ 31.500",
          packagingText: "500 g",
          href: "/p/cafe-huila-4030655",
        },
        {
          externalId: "4030655",
          name: "Café Especial Origen Huila",
          priceText: "$ 17.900",
          packagingText: "250 g",
          href: "/p/cafe-huila-4030655",
        },
        {
          externalId: "777001",
          name: "Agua Mineral Manantial 1.5 L",
          priceText: "$ 4.500",
          packagingText: "1.5 L",
          href: "/p/agua-mineral-777001",
        },
      ],
    });

    expect(report.gateStatus).toBe("OK");
    expect(report.listings).toHaveLength(3);
    expect(report.listings[0]?.variant.externalVariantId).toBe("4030655-500g");
    expect(report.listings[0]?.variant.unitQuantity).toBe(500);
    expect(report.listings[0]?.variant.unitType).toBe("g");

    expect(report.listings[1]?.variant.externalVariantId).toBe("4030655-250g");
    expect(report.listings[1]?.variant.unitQuantity).toBe(250);
    expect(report.listings[1]?.variant.unitType).toBe("g");

    expect(report.listings[2]?.variant.externalVariantId).toBe("777001-1500ml");
    expect(report.listings[2]?.variant.unitQuantity).toBe(1500);
    expect(report.listings[2]?.variant.unitType).toBe("ml");
  });

  it("4. Different stores/branches: isolates identical products across different serving branches in canonical listing keys", () => {
    const storeAReport = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      storeId: "900129753-turbo-super",
      servingBranchId: "900129753-branch-poblado-z4",
      storeName: "Turbo",
    });

    const storeBReport = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      pageUrl: "https://www.rappi.com.co/tiendas/900055385-carulla-freshmarket",
      storeId: "900055385-carulla-freshmarket",
      servingBranchId: "900055385-branch-oviedo-z2",
      storeName: "Carulla",
    });

    const listingA = storeAReport.listings[0];
    const listingB = storeBReport.listings[0];
    if (!listingA || !listingB) {
      throw new Error("Expected normalized listings for both stores");
    }

    const keyA = buildCanonicalListingKey({
      providerId: listingA.providerId,
      externalStoreId: listingA.store.externalStoreId,
      externalProductId: listingA.variant.externalProductId,
      externalVariantId: listingA.variant.externalVariantId,
      citySlug: listingA.geographicContext.citySlug,
      ...(listingA.geographicContext.zoneCode !== undefined
        ? { zoneCode: listingA.geographicContext.zoneCode }
        : {}),
    });

    const keyB = buildCanonicalListingKey({
      providerId: listingB.providerId,
      externalStoreId: listingB.store.externalStoreId,
      externalProductId: listingB.variant.externalProductId,
      externalVariantId: listingB.variant.externalVariantId,
      citySlug: listingB.geographicContext.citySlug,
      ...(listingB.geographicContext.zoneCode !== undefined
        ? { zoneCode: listingB.geographicContext.zoneCode }
        : {}),
    });

    expect(keyA).not.toBe(keyB);
    expect(listingA.store.externalStoreId).toBe("900129753-branch-poblado-z4");
    expect(listingB.store.externalStoreId).toBe("900055385-branch-oviedo-z2");
  });

  it("5. Missing availability: marks availability as UNKNOWN when neither inStockFlag nor availabilityText is present", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      rawCards: [
        {
          externalId: "4030655",
          name: "Café Especial 500 g",
          priceText: "$ 31.500",
          packagingText: "500 g",
          href: "/p/cafe-especial-4030655",
        },
      ],
    });

    expect(report.gateStatus).toBe("OK");
    expect(report.listings[0]?.availability).toBe("UNKNOWN");
    const availField = report.fieldVerification.find((f) => f.field === "availability");
    expect(availField?.status).toBe("UNSUPPORTED");
  });

  it("6. Duplicate listings: suppresses duplicate product+variant cards on the same storefront page", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      rawCards: [BASE_CARD, BASE_CARD, BASE_CARD],
    });

    expect(report.gateStatus).toBe("OK");
    expect(report.listings).toHaveLength(1);
    expect(report.duplicateSuppressedCount).toBe(2);
  });

  it("7. Changed DOM structure: returns UNSUPPORTED_DOM_STRUCTURE when no valid product cards exist", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      rawCards: [],
    });

    expect(report.gateStatus).toBe("UNSUPPORTED_DOM_STRUCTURE");
    expect(report.listings).toHaveLength(0);
  });

  it("8. Missing delivery context: returns MISSING_DELIVERY_CONTEXT when only static city name is present without active delivery selector", () => {
    const { rawDeliveryHeaderLabel: _omittedLabel, ...snapshotWithoutLabel } =
      BASE_SNAPSHOT;
    expect(_omittedLabel).toBeDefined();
    const reportWithoutSelector = inspectStorefrontSnapshot({
      ...snapshotWithoutLabel,
      hasActiveDeliverySelector: false,
      detectedCityName: "Medellín",
    });

    expect(reportWithoutSelector.gateStatus).toBe("MISSING_DELIVERY_CONTEXT");
    expect(reportWithoutSelector.geographicValidation.isDeliveryContextVerified).toBe(
      false,
    );
    expect(
      reportWithoutSelector.geographicValidation.evidenceBreakdown.activeAddressSelection,
    ).toBe("MISSING_HEADER_SELECTOR");
    expect(
      reportWithoutSelector.geographicValidation.evidenceBreakdown
        .cityAndNeighborhoodMetadata,
    ).toBe("STATIC_SEO_METADATA_ONLY");
    expect(reportWithoutSelector.listings).toHaveLength(0);

    // Placeholder text like "Ingresa tu dirección"
    const placeholderValidation = validateGeographicDeliveryContext({
      hasActiveDeliverySelector: true,
      rawDeliveryHeaderLabel: "Ingresa tu dirección",
      contextHmacSecret: TEST_HMAC_SECRET,
      detectedCityName: "Medellín",
    });
    expect(placeholderValidation.isDeliveryContextVerified).toBe(false);
    expect(placeholderValidation.evidenceBreakdown.activeAddressSelection).toBe(
      "PLACEHOLDER_OR_EMPTY",
    );
  });

  it("9. Authentication required: stops immediately with AUTH_REQUIRED when login prompt is active", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      isLoginRequired: true,
    });

    expect(report.gateStatus).toBe("AUTH_REQUIRED");
    expect(report.listings).toHaveLength(0);
  });

  it("10. Challenge detected: stops immediately with CHALLENGE_DETECTED when security/WAF/CAPTCHA challenge appears", () => {
    const reportByFlag = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      hasSecurityChallenge: true,
    });
    expect(reportByFlag.gateStatus).toBe("CHALLENGE_DETECTED");
    expect(reportByFlag.listings).toHaveLength(0);

    const reportByTitle = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      pageTitle: "Attention Required! | Cloudflare",
    });
    expect(reportByTitle.gateStatus).toBe("CHALLENGE_DETECTED");
    expect(reportByTitle.listings).toHaveLength(0);
  });

  it("11. F-P1-01: enforces keyed HMAC-SHA256 secret validation, stability across restarts, and secret rotation migration", () => {
    // Rejects missing, short, placeholder, or low-entropy secrets
    expect(validateContextHmacSecret(undefined).isValid).toBe(false);
    expect(validateContextHmacSecret("too-short-secret").isValid).toBe(false);
    expect(
      validateContextHmacSecret(
        "replace-with-32-byte-cryptographic-random-context-hmac-secret",
      ).isValid,
    ).toBe(false);
    expect(validateContextHmacSecret("a".repeat(64)).isValid).toBe(false);
    expect(validateContextHmacSecret(TEST_HMAC_SECRET).isValid).toBe(true);

    // Throws if attempting to compute context hash with weak secret
    expect(() =>
      computePrivacyPreservingContextHash({
        rawDeliveryLabel: "Etiqueta Sintetica Prueba Uno — Sector A",
        citySlug: "medellin",
        contextHmacSecret: "short",
      }),
    ).toThrow(/Weak contextHmacSecret/);

    // Different secrets produce completely different hashes for the same address (defeating dictionary guessing)
    const hashWithKey1 = computePrivacyPreservingContextHash({
      rawDeliveryLabel: "Etiqueta Sintetica Prueba Uno — Sector A",
      citySlug: "medellin",
      contextHmacSecret: TEST_HMAC_SECRET,
    });
    const hashWithKey2 = computePrivacyPreservingContextHash({
      rawDeliveryLabel: "Etiqueta Sintetica Prueba Uno — Sector A",
      citySlug: "medellin",
      contextHmacSecret: ROTATED_HMAC_SECRET,
    });
    expect(hashWithKey1).toMatch(/^ctx-[0-9a-f]{16}$/);
    expect(hashWithKey2).toMatch(/^ctx-[0-9a-f]{16}$/);
    expect(hashWithKey1).not.toBe(hashWithKey2);
    expect(hashWithKey1).not.toContain("sector");

    // Persistence & stability across application restarts using an external secret file
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-hmac-test-"));
    const keyFile = path.join(tempDir, "context-hmac.key");
    try {
      const provisionedSecret = resolveOrProvisionContextHmacSecret({
        envSecret: "",
        secretFilePath: keyFile,
        allowCreateFile: true,
      });
      expect(provisionedSecret).toBeDefined();

      // Simulate restart by reading the same key file without creating a new one
      const reloadedSecret = resolveOrProvisionContextHmacSecret({
        envSecret: "",
        secretFilePath: keyFile,
        allowCreateFile: false,
      });
      expect(reloadedSecret).toBe(provisionedSecret);

      const session1Hash = computePrivacyPreservingContextHash({
        rawDeliveryLabel: "Etiqueta Sintetica Prueba Dos — Sector B",
        citySlug: "medellin",
        contextHmacSecret: provisionedSecret ?? "",
      });
      const session2Hash = computePrivacyPreservingContextHash({
        rawDeliveryLabel: "Enviar a: Etiqueta Sintética, Prueba Dos — Sector B",
        citySlug: "Medellín",
        contextHmacSecret: reloadedSecret ?? "",
      });
      expect(session1Hash).toBe(session2Hash);

      // Verify .env.local loading support for interactive CLI runs
      const dotenvFile = path.join(tempDir, ".env.local");
      fs.writeFileSync(
        dotenvFile,
        `# Local test env\nPRICERADAR_CONTEXT_HMAC_SECRET="${TEST_HMAC_SECRET}"\n`,
        "utf8",
      );
      const loadedFromDotenv = resolveOrProvisionContextHmacSecret({
        envSecret: "",
        envFilePath: dotenvFile,
      });
      expect(loadedFromDotenv).toBe(TEST_HMAC_SECRET);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Secret rotation & historical observation migration (including duplicate collision protection)
    const rotatedPair = computeKeyedContextIdentifiersWithRotation({
      rawDeliveryLabel: "Apartamento Poblado — Medellín",
      citySlug: "medellin",
      currentSecret: ROTATED_HMAC_SECRET,
      previousSecret: TEST_HMAC_SECRET,
    });
    expect(rotatedPair.currentContextHash).toBeDefined();
    expect(rotatedPair.previousContextHash).toBeDefined();
    expect(rotatedPair.currentContextHash).not.toBe(rotatedPair.previousContextHash);

    const oldListingKey = `${RAPPI_BROWSER_PROVIDER_ID}::900129753-branch-poblado-z4::4030655::4030655-500g::medellin::${rotatedPair.previousContextHash ?? ""}`;
    const newListingKey = `${RAPPI_BROWSER_PROVIDER_ID}::900129753-branch-poblado-z4::4030655::4030655-500g::medellin::${rotatedPair.currentContextHash}`;
    const migrated = migrateObservationsForRotatedContext(
      [
        {
          observationId: `obs::${oldListingKey}::1`,
          listingKey: oldListingKey,
          providerId: RAPPI_BROWSER_PROVIDER_ID,
          externalStoreId: "900129753-branch-poblado-z4",
          externalProductId: "4030655",
          externalVariantId: "4030655-500g",
          citySlug: "medellin",
          observedPriceCop: createCopAmount(42_000),
          availability: "IN_STOCK",
          provenance: "LIVE_PRIVATE",
          observedAt: "2026-11-01T12:00:00.000Z",
        },
        // Pre-existing migrated duplicate for the exact same listingKey + observedAt must be deduplicated
        {
          observationId: `obs::${newListingKey}::1`,
          listingKey: newListingKey,
          providerId: RAPPI_BROWSER_PROVIDER_ID,
          externalStoreId: "900129753-branch-poblado-z4",
          externalProductId: "4030655",
          externalVariantId: "4030655-500g",
          citySlug: "medellin",
          observedPriceCop: createCopAmount(42_000),
          availability: "IN_STOCK",
          provenance: "LIVE_PRIVATE",
          observedAt: "2026-11-01T12:00:00.000Z",
        },
      ],
      {
        fromContextHash: rotatedPair.previousContextHash ?? "",
        toContextHash: rotatedPair.currentContextHash,
      },
    );
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.listingKey).toBe(newListingKey);
    expect(migrated[0]?.listingKey).not.toContain(
      `::${rotatedPair.previousContextHash ?? ""}`,
    );
  });

  it("12. F-P1-02: rejects active delivery header when catalog comes from static #__NEXT_DATA__ hydration or lacks branch/catalog association", () => {
    // Case A: Active delivery header is present, but catalog source is static #__NEXT_DATA__ SSR hydration
    const staticHydrationReport = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      hasActiveDeliverySelector: true,
      rawDeliveryHeaderLabel: "Apartamento Poblado — Medellín",
      catalogSource: "STATIC_NEXT_DATA_FALLBACK",
    });

    expect(staticHydrationReport.gateStatus).toBe("UNVERIFIED_FULFILLMENT_CONTEXT");
    expect(staticHydrationReport.geographicValidation.isDeliveryContextVerified).toBe(
      false,
    );
    expect(
      staticHydrationReport.geographicValidation.evidenceBreakdown.activeAddressSelection,
    ).toBe("VERIFIED_ACTIVE_SELECTION");
    expect(
      staticHydrationReport.geographicValidation.evidenceBreakdown.productCatalogContext,
    ).toBe("UNVERIFIED_STATIC_SEO_HYDRATION");
    expect(
      staticHydrationReport.geographicValidation.evidenceBreakdown
        .pricingVerificationVerdict,
    ).toBe("UNVERIFIED_STATIC_SEO_PRICING");
    expect(staticHydrationReport.listings).toHaveLength(0);

    // Case B: Active delivery header is present and DOM cards exist, but serving store branch is NOT verified for the context
    const unverifiedBranchReport = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      hasActiveDeliverySelector: true,
      rawDeliveryHeaderLabel: "Apartamento Poblado — Medellín",
      isServingBranchVerifiedForContext: false,
      catalogSource: "UNVERIFIED_LIVE_DOM",
    });

    expect(unverifiedBranchReport.gateStatus).toBe("UNVERIFIED_FULFILLMENT_CONTEXT");
    expect(unverifiedBranchReport.geographicValidation.isDeliveryContextVerified).toBe(
      false,
    );
    expect(
      unverifiedBranchReport.geographicValidation.evidenceBreakdown.servingStoreBranch,
    ).toBe("UNVERIFIED_STATIC_DEFAULT_BRANCH");
    expect(
      unverifiedBranchReport.geographicValidation.evidenceBreakdown.productCatalogContext,
    ).toBe("UNVERIFIED_RENDERED_DOM_CATALOG");
    expect(
      unverifiedBranchReport.geographicValidation.evidenceBreakdown
        .pricingVerificationVerdict,
    ).toBe("UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION");
    expect(unverifiedBranchReport.listings).toHaveLength(0);

    // Case C: Active delivery header is present, but city metadata came only from static SEO metadata
    const staticSeoCityReport = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      hasActiveDeliverySelector: true,
      rawDeliveryHeaderLabel: "Apartamento Poblado — Medellín",
      cityMetadataSource: "STATIC_SEO_METADATA",
    });

    expect(staticSeoCityReport.gateStatus).toBe("UNVERIFIED_FULFILLMENT_CONTEXT");
    expect(staticSeoCityReport.geographicValidation.isDeliveryContextVerified).toBe(
      false,
    );
    expect(
      staticSeoCityReport.geographicValidation.evidenceBreakdown
        .cityAndNeighborhoodMetadata,
    ).toBe("STATIC_SEO_METADATA_ONLY");
    expect(staticSeoCityReport.listings).toHaveLength(0);
  });

  it("13. integrates with SupervisedBrowserSnapshotProvider with LIVE_PRIVATE provenance when all 5 F-P1-02 layers and F-P1-01 HMAC secret are verified", async () => {
    const expectedHash = computePrivacyPreservingContextHash({
      rawDeliveryLabel: "Apartamento Poblado — Medellín",
      citySlug: "medellin",
      contextHmacSecret: TEST_HMAC_SECRET,
    });

    const provider = new SupervisedBrowserSnapshotProvider(BASE_SNAPSHOT, [
      {
        observationId: "seed-1",
        listingKey: `${RAPPI_BROWSER_PROVIDER_ID}::900129753-branch-poblado-z4::4030655::4030655-500g::medellin::${expectedHash}`,
        providerId: RAPPI_BROWSER_PROVIDER_ID,
        externalStoreId: "900129753-branch-poblado-z4",
        externalProductId: "4030655",
        externalVariantId: "4030655-500g",
        citySlug: "medellin",
        observedPriceCop: createCopAmount(42_000),
        availability: "IN_STOCK",
        provenance: "LIVE_PRIVATE",
        observedAt: "2026-11-01T12:00:00.000Z",
      },
    ]);

    const targets = provider.getDefaultTargets();
    expect(targets).toHaveLength(1);
    const firstTarget = targets[0];
    if (!firstTarget) {
      throw new Error("Expected at least one target");
    }
    const result = await provider.discover(firstTarget);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.provenance).toBe("LIVE_PRIVATE");
    expect(result.listings[0]?.geographicContext.zoneCode).toBe(expectedHash);
    expect(provider.getSeedHistoricalObservations()).toHaveLength(1);
  });

  it("14. Priority 1: consolidates split image+title /p/ anchor pairs (60/120 root cause), rejects conflicting prices, strips PUM strings, and never invents fallback names", () => {
    // Reproduce the 2-anchor-per-card pattern (1 image anchor with no name + 1 title anchor with name)
    // plus 1 genuinely unnamed card (no title anchor) and 1 pair with conflicting prices
    const consolidated = consolidateDomProductCardCandidates([
      // Product 1: unnamed image anchor + named title anchor (consistent price)
      {
        priceText: "$ 31.500",
        packagingText: "500 g",
        href: "/p/cafe-especial-4030655",
      },
      {
        name: "Café Especial 500 g",
        nameSource: "DOM_ANCHOR_TEXT",
        priceText: "$ 31.500",
        packagingText: "500 g",
        href: "/p/cafe-especial-4030655",
      },
      // Product 2: genuinely missing name (only 1 unnamed anchor — must NOT invent a name)
      {
        priceText: "$ 12.900",
        packagingText: "250 g",
        href: "/p/producto-sin-titulo-999111",
      },
      // Product 3: conflicting prices on same href (must be rejected)
      {
        priceText: "$ 10.000",
        packagingText: "1 und",
        href: "/p/producto-conflicto-888222",
      },
      {
        name: "Producto Conflicto",
        priceText: "$ 19.500",
        packagingText: "1 und",
        href: "/p/producto-conflicto-888222",
      },
    ]);

    expect(consolidated.splitAnchorPairsMerged).toBe(1);
    expect(consolidated.conflictingPriceCardsSkipped).toBe(2);
    expect(consolidated.consolidatedCards).toHaveLength(2);
    expect(consolidated.consolidatedCards[0]?.name).toBe("Café Especial 500 g");
    expect(consolidated.consolidatedCards[1]?.name).toBeUndefined();

    // Verify Colombian PUM (Precio por Unidad de Medida) stripping
    const pumCleaned = stripColombianPumExpressions(
      "$ 31.500 ($ 63,00 / g) Café Especial",
    );
    expect(pumCleaned).not.toContain("63,00");
    const packagingFromPumOnly = parsePackagingVariant(
      "($ 63,00 / g)",
      "Café Especial En Grano",
    );
    expect(packagingFromPumOnly.hasExplicitQuantityUnit).toBe(false);
    expect(packagingFromPumOnly.unitType).toBe("unit");
  });

  it("15. Priority 2 & 3: reports full sanitized diagnostics and missingGeographicEvidence for real session storefront 900126024-turbo-super", () => {
    const report = inspectStorefrontSnapshot({
      pageUrl: "https://www.rappi.com.co/tiendas/900126024-turbo-super",
      pageTitle: "Turbo | Supermercados a Domicilio - Rappi",
      observedAtIso: "2026-11-07T14:25:00.000Z",
      hasActiveDeliverySelector: true,
      rawDeliveryHeaderLabel: "Dirección Seleccionada por Usuario",
      contextHmacSecret: TEST_HMAC_SECRET,
      isServingBranchVerifiedForContext: false,
      catalogSource: "UNVERIFIED_LIVE_DOM",
      rawCards: [
        // Split image+title anchor pair for product 1
        {
          priceText: "$ 8.900",
          priceSource: "DOM_CARD_TEXT",
          packagingText: "1000 ml",
          availabilityText: "Agregar",
          inStockFlag: true,
          href: "/p/leche-entera-1001",
        },
        {
          name: "Leche Entera Bolsa 1000 ml",
          nameSource: "DOM_HEADING",
          priceText: "$ 8.900",
          priceSource: "DOM_CARD_TEXT",
          packagingText: "1000 ml",
          availabilityText: "Agregar",
          inStockFlag: true,
          href: "/p/leche-entera-1001",
        },
      ],
    });

    expect(report.gateStatus).toBe("UNVERIFIED_FULFILLMENT_CONTEXT");
    expect(report.diagnostics.productCounts.rawInputCandidates).toBe(2);
    expect(report.diagnostics.productCounts.consolidatedUniqueCards).toBe(1);
    expect(report.diagnostics.duplicateCounts.splitAnchorPairsMerged).toBe(1);
    expect(report.diagnostics.extractionSources.name.domHeading).toBe(1);
    expect(report.diagnostics.extractionSources.name.missing).toBe(0);
    expect(report.diagnostics.extractionSources.brand.missing).toBe(1);
    expect(report.diagnostics.storeAndBranchStatus.displayedStoreSlug).toBe(
      "900126024-turbo-super",
    );
    expect(report.diagnostics.storeAndBranchStatus.displayedNumericStoreId).toBe(
      "900126024",
    );
    expect(
      report.diagnostics.storeAndBranchStatus.associations.activeDeliveryAddressDetected,
    ).toBe(true);
    expect(
      report.diagnostics.storeAndBranchStatus.associations.storefrontCurrentlyDisplayed,
    ).toBe(true);
    expect(
      report.diagnostics.storeAndBranchStatus.associations
        .branchServingSelectedAddressVerified,
    ).toBe(false);
    expect(
      report.diagnostics.storeAndBranchStatus.associations
        .catalogDemonstrablyLoadedForAddressVerified,
    ).toBe(false);
    expect(report.diagnostics.missingGeographicEvidence.length).toBeGreaterThanOrEqual(2);
    expect(report.listings).toHaveLength(0);
  });

  it("16. Task A & C: enforces 4-state navigation model for real session 900130995-turbo-super and keeps ADDRESS_SPECIFIC_PRICING_VERIFIED false", () => {
    // Reproduce the exact navigation sequence observed on 900130995-turbo-super:
    // 1. Owner selects delivery address manually
    // 2. Owner navigates to /tiendas/tipo/market
    // 3. Owner opens /tiendas/900130995-turbo-super through Rappi's UI
    // 4. Inspector captures sanitized navigation context + rendered DOM catalog
    const realSessionSnapshot: RawStorefrontSnapshot = {
      pageUrl: "https://www.rappi.com.co/tiendas/900130995-turbo-super",
      pageTitle: "Turbo | Supermercados a Domicilio - Rappi",
      observedAtIso: "2026-11-07T14:40:00.000Z",
      hasActiveDeliverySelector: true,
      rawDeliveryHeaderLabel: "Dirección Residencial Seleccionada — Medellín",
      contextHmacSecret: TEST_HMAC_SECRET,
      detectedCityName: "Medellín",
      cityMetadataSource: "STATIC_SEO_METADATA",
      storeId: "900130995-turbo-super",
      storeName: "Turbo",
      isServingBranchVerifiedForContext: false,
      catalogSource: "UNVERIFIED_LIVE_DOM",
      openedFromAddressDirectoryContext: true,
      sanitizedNavigationPathHistory: [
        "/tiendas/tipo/market",
        "/tiendas/900130995-turbo-super",
      ],
      rawCards: [BASE_CARD],
    };

    // Default strict mode remains fail-closed (UNVERIFIED_FULFILLMENT_CONTEXT)
    const strictReport = inspectStorefrontSnapshot(realSessionSnapshot);
    expect(strictReport.gateStatus).toBe("UNVERIFIED_FULFILLMENT_CONTEXT");
    expect(strictReport.geographicValidation.isDeliveryContextVerified).toBe(false);
    expect(strictReport.geographicValidation.navigationStates).toEqual({
      ADDRESS_SELECTED: true,
      STORE_OPENED_FROM_ADDRESS_CONTEXT: true,
      CATALOG_VISIBLE_IN_SESSION: true,
      ADDRESS_SPECIFIC_PRICING_VERIFIED: false,
    });
    expect(strictReport.listings).toHaveLength(0);
    expect(classifyObservationProvenance(strictReport.geographicValidation)).toBe(
      "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    );

    // Task C: Provisional session mode emits PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL (never LIVE_PRIVATE)
    // while keeping ADDRESS_SPECIFIC_PRICING_VERIFIED strictly false
    const provisionalReport = inspectStorefrontSnapshot({
      ...realSessionSnapshot,
      allowProvisionalSessionObservations: true,
    });
    expect(provisionalReport.gateStatus).toBe("OK");
    expect(provisionalReport.geographicValidation.isDeliveryContextVerified).toBe(false);
    expect(
      provisionalReport.geographicValidation.navigationStates
        .ADDRESS_SPECIFIC_PRICING_VERIFIED,
    ).toBe(false);
    expect(provisionalReport.listings).toHaveLength(1);
    expect(provisionalReport.listings[0]?.provenance).toBe(
      "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
    );
    expect(provisionalReport.listings[0]?.provenance).not.toBe("LIVE_PRIVATE");

    // Public unauthenticated observation without active address is classified as PUBLIC_STOREFRONT_UNAUTHENTICATED
    const publicGeo = validateGeographicDeliveryContext({
      hasActiveDeliverySelector: false,
      detectedCityName: "Medellín",
      catalogSource: "UNVERIFIED_LIVE_DOM",
    });
    expect(classifyObservationProvenance(publicGeo)).toBe(
      "PUBLIC_STOREFRONT_UNAUTHENTICATED",
    );
  });

  it("17. Task B: deduplication suppresses benign multi-carousel duplicates on 900130995-turbo-super while never merging distinct IDs, variants, stores, contexts, or conflicting prices", () => {
    const report = inspectStorefrontSnapshot({
      ...BASE_SNAPSHOT,
      storeId: "900130995-turbo-super",
      servingBranchId: "900130995-turbo-super",
      rawCards: [
        // 1. Benign multi-carousel duplicate: exact same product, variant, store, context, and price in "Ofertas" and "Despensa" carousels
        {
          externalId: "4030655",
          name: "Café Especial Tostión Media Bolsa 500 g",
          priceText: "$ 31.500",
          packagingText: "500 g",
          href: "/p/cafe-especial-tostion-media-500g-4030655",
        },
        {
          externalId: "4030655",
          name: "Café Especial Tostión Media Bolsa 500 g",
          priceText: "$ 31.500",
          packagingText: "500 g",
          href: "/p/cafe-especial-tostion-media-500g-4030655",
        },
        // 2. Unit-less cards sharing a base ID but having distinct product names (4/76 unit-less pattern) must NOT merge
        {
          externalId: "700100",
          name: "Aguacate Hass Maduro",
          priceText: "$ 4.200",
          href: "/p/aguacate-hass-maduro-700100",
        },
        {
          externalId: "700100",
          name: "Aguacate Papelillo Grande",
          priceText: "$ 6.800",
          href: "/p/aguacate-papelillo-grande-700100",
        },
        // 3. Conflicting prices on the exact same listingKey across two complete cards (different href query/path producing same ID+variant+name) must be REJECTED, never merged silently
        {
          externalId: "900555",
          name: "Leche Deslactosada 1000 ml",
          priceText: "$ 5.200",
          packagingText: "1000 ml",
          href: "/p/leche-deslactosada-a-900555",
        },
        {
          externalId: "900555",
          name: "Leche Deslactosada 1000 ml",
          priceText: "$ 6.900",
          packagingText: "1000 ml",
          href: "/p/leche-deslactosada-b-900555",
        },
      ],
    });

    expect(report.gateStatus).toBe("OK");
    // Only the 1 deduplicated coffee listing + 2 distinct unit-less avocado listings remain (3 total);
    // the conflicting-price milk cards are both rejected!
    expect(report.listings).toHaveLength(3);
    expect(report.duplicateSuppressedCount).toBe(1);
    expect(report.diagnostics.duplicateCounts.duplicateListingKeysSuppressed).toBe(1);
    expect(report.diagnostics.duplicateCounts.suppressedListingKeys).toHaveLength(1);
    expect(report.diagnostics.duplicateCounts.conflictingSameKeyCardsRejected).toBe(2);
    expect(report.diagnostics.productCounts.conflictingPriceCardsSkipped).toBe(2);
    expect(report.listings.some((l) => l.variant.externalProductId === "900555")).toBe(
      false,
    );
  });

  describe("Phase P3 — Supervised Catalog Coverage & Source View Descriptors", () => {
    it("builds a canonical STORE_ROOT descriptor for store root URLs", () => {
      const descriptor = buildSourceViewDescriptor({
        pageUrl: "https://www.rappi.com.co/tiendas/900130995-turbo-super",
        nextDataRoute: "/tiendas/[store_type]/[store_id]",
        domCardsBeforeCap: 75,
        domCardCap: 120,
      });

      expect(descriptor).toBeDefined();
      expect(descriptor?.pageKind).toBe("STORE_ROOT");
      expect(descriptor?.viewKey).toBe("/tiendas/900130995-turbo-super");
      expect(descriptor?.domCardsBeforeCap).toBe(75);
      expect(descriptor?.domCardCapReached).toBe(false);
      expect(descriptor?.labelSource).toBe("NONE");
    });

    it("builds a canonical STORE_SUBPATH descriptor for category pages and sanitizes query params", () => {
      const descriptor = buildSourceViewDescriptor({
        pageUrl:
          "https://www.rappi.com.co/tiendas/900130995-turbo-super/lacteos-y-huevos?category_id=456&token=SECRET_JWT_VALUE&lat=6.208&lng=-75.567",
        nextDataRoute: "/tiendas/[store_type]/[store_id]/[category]",
        domCardsBeforeCap: 140,
        domCardCap: 120,
        ownerLabel: "Lácteos y Huevos",
      });

      expect(descriptor).toBeDefined();
      expect(descriptor?.pageKind).toBe("STORE_SUBPATH");
      expect(descriptor?.viewKey).toBe(
        "/tiendas/900130995-turbo-super/lacteos-y-huevos?category_id=456",
      );
      // Sensitive query params (token, lat, lng) must be stripped!
      expect(descriptor?.viewKey).not.toContain("token");
      expect(descriptor?.viewKey).not.toContain("lat");
      expect(descriptor?.viewKey).not.toContain("lng");
      expect(descriptor?.domCardsBeforeCap).toBe(140);
      expect(descriptor?.domCardCapReached).toBe(true);
      expect(descriptor?.ownerLabel).toBe("Lácteos y Huevos");
      expect(descriptor?.labelSource).toBe("OWNER_PROVIDED");
    });

    it("returns undefined for external or malformed URLs", () => {
      expect(
        buildSourceViewDescriptor({
          pageUrl: "https://evil.com/phishing/turbo",
        }),
      ).toBeUndefined();
      expect(
        buildSourceViewDescriptor({
          pageUrl: "not-a-valid-url",
        }),
      ).toBeUndefined();
    });

    it("preserves sourceView in StorefrontInspectionReport", () => {
      const sourceView = buildSourceViewDescriptor({
        pageUrl: "https://www.rappi.com.co/tiendas/900130995-turbo-super/despensa",
        domCardsBeforeCap: 80,
      });

      expect(sourceView).toBeDefined();
      const report = inspectStorefrontSnapshot({
        ...BASE_SNAPSHOT,
        pageUrl: "https://www.rappi.com.co/tiendas/900130995-turbo-super/despensa",
        ...(sourceView ? { sourceView } : {}),
        rawCards: [BASE_CARD],
      });

      expect(report.sourceView).toBeDefined();
      expect(report.sourceView?.pageKind).toBe("STORE_SUBPATH");
      expect(report.sourceView?.viewKey).toBe("/tiendas/900130995-turbo-super/despensa");
    });
  });
});
