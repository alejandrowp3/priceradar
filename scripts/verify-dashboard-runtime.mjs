import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCopAmount } from "../packages/domain/src/index.ts";
import {
  SqlitePrivateHistoryRepository,
  resolveWorkspaceRoot,
} from "../packages/database/src/index.ts";

const fetch = globalThis.fetch;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const webDir = path.resolve(workspaceRoot, "apps", "web");
const nextBin = path.resolve(webDir, "node_modules", ".bin", "next");

const VALID_CTX_HASH = "ctx-88be5762563932c5";

function seedFixtureDatabase(dbPath) {
  const repo = new SqlitePrivateHistoryRepository(dbPath);

  function makeListing(overrides) {
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
        externalVariantId: `${overrides.externalProductId}-std`,
        name: overrides.name,
        brand: overrides.brand,
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
            declaredReferencePriceCop: createCopAmount(
              overrides.declaredReferencePriceCop,
            ),
          }
        : {}),
      availability: "IN_STOCK",
      provenance: "PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL",
      sourceObservedAt: overrides.sourceObservedAt,
    };
  }

  function makeBatch(listings, options) {
    return {
      scanRunId: options.scanRunId,
      observedAtIso: options.observedAtIso,
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
      sourceView: {
        viewKey: options.sourceView.viewKey,
        pageKind: "STORE_SUBPATH",
        labelSource: "OWNER_PROVIDED",
        ownerLabel: options.sourceView.ownerLabel,
      },
    };
  }

  // Scan 1: Baseline
  repo.persistApprovedInspectionBatch(
    makeBatch(
      [
        makeListing({
          externalProductId: "whisky-black",
          name: "Whisky Johnnie Walker Black 750ml",
          brand: "Johnnie Walker",
          observedPriceCop: 100000,
          sourceObservedAt: "2026-11-08T10:00:00.000Z",
        }),
        makeListing({
          externalProductId: "cafe-juan",
          name: "Café Juan Valdez 500g",
          brand: "Juan Valdez",
          observedPriceCop: 28000,
          sourceObservedAt: "2026-11-08T10:00:00.000Z",
        }),
      ],
      {
        scanRunId: "scan-live-1",
        observedAtIso: "2026-11-08T10:00:00.000Z",
        sourceView: { viewKey: "/tiendas/turbo/licores", ownerLabel: "licores" },
      },
    ),
    { ownerConfirmed: true },
  );

  // Scan 2: Drop on whisky ($100.000 -> $75.000)
  repo.persistApprovedInspectionBatch(
    makeBatch(
      [
        makeListing({
          externalProductId: "whisky-black",
          name: "Whisky Johnnie Walker Black 750ml",
          brand: "Johnnie Walker",
          observedPriceCop: 75000,
          declaredReferencePriceCop: 100000,
          sourceObservedAt: "2026-11-09T10:00:00.000Z",
        }),
        makeListing({
          externalProductId: "cafe-juan",
          name: "Café Juan Valdez 500g",
          brand: "Juan Valdez",
          observedPriceCop: 28000,
          sourceObservedAt: "2026-11-09T10:00:00.000Z",
        }),
      ],
      {
        scanRunId: "scan-live-2",
        observedAtIso: "2026-11-09T10:00:00.000Z",
        sourceView: { viewKey: "/tiendas/turbo/licores", ownerLabel: "licores" },
      },
    ),
    { ownerConfirmed: true },
  );

  repo.close();
}

async function startServer(mode, port, dbPath) {
  console.log(`[Next.js Runtime Test] Starting '${mode}' on port ${port}...`);
  const child = spawn(nextBin, [mode, "-p", String(port), "-H", "127.0.0.1"], {
    cwd: webDir,
    env: {
      ...process.env,
      PORT: String(port),
      PRICERADAR_SQLITE_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrLogs = "";
  child.stderr.on("data", (chunk) => {
    stderrLogs += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    const msg = chunk.toString();
    if (msg.includes("Error")) {
      stderrLogs += msg;
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  // Poll until ready (up to 20s)
  const startTime = Date.now();
  let ready = false;

  while (Date.now() - startTime < 20000) {
    try {
      const res = await fetch(`${baseUrl}/`, {
        headers: { host: `127.0.0.1:${port}` },
      });
      // If we get an HTTP response (even error), server is responding
      if (res.status === 200) {
        ready = true;
        break;
      }
      if (res.status === 500) {
        const text = await res.text();
        throw new Error(`Server returned HTTP 500 on startup:\n${text}\n${stderrLogs}`);
      }
    } catch (e) {
      if (e.message && e.message.includes("HTTP 500")) {
        child.kill("SIGTERM");
        throw e;
      }
      // Retry in 250ms
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(
      `Next.js server in '${mode}' mode failed to respond within 20s. Logs:\n${stderrLogs}`,
    );
  }

  console.log(`[Next.js Runtime Test] Server in '${mode}' mode is ready at ${baseUrl}`);

  return {
    baseUrl,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}

async function verifyRoutes(baseUrl, port, expectedVariantKey) {
  const routes = [
    { path: "/", name: "Overview" },
    { path: "/products", name: "Products" },
    { path: "/opportunities", name: "Opportunities" },
    { path: "/coverage", name: "Coverage" },
    {
      path: `/products/${encodeURIComponent(expectedVariantKey)}`,
      name: "ProductDetail",
    },
  ];

  for (const route of routes) {
    const url = `${baseUrl}${route.path}`;
    const res = await fetch(url, {
      headers: { host: `127.0.0.1:${port}` },
    });

    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(
        `Route ${route.name} (${route.path}) returned HTTP ${res.status}:\n${body}`,
      );
    }

    const html = await res.text();
    if (html.includes("TypeError") || html.includes("paths[0]")) {
      throw new Error(
        `Route ${route.name} (${route.path}) contained TypeError in response!`,
      );
    }

    console.log(
      `  ✓ Route '${route.name}' (${route.path}) responded HTTP 200 OK (${html.length} bytes)`,
    );
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priceradar-live-runtime-"));
  const fixtureDbPath = path.join(tempDir, "private-history.sqlite");
  const emptyDbPath = path.join(tempDir, "empty-nonexistent.sqlite");

  console.log(`================================================================`);
  console.log(`PriceRadar P4 — Next.js Runtime Live HTTP Verification`);
  console.log(`Fixture directory : ${tempDir}`);
  console.log(`Fixture database  : ${fixtureDbPath}`);
  console.log(`Workspace root    : ${resolveWorkspaceRoot()}`);
  console.log(`================================================================`);

  try {
    // 1. Seed database
    seedFixtureDatabase(fixtureDbPath);
    console.log(`[Fixture] Seeded authentic temporary SQLite database successfully.`);

    const variantKey = "rappi-authenticated-inspector::whisky-black::whisky-black-std";

    // 2. Test in DEVELOPMENT MODE
    console.log(`\n--- Test Phase 1: Development Mode ('next dev') ---`);
    const devServer = await startServer("dev", 4185, fixtureDbPath);
    await verifyRoutes(devServer.baseUrl, 4185, variantKey);
    await devServer.stop();
    console.log(`[Success] Development mode runtime tests passed!`);

    // 3. Test in PRODUCTION MODE
    console.log(`\n--- Test Phase 2: Production Mode ('next start') ---`);
    console.log(
      `[Next.js Production Build] Compiling production build before 'next start'...`,
    );
    execSync(`${nextBin} build`, {
      cwd: webDir,
      stdio: "pipe",
      env: {
        ...process.env,
        PRICERADAR_SQLITE_PATH: fixtureDbPath,
      },
    });
    const prodServer = await startServer("start", 4186, fixtureDbPath);
    await verifyRoutes(prodServer.baseUrl, 4186, variantKey);
    await prodServer.stop();
    console.log(`[Success] Production mode runtime tests passed!`);

    // 4. Test EMPTY DATABASE state
    console.log(`\n--- Test Phase 3: Empty Database State ('next start') ---`);
    const emptyServer = await startServer("start", 4187, emptyDbPath);
    const emptyRes = await fetch(`${emptyServer.baseUrl}/`, {
      headers: { host: "127.0.0.1:4187" },
    });
    if (emptyRes.status !== 200) {
      throw new Error(`Empty database route returned HTTP ${emptyRes.status}`);
    }
    const emptyHtml = await emptyRes.text();
    if (!emptyHtml.includes("Historial de precios sin observaciones")) {
      throw new Error(`Empty database did not render expected EmptyState!`);
    }
    console.log(
      `  ✓ Empty database Overview responded HTTP 200 and rendered EmptyState correctly.`,
    );
    await emptyServer.stop();
    console.log(`[Success] Empty database runtime tests passed!`);

    console.log(`\n================================================================`);
    console.log(
      `ALL Next.js live runtime tests PASSED in BOTH Development and Production modes!`,
    );
    console.log(`================================================================`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FATAL RUNTIME VERIFICATION ERROR:", err);
  process.exit(1);
});
