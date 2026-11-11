#!/usr/bin/env node
/**
 * Static configuration verification for PriceRadar P5 Cloud Container (`F7-04`, `F7-09`).
 * NOTE: This script performs fast static verification of Dockerfile, railway.json, entrypoint,
 * and fail-closed configurations without requiring a local Docker daemon.
 * Live container runtime execution (Chromium headless boot, Next.js web startup, and persistent volume mount)
 * is executed reproducibly in GitHub Actions CI (`.github/workflows/ci.yml`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");

console.log("================================================================");
console.log(
  "PriceRadar Cloud Container Static Configuration Verification (F7-04, F7-09)",
);
console.log("(Note: Live container runtime tests execute in CI via Docker)");
console.log("================================================================");

let failureCount = 0;

function assertCondition(desc, passed, detail = "") {
  if (passed) {
    console.log(`[PASS] ${desc}`);
  } else {
    console.error(`[FAIL] ${desc}${detail ? ` - ${detail}` : ""}`);
    failureCount += 1;
  }
}

// 1. Dockerfile checks
const dockerfilePath = path.join(workspaceRoot, "Dockerfile");
assertCondition("Dockerfile exists at workspace root", fs.existsSync(dockerfilePath));

if (fs.existsSync(dockerfilePath)) {
  const content = fs.readFileSync(dockerfilePath, "utf-8");

  assertCondition(
    "Dockerfile does NOT set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    !content.includes("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"),
  );

  assertCondition(
    "Dockerfile sets PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    content.includes("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"),
  );

  assertCondition(
    "Dockerfile installs Playwright Chromium during build",
    content.includes("playwright install chromium"),
  );

  assertCondition(
    "Dockerfile copies /ms-playwright into runner image",
    content.includes("COPY --from=builder /ms-playwright /ms-playwright"),
  );

  assertCondition(
    "Dockerfile declares persistent volume for /data",
    content.includes('VOLUME ["/data"]'),
  );

  assertCondition("Dockerfile exposes port 4178", content.includes("EXPOSE 4178"));
}

// 2. Chromium readiness diagnostic script check
const chromiumReadinessPath = path.join(
  workspaceRoot,
  "apps",
  "worker",
  "src",
  "chromium-readiness.ts",
);
assertCondition(
  "Chromium readiness diagnostic script exists",
  fs.existsSync(chromiumReadinessPath),
);

// 3. Cloud entrypoint fail-closed validation check
const entrypointPath = path.join(
  workspaceRoot,
  "apps",
  "worker",
  "src",
  "cloud-entrypoint.ts",
);
assertCondition("Cloud entrypoint exists", fs.existsSync(entrypointPath));

if (fs.existsSync(entrypointPath)) {
  const entrypointContent = fs.readFileSync(entrypointPath, "utf-8");
  assertCondition(
    "Cloud entrypoint implements validateCloudStartupConfig",
    entrypointContent.includes("validateCloudStartupConfig"),
  );
  assertCondition(
    "Cloud entrypoint distinguishes unexpected crash from graceful shutdown",
    entrypointContent.includes("isShuttingDown") &&
      entrypointContent.includes("exitCode = code !== null && code !== 0 ? code : 1"),
  );
}

// 4. Cloud scheduler worker lock, lease renewal & heartbeat check (F7-06, F7-09)
const schedulerPath = path.join(
  workspaceRoot,
  "apps",
  "worker",
  "src",
  "cloud-scheduler.ts",
);
assertCondition("Cloud scheduler exists", fs.existsSync(schedulerPath));

if (fs.existsSync(schedulerPath)) {
  const schedulerContent = fs.readFileSync(schedulerPath, "utf-8");
  assertCondition(
    "Cloud scheduler implements atomic status file writes (.tmp + rename)",
    schedulerContent.includes("renameSync"),
  );
  assertCondition(
    "Cloud scheduler implements distributed worker lock (acquireWorkerLock)",
    schedulerContent.includes("acquireWorkerLock"),
  );
  assertCondition(
    "Cloud scheduler implements active lease renewal (renewWorkerLock)",
    schedulerContent.includes("renewWorkerLock"),
  );
  assertCondition(
    "Cloud scheduler verifies lock ownership before persistence (isWorkerLockHeldBy)",
    schedulerContent.includes("isWorkerLockHeldBy"),
  );
  assertCondition(
    "Cloud scheduler explicitly marks synthetic demo data with DEMO_FIXTURE and UNVERIFIED_DEMO_FIXTURE",
    schedulerContent.includes("UNVERIFIED_DEMO_FIXTURE") &&
      schedulerContent.includes("SYNTHETIC_DEMO_CONTEXT"),
  );
}

// 5. Storage persistence contract & readiness checks (F7-10, F7-11)
const storagePersistencePath = path.join(
  workspaceRoot,
  "packages",
  "database",
  "src",
  "storage-persistence.ts",
);
assertCondition(
  "Storage persistence contract module exists",
  fs.existsSync(storagePersistencePath),
);

if (fs.existsSync(storagePersistencePath)) {
  const content = fs.readFileSync(storagePersistencePath, "utf-8");
  assertCondition(
    "Storage persistence distinguishes persistent tiers from ephemeral filesystems",
    content.includes("verifyStoragePersistenceContract") &&
      content.includes("UNVERIFIED_EPHEMERAL_FILESYSTEM") &&
      content.includes("RAILWAY_PERSISTENT_VOLUME"),
  );
  assertCondition(
    "Storage persistence writes atomic volume marker for restart durability",
    content.includes("VOLUME_MARKER_FILENAME") && content.includes(".tmp"),
  );
}

const dbLibPath = path.join(workspaceRoot, "apps", "web", "src", "lib", "db.ts");
if (fs.existsSync(dbLibPath)) {
  const content = fs.readFileSync(dbLibPath, "utf-8");
  assertCondition(
    "System readiness requires positive evidence of active scheduler in cloud mode (F7-10)",
    content.includes("checkSystemReadiness") &&
      content.includes("schedulerStatus.isRunning") &&
      content.includes("isFutureDated"),
  );
}

// 6. Railway configuration check (F7-09)
const railwayConfigPath = path.join(workspaceRoot, "railway.json");
assertCondition(
  "railway.json exists at workspace root",
  fs.existsSync(railwayConfigPath),
);

if (fs.existsSync(railwayConfigPath)) {
  const railwayContent = fs.readFileSync(railwayConfigPath, "utf-8");
  const railwayJson = JSON.parse(railwayContent);
  assertCondition(
    "railway.json sets numReplicas to 1 in deploy configuration",
    railwayJson.deploy?.numReplicas === 1,
  );
}

console.log("================================================================");
if (failureCount > 0) {
  console.error(`Verification FAILED with ${failureCount} issue(s).`);
  process.exit(1);
} else {
  console.log("Verification PASSED: All cloud container static invariants verified.");
  process.exit(0);
}
