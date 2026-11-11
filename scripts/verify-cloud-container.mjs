#!/usr/bin/env node
/**
 * Verification script for PriceRadar P5 Cloud Container Configuration (`F7-04`).
 * Validates container architecture, Dockerfile directives, fail-closed auth, and Chromium readiness contracts.
 * Runs in CI and local test environments without requiring a local Docker daemon.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");

console.log("================================================================");
console.log("PriceRadar Cloud Container Verification (F7-04)");
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

// 4. Cloud scheduler worker lock & heartbeat check
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
    "Cloud scheduler explicitly marks synthetic demo data with DEMO_FIXTURE and UNVERIFIED_DEMO_FIXTURE",
    schedulerContent.includes("UNVERIFIED_DEMO_FIXTURE") &&
      schedulerContent.includes("SYNTHETIC_DEMO_CONTEXT"),
  );
}

console.log("================================================================");
if (failureCount > 0) {
  console.error(`Verification FAILED with ${failureCount} issue(s).`);
  process.exit(1);
} else {
  console.log("Verification PASSED: All cloud container invariants verified.");
  process.exit(0);
}
