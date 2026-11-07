import type {
  AvailabilityStatus,
  DiscoveredListing,
  DiscoveryTarget,
  GeographicContext,
  PriceObservationRecord,
  ProductVariantIdentity,
  StoreIdentity,
} from "@priceradar/domain";
import { buildCanonicalListingKey, createCopAmount } from "@priceradar/domain";
import type {
  CatalogProvider,
  DiscoveryOptions,
  DiscoveryResult,
  ProviderCapabilities,
} from "./contracts.ts";

export const FIXTURE_PROVIDER_ID = "fixture-colombia";

const BOGOTA_GEO: GeographicContext = {
  countryCode: "CO",
  citySlug: "bogota",
  cityName: "Bogotá D.C.",
  zoneCode: "CO-DC-CHAPINERO",
};

const MEDELLIN_GEO: GeographicContext = {
  countryCode: "CO",
  citySlug: "medellin",
  cityName: "Medellín",
  zoneCode: "CO-ANT-POBLADO",
};

const FIXTURE_STORES: Record<string, StoreIdentity> = {
  "mercado-andino": {
    providerId: FIXTURE_PROVIDER_ID,
    externalStoreId: "mercado-andino",
    name: "Mercado Andino (Demostración)",
    categorySlug: "supermercado",
  },
  "tecno-sabana": {
    providerId: FIXTURE_PROVIDER_ID,
    externalStoreId: "tecno-sabana",
    name: "TecnoSabana (Demostración)",
    categorySlug: "tecnologia",
  },
  "hogar-cafetero": {
    providerId: FIXTURE_PROVIDER_ID,
    externalStoreId: "hogar-cafetero",
    name: "Hogar Cafetero (Demostración)",
    categorySlug: "electrohogar",
  },
};

interface FixtureCatalogItem {
  readonly targetId: string;
  readonly storeKey: keyof typeof FIXTURE_STORES;
  readonly geo: GeographicContext;
  readonly variant: ProductVariantIdentity;
  readonly historicalPricesCop: readonly number[];
  readonly observedPriceByStepCop: readonly [number, number, number];
  readonly declaredReferencePriceCop?: number;
  readonly availability: AvailabilityStatus;
}

const FIXTURE_CATALOG_ITEMS: readonly FixtureCatalogItem[] = [
  {
    // 1. Café Origen Huila 500g - Triggers HISTORICAL_LOW and HISTORICAL_DROP (25% below median)
    targetId: "target-andino-supermercado-bog",
    storeKey: "mercado-andino",
    geo: BOGOTA_GEO,
    variant: {
      externalProductId: "prod-cafe-huila",
      externalVariantId: "var-cafe-huila-500g-grano",
      name: "Café Especial Origen Huila Tostión Media",
      brand: "Sierra Dorada",
      categorySlug: "supermercado",
      categoryName: "Supermercado y Despensa",
      packagingLabel: "Bolsa 500 g en grano",
      unitQuantity: 500,
      unitType: "g",
      productUrl: "https://demo.priceradar.local/productos/prod-cafe-huila-500g",
    },
    historicalPricesCop: [42_000, 42_000, 41_500, 42_500, 42_000, 41_900],
    observedPriceByStepCop: [31_500, 39_900, 42_000],
    declaredReferencePriceCop: 42_000,
    availability: "IN_STOCK",
  },
  {
    // 2. Café Origen Huila 250g (Distinct variant of the same product - normal price, ensures variants do not merge)
    targetId: "target-andino-supermercado-bog",
    storeKey: "mercado-andino",
    geo: BOGOTA_GEO,
    variant: {
      externalProductId: "prod-cafe-huila",
      externalVariantId: "var-cafe-huila-250g-molido",
      name: "Café Especial Origen Huila Tostión Media",
      brand: "Sierra Dorada",
      categorySlug: "supermercado",
      categoryName: "Supermercado y Despensa",
      packagingLabel: "Bolsa 250 g molido",
      unitQuantity: 250,
      unitType: "g",
      productUrl: "https://demo.priceradar.local/productos/prod-cafe-huila-250g",
    },
    historicalPricesCop: [24_000, 24_500, 24_000, 23_900],
    observedPriceByStepCop: [24_000, 24_000, 23_500],
    availability: "IN_STOCK",
  },
  {
    // 3. Aceite de Oliva Extra Virgen 1L - Triggers DECLARED_DISCOUNT (20% declared discount, sparse history)
    targetId: "target-andino-supermercado-bog",
    storeKey: "mercado-andino",
    geo: BOGOTA_GEO,
    variant: {
      externalProductId: "prod-aceite-oliva-med",
      externalVariantId: "var-aceite-oliva-1000ml",
      name: "Aceite de Oliva Extra Virgen Primera Prensa",
      brand: "Olivos del Valle",
      categorySlug: "supermercado",
      categoryName: "Supermercado y Despensa",
      packagingLabel: "Botella vidrio 1000 ml",
      unitQuantity: 1000,
      unitType: "ml",
      productUrl: "https://demo.priceradar.local/productos/prod-aceite-oliva-1l",
    },
    historicalPricesCop: [65_000],
    observedPriceByStepCop: [52_000, 52_000, 65_000],
    declaredReferencePriceCop: 65_000,
    availability: "IN_STOCK",
  },
  {
    // 4. Audífonos Inalámbricos ANC Pro - Triggers POTENTIAL_ANOMALY (-62% vs 6 prior observations)
    targetId: "target-tecno-sabana-bog",
    storeKey: "tecno-sabana",
    geo: BOGOTA_GEO,
    variant: {
      externalProductId: "prod-audifonos-anc-pro",
      externalVariantId: "var-audifonos-anc-negro",
      name: "Audífonos Inalámbricos Cancelación Activa ANC Pro",
      brand: "KronoAudio",
      categorySlug: "tecnologia",
      categoryName: "Tecnología y Audio",
      packagingLabel: "Unidad color negro mate",
      unitQuantity: 1,
      unitType: "unit",
      productUrl: "https://demo.priceradar.local/productos/prod-audifonos-anc-pro",
    },
    historicalPricesCop: [480_000, 479_000, 485_000, 480_000, 475_000, 480_000],
    observedPriceByStepCop: [182_400, 479_000, 450_000],
    declaredReferencePriceCop: 480_000,
    availability: "LOW_STOCK",
  },
  {
    // 5. Monitor 27" QHD IPS - Sparse history (only 1 prior observation) with 60% drop.
    // Must NOT trigger POTENTIAL_ANOMALY due to insufficient history (SC-007 verification item).
    targetId: "target-tecno-sabana-bog",
    storeKey: "tecno-sabana",
    geo: BOGOTA_GEO,
    variant: {
      externalProductId: "prod-monitor-qhd-27",
      externalVariantId: "var-monitor-qhd-27-165hz",
      name: "Monitor 27 Pulgadas QHD IPS 165Hz",
      brand: "VisioTech",
      categorySlug: "tecnologia",
      categoryName: "Tecnología y Audio",
      packagingLabel: "Unidad 27 pulgadas",
      unitQuantity: 1,
      unitType: "unit",
      productUrl: "https://demo.priceradar.local/productos/prod-monitor-qhd-27",
    },
    historicalPricesCop: [1_200_000],
    observedPriceByStepCop: [480_000, 1_150_000, 1_200_000],
    declaredReferencePriceCop: 1_200_000,
    availability: "IN_STOCK",
  },
  {
    // 6. Freidora de Aire Digital 5.5L - Triggers HISTORICAL_DROP (18% drop vs median, but not all-time low)
    targetId: "target-hogar-cafetero-med",
    storeKey: "hogar-cafetero",
    geo: MEDELLIN_GEO,
    variant: {
      externalProductId: "prod-freidora-aire-55l",
      externalVariantId: "var-freidora-55l-acero",
      name: "Freidora de Aire Digital Convección 5.5 Litros",
      brand: "KalleyDemo",
      categorySlug: "electrohogar",
      categoryName: "Electrohogar y Cocina",
      packagingLabel: "Unidad 5.5 L acero inoxidable",
      unitQuantity: 1,
      unitType: "unit",
      productUrl: "https://demo.priceradar.local/productos/prod-freidora-55l",
    },
    historicalPricesCop: [350_000, 350_000, 275_000, 355_000, 350_000],
    observedPriceByStepCop: [287_000, 349_000, 265_000],
    declaredReferencePriceCop: 350_000,
    availability: "IN_STOCK",
  },
];

export const DEFAULT_FIXTURE_TARGETS: readonly DiscoveryTarget[] = [
  {
    targetId: "target-andino-supermercado-bog",
    providerId: FIXTURE_PROVIDER_ID,
    storeId: "mercado-andino",
    categorySlug: "supermercado",
    geographicContext: BOGOTA_GEO,
    enabled: true,
    priority: 10,
  },
  {
    targetId: "target-tecno-sabana-bog",
    providerId: FIXTURE_PROVIDER_ID,
    storeId: "tecno-sabana",
    categorySlug: "tecnologia",
    geographicContext: BOGOTA_GEO,
    enabled: true,
    priority: 20,
  },
  {
    targetId: "target-hogar-cafetero-med",
    providerId: FIXTURE_PROVIDER_ID,
    storeId: "hogar-cafetero",
    categorySlug: "electrohogar",
    geographicContext: MEDELLIN_GEO,
    enabled: true,
    priority: 30,
  },
];

/**
 * Deterministic, fictional catalog provider for Colombia (`es-CO`, integer `COP`).
 * Supports automatic catalog exploration without requiring manual product watchlists,
 * pagination cursors, multi-store / multi-variant differentiation, and reproducible anomalies.
 */
export class FixtureCatalogProvider implements CatalogProvider {
  public readonly id = FIXTURE_PROVIDER_ID;
  public readonly displayName = "Catálogo de Demostración Colombia (Fixture)";

  public getCapabilities(): ProviderCapabilities {
    return {
      supportsCatalogExploration: true,
      supportsCategoryDiscovery: true,
      supportsPagination: true,
      supportsStoreSpecificListings: true,
      supportsStableProductIdentity: true,
      supportsProductVariants: true,
      supportsDeclaredReferencePrice: true,
      supportsAvailabilityStatus: true,
      supportsGeographicContext: true,
      supportsProductImages: false,
      supportsSourceTimestamps: true,
      isSimulatedFixture: true,
    };
  }

  public getDefaultTargets(): readonly DiscoveryTarget[] {
    return DEFAULT_FIXTURE_TARGETS;
  }

  /**
   * Produces deterministic prior observations spaced at 24-hour intervals before `nowIso`.
   */
  public getSeedHistoricalObservations(
    nowIso = "2026-11-07T12:00:00.000Z",
  ): readonly PriceObservationRecord[] {
    const baseMs = Date.parse(nowIso);
    const dayMs = 24 * 60 * 60 * 1000;
    const records: PriceObservationRecord[] = [];

    for (const item of FIXTURE_CATALOG_ITEMS) {
      const store = FIXTURE_STORES[item.storeKey];
      if (!store) {
        continue;
      }
      const listingKey = buildCanonicalListingKey({
        providerId: this.id,
        externalStoreId: store.externalStoreId,
        externalProductId: item.variant.externalProductId,
        externalVariantId: item.variant.externalVariantId,
        citySlug: item.geo.citySlug,
        ...(item.geo.zoneCode !== undefined ? { zoneCode: item.geo.zoneCode } : {}),
      });

      const total = item.historicalPricesCop.length;
      for (let idx = 0; idx < total; idx += 1) {
        const rawPrice = item.historicalPricesCop[idx];
        if (rawPrice === undefined) {
          continue;
        }
        const daysAgo = total - idx;
        const observedAt = new Date(baseMs - daysAgo * dayMs).toISOString();
        records.push({
          observationId: `seed::${listingKey}::${String(idx)}`,
          listingKey,
          providerId: this.id,
          externalStoreId: store.externalStoreId,
          externalProductId: item.variant.externalProductId,
          externalVariantId: item.variant.externalVariantId,
          citySlug: item.geo.citySlug,
          observedPriceCop: createCopAmount(rawPrice),
          ...(item.declaredReferencePriceCop !== undefined
            ? {
                declaredReferencePriceCop: createCopAmount(
                  item.declaredReferencePriceCop,
                ),
              }
            : {}),
          availability: "IN_STOCK",
          provenance: "DEMO_FIXTURE",
          observedAt,
        });
      }
    }

    return records;
  }

  public async discover(
    target: DiscoveryTarget,
    options: DiscoveryOptions = {},
  ): Promise<DiscoveryResult> {
    const nowIso = options.nowIso ?? "2026-11-07T12:00:00.000Z";
    const stepIndex = ((((options.simulationStep ?? 0) % 3) + 3) % 3) as 0 | 1 | 2;
    const pageSize = Math.max(1, options.pageSize ?? 10);
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const safeOffset = Number.isNaN(offset) || offset < 0 ? 0 : offset;

    const matchingItems = FIXTURE_CATALOG_ITEMS.filter(
      (item) => item.targetId === target.targetId,
    );

    const slice = matchingItems.slice(safeOffset, safeOffset + pageSize);
    const nextOffset = safeOffset + slice.length;
    const hasMore = nextOffset < matchingItems.length;

    const listings: DiscoveredListing[] = slice.map((item) => {
      const store = FIXTURE_STORES[item.storeKey];
      if (!store) {
        throw new Error(`Unknown fixture store key: ${String(item.storeKey)}`);
      }
      const rawObservedPrice = item.observedPriceByStepCop[stepIndex];
      return {
        providerId: this.id,
        store,
        variant: item.variant,
        geographicContext: item.geo,
        observedPriceCop: createCopAmount(rawObservedPrice),
        ...(item.declaredReferencePriceCop !== undefined
          ? {
              declaredReferencePriceCop: createCopAmount(item.declaredReferencePriceCop),
            }
          : {}),
        availability: item.availability,
        provenance: "DEMO_FIXTURE",
        sourceObservedAt: nowIso,
      };
    });

    return {
      providerId: this.id,
      targetId: target.targetId,
      listings,
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
      hasMore,
      fetchedAt: nowIso,
      totalAvailableInTarget: matchingItems.length,
    };
  }
}
