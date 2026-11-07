import readline from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import {
  DEFAULT_PRIVATE_SQLITE_DB_PATH,
  InMemoryPriceRadarRepository,
} from "@priceradar/database";
import type { PriceObservationRecord } from "@priceradar/domain";
import { buildCanonicalListingKey, createCopAmount, formatCop } from "@priceradar/domain";
import type { ExtractedNameSource, RawStorefrontSnapshot } from "@priceradar/providers";
import {
  RAPPI_BROWSER_PROVIDER_ID,
  readEnvVarFromFile,
  resolveOrProvisionContextHmacSecret,
  SupervisedBrowserSnapshotProvider,
} from "@priceradar/providers";
import { executePrivateHistoryCliCommand } from "./private-history-cli.ts";
import { executeDiscoveryScan } from "./scanner.ts";

const WORKSPACE_ENV_LOCAL_PATH = path.resolve(import.meta.dirname, "../../../.env.local");

const CONTROLLED_SIMULATION_HMAC_SECRET =
  "a3f89012e4b7c65d18293a4b5c6d7e8f90123456789abcdef0123456789abcde";

interface CliOptions {
  readonly simulateControlledSession: boolean;
  readonly simulateUnverifiedHeaderOnly: boolean;
  readonly persistAuthorizedPersonalProfile: boolean;
  readonly nonInteractiveInspect: boolean;
  readonly allowProvisionalSessionObservations: boolean;
  readonly previewPrivateHistory: boolean;
  readonly saveToPrivateHistory: boolean;
  readonly dbPath: string;
  readonly startUrl: string;
}

interface SanitizedUiEvidenceDiagnostics {
  readonly headerAddressCandidateCount: number;
  readonly headerCandidateSelectors: readonly string[];
  readonly hasNonEmptyHeaderAddressLabel: boolean;
  readonly urlStoreSlug?: string;
  readonly urlNumericStoreId?: string;
  readonly nextDataPageRoute?: string;
  readonly nextDataStoreId?: string;
  readonly nextDataSeoCity?: string;
  readonly nextDataFallbackProductCount: number;
  readonly rawDomAnchorCount: number;
  readonly groupedDomCardCount: number;
  readonly duplicateDomAnchorsMergedCount: number;
  readonly domCatalogDiffersFromStaticHydration: boolean;
  readonly hasDeliveryEtaBadgeInDom: boolean;
  readonly hasOutOfCoverageWarningInDom: boolean;
  readonly openedFromAddressDirectoryContext: boolean;
  readonly sanitizedNavigationPathHistory: readonly string[];
  readonly liveUiVerificationSummary: {
    readonly activeAddressSelectionInLiveDom:
      "DETECTED_IN_HEADER" | "NOT_DETECTED_IN_HEADER";
    readonly cityMetadataInLiveDom: "STATIC_NEXT_DATA_SEO_CITY_ONLY" | "NONE_DETECTED";
    readonly servingStoreBranchInLiveDom: "NOT_EXPOSED_SEPARATELY_FROM_STATIC_STORE_ID";
    readonly contextBoundCatalogSignalInLiveDom:
      "DOM_DIFFERS_FROM_STATIC_SSR" | "DOM_MATCHES_OR_FALLS_BACK_TO_STATIC_SSR";
  };
}

function parseCliArgs(args: readonly string[]): CliOptions {
  let simulateControlledSession = false;
  let simulateUnverifiedHeaderOnly = false;
  let persistAuthorizedPersonalProfile = false;
  let nonInteractiveInspect = false;
  let allowProvisionalSessionObservations = false;
  let previewPrivateHistory = false;
  let saveToPrivateHistory = false;
  let dbPath = DEFAULT_PRIVATE_SQLITE_DB_PATH;
  let startUrl = "https://www.rappi.com.co/tiendas/tipo/market";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--simulate-controlled-session") {
      simulateControlledSession = true;
    } else if (arg === "--simulate-unverified-header-only") {
      simulateUnverifiedHeaderOnly = true;
    } else if (arg === "--persist-authorized-personal-profile") {
      persistAuthorizedPersonalProfile = true;
    } else if (arg === "--non-interactive-inspect") {
      nonInteractiveInspect = true;
    } else if (arg === "--allow-provisional-session-observations") {
      allowProvisionalSessionObservations = true;
    } else if (arg === "--preview-history") {
      previewPrivateHistory = true;
    } else if (arg === "--save") {
      saveToPrivateHistory = true;
    } else if (arg === "--db-path" && args[i + 1]) {
      dbPath = args[i + 1] ?? dbPath;
      i += 1;
    } else if (arg === "--url" && args[i + 1]) {
      startUrl = args[i + 1] ?? startUrl;
      i += 1;
    }
  }

  return {
    simulateControlledSession,
    simulateUnverifiedHeaderOnly,
    persistAuthorizedPersonalProfile,
    nonInteractiveInspect,
    allowProvisionalSessionObservations,
    previewPrivateHistory,
    saveToPrivateHistory,
    dbPath,
    startUrl,
  };
}

/**
 * Generates controlled local historical fixtures for the first few discovered listings
 * so Step 5 can verify deterministic price rules (`HISTORICAL_LOW`, `POTENTIAL_ANOMALY`,
 * `DECLARED_DISCOUNT`, and sparse-history protection) against the normalized in-memory observation.
 */
function buildControlledHistoricalSeed(
  provider: SupervisedBrowserSnapshotProvider,
  nowIso: string,
): readonly PriceObservationRecord[] {
  const report = provider.getInspectionReport();
  const baseMs = Date.parse(nowIso);
  const dayMs = 24 * 60 * 60 * 1000;
  const records: PriceObservationRecord[] = [];

  for (let idx = 0; idx < report.listings.length; idx += 1) {
    const listing = report.listings[idx];
    if (!listing) continue;

    const listingKey = buildCanonicalListingKey({
      providerId: RAPPI_BROWSER_PROVIDER_ID,
      externalStoreId: listing.store.externalStoreId,
      externalProductId: listing.variant.externalProductId,
      externalVariantId: listing.variant.externalVariantId,
      citySlug: listing.geographicContext.citySlug,
      ...(listing.geographicContext.zoneCode !== undefined
        ? { zoneCode: listing.geographicContext.zoneCode }
        : {}),
    });

    const priorMultipliers =
      idx === 0
        ? [1.35, 1.36, 1.34, 1.35, 1.35, 1.37]
        : idx === 1
          ? [1.95, 1.92, 1.98, 1.95, 1.94, 1.95]
          : [1.5];

    for (let h = 0; h < priorMultipliers.length; h += 1) {
      const mult = priorMultipliers[h] ?? 1.25;
      const priorPrice = createCopAmount(
        Math.round((listing.observedPriceCop * mult) / 100) * 100,
      );
      const daysAgo = priorMultipliers.length - h;
      records.push({
        observationId: `controlled-seed::${listingKey}::${String(h)}`,
        listingKey,
        providerId: RAPPI_BROWSER_PROVIDER_ID,
        externalStoreId: listing.store.externalStoreId,
        externalProductId: listing.variant.externalProductId,
        externalVariantId: listing.variant.externalVariantId,
        citySlug: listing.geographicContext.citySlug,
        observedPriceCop: priorPrice,
        availability: "IN_STOCK",
        provenance: listing.provenance,
        observedAt: new Date(baseMs - daysAgo * dayMs).toISOString(),
      });
    }
  }

  return records;
}

function buildControlledSessionSnapshot(
  nowIso: string,
  contextHmacSecret: string,
): RawStorefrontSnapshot {
  const previousSecret =
    process.env.PRICERADAR_PREVIOUS_CONTEXT_HMAC_SECRET ??
    readEnvVarFromFile(
      WORKSPACE_ENV_LOCAL_PATH,
      "PRICERADAR_PREVIOUS_CONTEXT_HMAC_SECRET",
    );
  return {
    pageUrl: "https://www.rappi.com.co/tiendas/900129753-turbo-super",
    pageTitle: "Turbo | Supermercados a Domicilio en Medellín - Rappi",
    observedAtIso: nowIso,
    hasSecurityChallenge: false,
    isLoginRequired: false,
    hasActiveDeliverySelector: true,
    rawDeliveryHeaderLabel: "Zona Residencial Seleccionada — Medellín",
    contextHmacSecret,
    ...(previousSecret !== undefined
      ? { previousContextHmacSecret: previousSecret }
      : {}),
    detectedCityName: "Medellín",
    detectedNeighborhoodName: "El Poblado",
    cityMetadataSource: "ACTIVE_DELIVERY_CONTEXT",
    storeId: "900129753-turbo-super",
    storeName: "Turbo",
    servingBranchId: "900129753-branch-poblado-z4",
    isServingBranchVerifiedForContext: true,
    catalogSource: "VERIFIED_CONTEXT_DOM",
    categorySlug: "supermercado",
    rawCards: [
      {
        externalId: "4030655",
        name: "Café Especial Tostión Media Bolsa 500 g",
        nameSource: "DOM_HEADING",
        brand: "Sierra Dorada",
        brandSource: "DOM_EXPLICIT",
        priceText: "$ 31.500",
        priceSource: "DOM_CARD_TEXT",
        referencePriceText: "$ 42.000",
        packagingText: "500 g",
        availabilityText: "Agregar",
        inStockFlag: true,
        href: "/p/cafe-especial-tostion-media-500g-4030655",
      },
      {
        externalId: "4030655",
        name: "Café Especial Tostión Media Bolsa 250 g",
        nameSource: "DOM_HEADING",
        brand: "Sierra Dorada",
        brandSource: "DOM_EXPLICIT",
        priceText: "$ 16.500",
        priceSource: "DOM_CARD_TEXT",
        referencePriceText: "$ 32.000",
        packagingText: "250 g",
        availabilityText: "Agregar",
        inStockFlag: true,
        href: "/p/cafe-especial-tostion-media-250g-4030655",
      },
      {
        externalId: "1804023",
        name: "Té Amarillo Sin Calorías Botella 2 L",
        nameSource: "DOM_HEADING",
        brand: "Hatsu",
        brandSource: "DOM_EXPLICIT",
        priceText: "$ 11.900",
        priceSource: "DOM_CARD_TEXT",
        referencePriceText: "$ 14.900",
        packagingText: "2000 ml",
        availabilityText: "Agregar",
        inStockFlag: true,
        href: "/p/hatsu-te-amarillo-sin-calorias-2-l-1804023",
      },
    ],
  };
}

function buildUnverifiedHeaderOnlySnapshot(
  nowIso: string,
  contextHmacSecret: string,
): RawStorefrontSnapshot {
  const base = buildControlledSessionSnapshot(nowIso, contextHmacSecret);
  return {
    ...base,
    isServingBranchVerifiedForContext: false,
    catalogSource: "STATIC_NEXT_DATA_FALLBACK",
    cityMetadataSource: "STATIC_SEO_METADATA",
  };
}

/**
 * Extracts a read-only DOM snapshot and sanitized UI evidence diagnostics from the
 * currently visible Playwright Page without calling any Rappi API endpoints,
 * reading cookies/tokens/credentials, or fabricating unverified DOM attributes.
 */
async function captureReadOnlyDomSnapshotFromPage(
  page: Page,
  observedAtIso: string,
  contextHmacSecret: string | undefined,
  navigationOptions?: {
    readonly sanitizedNavigationPathHistory?: readonly string[];
    readonly allowProvisionalSessionObservations?: boolean;
  },
): Promise<{
  readonly snapshot: RawStorefrontSnapshot;
  readonly uiDiagnostics: SanitizedUiEvidenceDiagnostics;
}> {
  const pageUrl = page.url();
  const pageTitle = await page.title();

  const domPayload = await page.evaluate(() => {
    const docText = document.body?.innerText ?? "";
    const hasChallenge =
      Boolean(
        document.querySelector(
          "#challenge-running, #cf-challenge-running, iframe[src*='captcha'], iframe[src*='turnstile']",
        ),
      ) || /verifica que eres humano|attention required/i.test(docText);

    // Inspect visible delivery address candidates in header (without reading account/profile modals)
    const candidateEls = Array.from(
      document.querySelectorAll(
        "[data-qa='address-label'], [data-qa*='address'], [data-testid*='address'], [data-qa*='location'], [data-testid*='location'], header button[aria-label*='dirección'], header [class*='address'], header [class*='Address']",
      ),
    );
    const headerCandidateSelectors = candidateEls.slice(0, 10).map((el) => {
      const tag = el.tagName.toLowerCase();
      const qa = el.getAttribute("data-qa");
      const testId = el.getAttribute("data-testid");
      return `${tag}${qa ? `[data-qa='${qa}']` : ""}${testId ? `[data-testid='${testId}']` : ""}`;
    });

    const firstWithText = candidateEls.find(
      (el) => (el.textContent?.trim().length ?? 0) >= 4,
    );
    const rawDeliveryHeaderLabel = firstWithText?.textContent?.trim() ?? undefined;
    const hasActiveDeliverySelector = Boolean(
      rawDeliveryHeaderLabel && rawDeliveryHeaderLabel.length >= 4,
    );

    const hasDeliveryEtaBadgeInDom = /\b\d{1,3}\s*(?:min|minutos)\b/i.test(docText);
    const hasOutOfCoverageWarningInDom =
      /fuera de cobertura|no disponible en tu direcci[oó]n|cambia tu direcci[oó]n/i.test(
        docText,
      );

    // Inspect __NEXT_DATA__ if present on the page
    const nextScript = document.getElementById("__NEXT_DATA__");
    const nextDataJson = nextScript?.textContent ?? undefined;

    // Priority 1 Fix: Group `a[href*='/p/']` anchors by their single-product card container
    // so image-link + title-link pairs inside the same card are never emitted as duplicate half-rendered cards.
    const productLinks = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href*='/p/']"),
    );
    const rawDomAnchorCount = productLinks.length;

    const normalizeHrefKey = (rawHref: string | null): string => {
      if (!rawHref) return "";
      return rawHref.split(/[?#]/)[0]?.trim() ?? "";
    };

    const findSingleProductCardRoot = (
      anchor: HTMLAnchorElement,
      targetHrefKey: string,
    ): HTMLElement => {
      let current: HTMLElement = anchor;
      let parent = current.parentElement;
      let depth = 0;

      while (parent && parent !== document.body && depth < 8) {
        const anchorsInParent = Array.from(
          parent.querySelectorAll<HTMLAnchorElement>("a[href*='/p/']"),
        );
        const distinctHrefs = new Set(
          anchorsInParent
            .map((a) => normalizeHrefKey(a.getAttribute("href")))
            .filter(Boolean),
        );
        // Stop immediately before an ancestor that holds links to more than 1 product URL
        if (distinctHrefs.size > 1 || !distinctHrefs.has(targetHrefKey)) {
          break;
        }
        current = parent;
        parent = current.parentElement;
        depth += 1;
      }
      return current;
    };

    const stripPumFromCardText = (text: string): string =>
      text
        .replace(
          /\(\s*\$\s*[\d.,\s]+\s*(?:\/|por)\s*(?:kg|g|gr|gramos|ml|l|lt|litros|und|un|unidad|u)\s*\)/gi,
          " ",
        )
        .replace(
          /\$\s*[\d.,]+\s*(?:\/|por)\s*(?:kg|g|gr|gramos|ml|l|lt|litros|und|un|unidad|u)\b/gi,
          " ",
        )
        .replace(/\bpum\s*:?\s*\$?\s*[\d.,]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    const isInvalidTitleText = (text: string): boolean => {
      const t = text.trim();
      if (t.length < 3) return true;
      if (/^\$\s*[\d.,\s]+/.test(t)) return true;
      if (/^-\s*\d+\s*%$/.test(t)) return true;
      if (/^(?:agregar|añadir|agotado|sin stock|\+|-)$/i.test(t)) return true;
      return false;
    };

    const groupedByCardRoot = new Map<
      HTMLElement,
      {
        readonly href: string;
        readonly anchors: HTMLAnchorElement[];
      }
    >();

    for (const anchor of productLinks) {
      const hrefKey = normalizeHrefKey(anchor.getAttribute("href"));
      if (!hrefKey) continue;
      const cardRoot = findSingleProductCardRoot(anchor, hrefKey);
      const existing = groupedByCardRoot.get(cardRoot);
      if (existing) {
        existing.anchors.push(anchor);
      } else {
        groupedByCardRoot.set(cardRoot, { href: hrefKey, anchors: [anchor] });
      }
    }

    const groupedEntries = Array.from(groupedByCardRoot.entries()).slice(0, 120);
    let duplicateDomAnchorsMergedCount = 0;

    const rawCards = groupedEntries.map(([cardRoot, { href, anchors }]) => {
      if (anchors.length > 1) {
        duplicateDomAnchorsMergedCount += anchors.length - 1;
      }

      const rawCardText = cardRoot.textContent ?? "";
      const cleanedCardText = stripPumFromCardText(rawCardText);

      // Extract integer COP prices from PUM-stripped card text
      const priceMatches = cleanedCardText.match(/\$\s*\d{1,3}(?:[.\s]\d{3})*/g) ?? [];
      const currentPriceText = priceMatches[0];
      const refPriceText = priceMatches.length > 1 ? priceMatches[1] : undefined;

      // Priority 1 Fix: Never include bare `span` in heading querySelector (which matched empty icon spans).
      // Check semantic title/heading elements first, then non-price anchor text, then descriptive img[alt].
      let nameText: string | undefined;
      let nameSource: ExtractedNameSource | undefined;

      const headingCandidates = Array.from(
        cardRoot.querySelectorAll(
          "h2, h3, h4, [data-qa*='title'], [data-qa*='name'], [data-testid*='title'], [data-testid*='name']",
        ),
      );
      for (const el of headingCandidates) {
        const candidate = el.textContent?.trim() ?? "";
        if (!isInvalidTitleText(candidate)) {
          nameText = candidate;
          nameSource = "DOM_HEADING";
          break;
        }
      }

      if (!nameText) {
        for (const a of anchors) {
          const titleAttr = a.getAttribute("title")?.trim() ?? "";
          if (!isInvalidTitleText(titleAttr)) {
            nameText = titleAttr;
            nameSource = "DOM_ANCHOR_TEXT";
            break;
          }
          const anchorText = stripPumFromCardText(a.textContent ?? "");
          if (!isInvalidTitleText(anchorText)) {
            nameText = anchorText;
            nameSource = "DOM_ANCHOR_TEXT";
            break;
          }
        }
      }

      if (!nameText) {
        for (const a of anchors) {
          const img = a.querySelector<HTMLImageElement>("img[alt]");
          const altText = img?.getAttribute("alt")?.trim() ?? "";
          if (
            !isInvalidTitleText(altText) &&
            !/^(?:image|imagen|producto|product|rappi)$/i.test(altText)
          ) {
            nameText = altText;
            nameSource = "DOM_IMAGE_ALT";
            break;
          }
        }
      }

      // Extract packaging only from PUM-stripped text
      const unitMatch = cleanedCardText.match(
        /\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|gramos|ml|l|lt|litros|und|un|unidades)\b/i,
      );

      // Extract availability ONLY when explicit out-of-stock or add-to-cart control exists in cardRoot
      const isExplicitlyOut = /agotado|sin stock|no disponible/i.test(rawCardText);
      const hasExplicitAddControl =
        Boolean(
          cardRoot.querySelector(
            "button, [role='button'], [data-qa*='add'], [data-testid*='add']",
          ),
        ) || /\bagregar\b|\bañadir\b/i.test(rawCardText);

      const availabilityText = isExplicitlyOut
        ? "Agotado"
        : hasExplicitAddControl
          ? "Agregar"
          : undefined;
      const inStockFlag = isExplicitlyOut
        ? false
        : hasExplicitAddControl
          ? true
          : undefined;

      return {
        name: nameText,
        nameSource,
        priceText: currentPriceText,
        priceSource: currentPriceText ? ("DOM_CARD_TEXT" as const) : undefined,
        referencePriceText: refPriceText,
        packagingText: unitMatch?.[0],
        availabilityText,
        inStockFlag,
        href,
      };
    });

    return {
      hasChallenge,
      headerCandidateCount: candidateEls.length,
      headerCandidateSelectors,
      rawDeliveryHeaderLabel,
      hasActiveDeliverySelector,
      hasDeliveryEtaBadgeInDom,
      hasOutOfCoverageWarningInDom,
      rawDomAnchorCount,
      groupedDomCardCount: rawCards.length,
      duplicateDomAnchorsMergedCount,
      nextDataJson,
      rawCards,
    };
  });

  // Analyze #__NEXT_DATA__ structurally for diagnostics without fabricating live branch/catalog bindings
  let nextDataPageRoute: string | undefined;
  let nextDataStoreId: string | undefined;
  let nextDataSeoCity: string | undefined;
  let nextDataFallbackProductCount = 0;
  const nextDataProductSignatures = new Set<string>();

  if (domPayload.nextDataJson) {
    try {
      const parsed = JSON.parse(domPayload.nextDataJson) as Record<string, unknown>;
      if (typeof parsed.page === "string") {
        nextDataPageRoute = parsed.page;
      }
      const props = (parsed.props as Record<string, unknown> | undefined) ?? {};
      const pageProps = (props.pageProps as Record<string, unknown> | undefined) ?? {};
      const storeContext =
        (pageProps.storeContext as Record<string, unknown> | undefined) ?? {};
      const seoStore = (pageProps.seoStore as Record<string, unknown> | undefined) ?? {};

      if (storeContext.store_id !== undefined) {
        nextDataStoreId = String(storeContext.store_id);
      }
      if (typeof seoStore.city === "string") {
        nextDataSeoCity = seoStore.city;
      }

      const fallback = (pageProps.fallback as Record<string, unknown> | undefined) ?? {};
      for (const key of Object.keys(fallback)) {
        const entry = fallback[key] as Record<string, unknown> | undefined;
        const homeResp =
          (entry?.store_home_response as Record<string, unknown> | undefined) ?? {};
        const data = (homeResp.data as Record<string, unknown> | undefined) ?? {};
        const components = Array.isArray(data.components) ? data.components : [];
        for (const comp of components) {
          const resource =
            ((comp as Record<string, unknown>)?.resource as
              Record<string, unknown> | undefined) ?? {};
          const products = Array.isArray(resource.products) ? resource.products : [];
          for (const rawProd of products) {
            const p = rawProd as Record<string, unknown>;
            nextDataFallbackProductCount += 1;
            const id = p.master_product_id ?? p.product_id ?? p.id;
            const price = p.price;
            if (id !== undefined && price !== undefined) {
              nextDataProductSignatures.add(`${String(id)}:${String(price)}`);
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON in diagnostics
    }
  }

  let domCatalogDiffersFromStaticHydration = false;
  for (const card of domPayload.rawCards) {
    const idMatch = card.href?.match(/-(\d+)(?:[/?#]|$)/)?.[1];
    const digitsOnly = card.priceText?.replace(/[^\d]/g, "");
    if (idMatch && digitsOnly) {
      if (!nextDataProductSignatures.has(`${idMatch}:${digitsOnly}`)) {
        domCatalogDiffersFromStaticHydration = true;
        break;
      }
    }
  }

  const urlStoreMatch = pageUrl.match(/\/tiendas\/([^/?#]+)/i);
  const urlStoreSlug = urlStoreMatch?.[1];
  const urlNumericStoreId = urlStoreSlug?.match(/^(\d+)/)?.[1];

  const previousSecret =
    process.env.PRICERADAR_PREVIOUS_CONTEXT_HMAC_SECRET ??
    readEnvVarFromFile(
      WORKSPACE_ENV_LOCAL_PATH,
      "PRICERADAR_PREVIOUS_CONTEXT_HMAC_SECRET",
    );

  const sanitizedNavigationPathHistory =
    navigationOptions?.sanitizedNavigationPathHistory ?? [];
  const hasDirectoryInPathHistory =
    sanitizedNavigationPathHistory.some((p) => /^\/tiendas\/tipo\/market/i.test(p)) &&
    Boolean(urlStoreSlug);
  const hasSpaTransitionFromDirectory =
    nextDataPageRoute === "/tiendas/tipo/[type]" && Boolean(urlStoreSlug);
  const openedFromAddressDirectoryContext =
    domPayload.hasActiveDeliverySelector &&
    !domPayload.hasOutOfCoverageWarningInDom &&
    (hasDirectoryInPathHistory || hasSpaTransitionFromDirectory);

  // Fail-closed: Do NOT fabricate servingBranchId or isServingBranchVerifiedForContext on live pages
  // because Rappi's DOM does not expose an explicit attribute binding the URL store_id to the header address.
  const snapshot: RawStorefrontSnapshot = {
    pageUrl,
    pageTitle,
    observedAtIso,
    hasSecurityChallenge: domPayload.hasChallenge,
    hasActiveDeliverySelector: domPayload.hasActiveDeliverySelector,
    ...(domPayload.rawDeliveryHeaderLabel !== undefined
      ? { rawDeliveryHeaderLabel: domPayload.rawDeliveryHeaderLabel }
      : {}),
    ...(contextHmacSecret !== undefined ? { contextHmacSecret } : {}),
    ...(previousSecret !== undefined
      ? { previousContextHmacSecret: previousSecret }
      : {}),
    isServingBranchVerifiedForContext: false,
    openedFromAddressDirectoryContext,
    sanitizedNavigationPathHistory,
    ...(navigationOptions?.allowProvisionalSessionObservations === true
      ? { allowProvisionalSessionObservations: true }
      : {}),
    catalogSource:
      domPayload.rawCards.length > 0 && domCatalogDiffersFromStaticHydration
        ? "UNVERIFIED_LIVE_DOM"
        : "STATIC_NEXT_DATA_FALLBACK",
    ...(domPayload.nextDataJson !== undefined
      ? { nextDataJson: domPayload.nextDataJson }
      : {}),
    rawCards: domPayload.rawCards.map((c) => ({
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.nameSource !== undefined ? { nameSource: c.nameSource } : {}),
      ...(c.priceText !== undefined ? { priceText: c.priceText } : {}),
      ...(c.priceSource !== undefined ? { priceSource: c.priceSource } : {}),
      ...(c.referencePriceText !== undefined
        ? { referencePriceText: c.referencePriceText }
        : {}),
      ...(c.packagingText !== undefined ? { packagingText: c.packagingText } : {}),
      ...(c.availabilityText !== undefined
        ? { availabilityText: c.availabilityText }
        : {}),
      ...(c.inStockFlag !== undefined ? { inStockFlag: c.inStockFlag } : {}),
      ...(c.href !== undefined ? { href: c.href } : {}),
    })),
  };

  const uiDiagnostics: SanitizedUiEvidenceDiagnostics = {
    headerAddressCandidateCount: domPayload.headerCandidateCount,
    headerCandidateSelectors: domPayload.headerCandidateSelectors,
    hasNonEmptyHeaderAddressLabel: domPayload.hasActiveDeliverySelector,
    ...(urlStoreSlug !== undefined ? { urlStoreSlug } : {}),
    ...(urlNumericStoreId !== undefined ? { urlNumericStoreId } : {}),
    ...(nextDataPageRoute !== undefined ? { nextDataPageRoute } : {}),
    ...(nextDataStoreId !== undefined ? { nextDataStoreId } : {}),
    ...(nextDataSeoCity !== undefined ? { nextDataSeoCity } : {}),
    nextDataFallbackProductCount,
    rawDomAnchorCount: domPayload.rawDomAnchorCount,
    groupedDomCardCount: domPayload.groupedDomCardCount,
    duplicateDomAnchorsMergedCount: domPayload.duplicateDomAnchorsMergedCount,
    domCatalogDiffersFromStaticHydration,
    hasDeliveryEtaBadgeInDom: domPayload.hasDeliveryEtaBadgeInDom,
    hasOutOfCoverageWarningInDom: domPayload.hasOutOfCoverageWarningInDom,
    openedFromAddressDirectoryContext,
    sanitizedNavigationPathHistory,
    liveUiVerificationSummary: {
      activeAddressSelectionInLiveDom: domPayload.hasActiveDeliverySelector
        ? "DETECTED_IN_HEADER"
        : "NOT_DETECTED_IN_HEADER",
      cityMetadataInLiveDom: nextDataSeoCity
        ? "STATIC_NEXT_DATA_SEO_CITY_ONLY"
        : "NONE_DETECTED",
      servingStoreBranchInLiveDom: "NOT_EXPOSED_SEPARATELY_FROM_STATIC_STORE_ID",
      contextBoundCatalogSignalInLiveDom: domCatalogDiffersFromStaticHydration
        ? "DOM_DIFFERS_FROM_STATIC_SSR"
        : "DOM_MATCHES_OR_FALLS_BACK_TO_STATIC_SSR",
    },
  };

  return { snapshot, uiDiagnostics };
}

async function launchIsolatedContext(persistAuthorizedPersonalProfile: boolean): Promise<{
  readonly browser?: Browser;
  readonly context: BrowserContext;
  readonly ephemeralProfileDir?: string;
}> {
  if (persistAuthorizedPersonalProfile) {
    const profileDir = path.join(
      os.homedir(),
      ".local",
      "share",
      "priceradar",
      "chromium-profile",
    );
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1366, height: 900 },
        locale: "es-CO",
      });
      return { context };
    } catch {
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: "chrome",
        viewport: { width: 1366, height: 900 },
        locale: "es-CO",
      });
      return { context };
    }
  }

  const ephemeralProfileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "priceradar-ephemeral-chromium-"),
  );
  try {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "es-CO",
    });
    return { browser, context, ephemeralProfileDir };
  } catch {
    const context = await chromium.launchPersistentContext(ephemeralProfileDir, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1366, height: 900 },
      locale: "es-CO",
    });
    return { context, ephemeralProfileDir };
  }
}

async function runSupervisedBrowserPoc(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const nowIso = "2026-11-07T13:20:00.000Z";

  let snapshot: RawStorefrontSnapshot;
  let uiDiagnostics: SanitizedUiEvidenceDiagnostics | undefined;

  if (options.simulateControlledSession || options.simulateUnverifiedHeaderOnly) {
    const resolvedSecret =
      resolveOrProvisionContextHmacSecret({
        envFilePath: WORKSPACE_ENV_LOCAL_PATH,
        explicitSecret:
          process.env.PRICERADAR_CONTEXT_HMAC_SECRET ?? CONTROLLED_SIMULATION_HMAC_SECRET,
      }) ?? CONTROLLED_SIMULATION_HMAC_SECRET;

    snapshot = options.simulateUnverifiedHeaderOnly
      ? buildUnverifiedHeaderOnlySnapshot(nowIso, resolvedSecret)
      : buildControlledSessionSnapshot(nowIso, resolvedSecret);
  } else {
    console.log(
      "================================================================================",
    );
    console.log("PriceRadar Phase P1 — Supervised Rappi Browser Inspector");
    console.log(
      "================================================================================",
    );
    console.log(
      "Security & Isolation Mode:",
      options.persistAuthorizedPersonalProfile
        ? "Authorized Personal Profile (~/.local/share/priceradar/chromium-profile, 0700)"
        : "Ephemeral In-Memory Browser Context (Default — zero session material persisted on disk)",
    );
    console.log(
      "1. A visible Chromium window will open. Never use your corporate browser profile.",
    );
    console.log(
      "2. Log in manually if needed and select your delivery address in the Rappi header.",
    );
    console.log("3. Navigate to ONE storefront page you wish to inspect.");
    console.log(
      "4. Return to this terminal and press ENTER to perform a single read-only DOM inspection.",
    );
    console.log(
      "================================================================================",
    );

    const secretFilePath = path.join(
      os.homedir(),
      ".local",
      "share",
      "priceradar",
      "context-hmac.key",
    );
    const contextHmacSecret = resolveOrProvisionContextHmacSecret({
      envFilePath: WORKSPACE_ENV_LOCAL_PATH,
      secretFilePath,
      allowCreateFile: options.persistAuthorizedPersonalProfile,
    });

    const { browser, context, ephemeralProfileDir } = await launchIsolatedContext(
      options.persistAuthorizedPersonalProfile,
    );

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const navigationHistory: string[] = [];
      const recordSanitizedPath = (rawUrl: string): void => {
        try {
          const parsedUrl = new URL(rawUrl);
          if (!parsedUrl.hostname.endsWith("rappi.com.co")) return;
          const cleanPath = parsedUrl.pathname.replace(/\/+$/, "") || "/";
          if (navigationHistory[navigationHistory.length - 1] !== cleanPath) {
            navigationHistory.push(cleanPath);
          }
        } catch {
          // Ignore non-HTTP frame URLs
        }
      };
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          recordSanitizedPath(frame.url());
        }
      });

      await page.goto(options.startUrl, { waitUntil: "domcontentloaded" });
      recordSanitizedPath(page.url());

      if (!options.nonInteractiveInspect) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        await rl.question(
          "\n[Action Required] Select your delivery address and open ONE storefront page in Chromium, then press ENTER here to inspect...",
        );
        rl.close();
      }
      recordSanitizedPath(page.url());

      const captured = await captureReadOnlyDomSnapshotFromPage(
        page,
        new Date().toISOString(),
        contextHmacSecret,
        {
          sanitizedNavigationPathHistory: navigationHistory,
          allowProvisionalSessionObservations:
            options.allowProvisionalSessionObservations,
        },
      );
      snapshot = captured.snapshot;
      uiDiagnostics = captured.uiDiagnostics;
    } finally {
      await context.close();
      if (browser) {
        await browser.close();
      }
      if (ephemeralProfileDir) {
        fs.rmSync(ephemeralProfileDir, { recursive: true, force: true });
      }
    }
  }

  const initialProvider = new SupervisedBrowserSnapshotProvider(snapshot);
  const report = initialProvider.getInspectionReport();

  if (options.previewPrivateHistory || options.saveToPrivateHistory) {
    const privateCliResult = await executePrivateHistoryCliCommand({
      command: options.saveToPrivateHistory ? "save" : "preview",
      dbPath: options.dbPath,
      snapshot,
    });
    console.log(
      JSON.stringify(
        {
          service: "priceradar-rappi-inspect",
          gateStatus: report.gateStatus,
          gateMessage: report.gateMessage,
          pageUrl: report.pageUrl,
          observedAtIso: report.observedAtIso,
          geographicValidation: report.geographicValidation,
          diagnostics: report.diagnostics,
          ...(uiDiagnostics !== undefined ? { uiDiagnostics } : {}),
          fieldVerification: report.fieldVerification,
          privateHistoryAction: {
            command: privateCliResult.command,
            titleEsCo: privateCliResult.titleEsCo,
            messageEsCo: privateCliResult.messageEsCo,
            ...privateCliResult.payload,
          },
        },
        null,
        2,
      ),
    );
    if (privateCliResult.exitCode !== 0) {
      process.exit(privateCliResult.exitCode);
    }
    return;
  }

  if (report.gateStatus !== "OK") {
    console.log(
      JSON.stringify(
        {
          service: "priceradar-rappi-inspect",
          gateStatus: report.gateStatus,
          gateMessage: report.gateMessage,
          pageUrl: report.pageUrl,
          observedAtIso: report.observedAtIso,
          geographicValidation: report.geographicValidation,
          diagnostics: report.diagnostics,
          ...(uiDiagnostics !== undefined ? { uiDiagnostics } : {}),
          fieldVerification: report.fieldVerification,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  // Step 5: Minimal Integration with controlled local historical fixtures & deterministic rules
  const controlledSeed = buildControlledHistoricalSeed(initialProvider, nowIso);
  const providerWithHistory = new SupervisedBrowserSnapshotProvider(
    snapshot,
    controlledSeed,
  );
  const repository = new InMemoryPriceRadarRepository(controlledSeed);

  const scanOutput = await executeDiscoveryScan({
    scanRunId: `p1-supervised-inspect-${String(Date.now())}`,
    provider: providerWithHistory,
    repository,
    nowIso,
  });

  const sanitizedSummary = {
    service: "priceradar-rappi-inspect",
    mode: options.simulateControlledSession
      ? "CONTROLLED_SUPERVISED_SIMULATION"
      : "LIVE_SUPERVISED_BROWSER",
    gateStatus: report.gateStatus,
    gateMessage: report.gateMessage,
    pageUrl: report.pageUrl,
    geographicValidation: report.geographicValidation,
    diagnostics: report.diagnostics,
    ...(uiDiagnostics !== undefined ? { uiDiagnostics } : {}),
    fieldVerification: report.fieldVerification,
    normalizationMetrics: {
      normalizedListingsCount: report.listings.length,
      skippedMalformedCount: report.skippedMalformedCount,
      duplicateSuppressedCount: report.duplicateSuppressedCount,
    },
    scanRun: scanOutput.scanRun,
    sampleNormalizedListings: report.listings.slice(0, 5).map((item) => ({
      storeId: item.store.externalStoreId,
      storeName: item.store.name,
      productId: item.variant.externalProductId,
      variantId: item.variant.externalVariantId,
      name: item.variant.name,
      brand: item.variant.brand,
      packagingLabel: item.variant.packagingLabel,
      unitQuantity: item.variant.unitQuantity,
      unitType: item.variant.unitType,
      observedPriceCop: item.observedPriceCop,
      formattedPrice: formatCop(item.observedPriceCop),
      declaredReferencePriceCop: item.declaredReferencePriceCop,
      availability: item.availability,
      provenance: item.provenance,
      citySlug: item.geographicContext.citySlug,
      fulfillmentContextHash: item.geographicContext.zoneCode,
      productUrl: item.variant.productUrl,
    })),
    detectedOpportunities: scanOutput.detectedOpportunities.map((opp) => ({
      opportunityKey: opp.opportunityKey,
      type: opp.type,
      labelEsCo: opp.labelEsCo,
      observedPrice: formatCop(opp.observedPriceCop),
      baselinePrice: formatCop(opp.baselinePriceCop),
      discountPercentage: `${String(opp.discountPercentage)}%`,
      confidence: opp.confidence,
      requiresVerification: opp.requiresVerification,
      provenance: opp.provenance,
    })),
  };

  console.log(JSON.stringify(sanitizedSummary, null, 2));
}

runSupervisedBrowserPoc().catch((err) => {
  console.error(
    JSON.stringify({
      service: "priceradar-rappi-inspect",
      level: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
