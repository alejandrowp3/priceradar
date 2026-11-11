import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyStoragePersistenceContract,
  isCloudDeployment,
} from "@priceradar/database";
import type { PersistenceTier, VolumeMarkerInfo } from "@priceradar/database";
import { CloudScheduler } from "./cloud-scheduler.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "../../..");
const webDir = path.resolve(workspaceRoot, "apps", "web");

export interface CloudStartupConfig {
  readonly port: string;
  readonly host: string;
  readonly sqlitePath: string;
  readonly intervalMinutes: number;
  readonly webPassword?: string;
  readonly isLoopback: boolean;
  readonly persistenceTier: PersistenceTier;
  readonly volumeMarker?: VolumeMarkerInfo | null;
}

/**
 * Validates cloud service configuration before process launch (`F7-01`, `F7-11`).
 * - Fails closed: non-loopback binding requires non-empty PRICERADAR_WEB_PASSWORD.
 * - Fails closed: cloud environment requires verified persistent volume contract.
 */
export function validateCloudStartupConfig(env: NodeJS.ProcessEnv): CloudStartupConfig {
  const port = env.PORT ?? "4178";
  const host = env.HOST ?? "0.0.0.0";
  const sqlitePath = env.PRICERADAR_SQLITE_PATH ?? "/data/private-history.sqlite";
  const intervalMinutes = Number(env.PRICERADAR_SCHEDULE_INTERVAL_MINUTES ?? "60");
  const webPassword = env.PRICERADAR_WEB_PASSWORD?.trim();

  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

  const isCloud = isCloudDeployment(env) || env.NODE_ENV === "production";

  if ((!isLoopback || isCloud) && (!webPassword || webPassword.length === 0)) {
    throw new Error(
      `Security violation: PRICERADAR_WEB_PASSWORD must be configured when binding to non-loopback host '${host}' or operating in cloud mode. Passwordless mode is restricted strictly to local loopback (127.0.0.1 / localhost) in local development.`,
    );
  }

  // F7-11: Validate persistent storage contract before launching cloud workers
  const storageDir = path.dirname(path.resolve(sqlitePath));
  const persistenceResult = verifyStoragePersistenceContract(storageDir, env);

  if (isCloud && !persistenceResult.persistenceVerified) {
    throw new Error(
      `Storage configuration violation: ${persistenceResult.reason ?? "Persistent storage verification failed."}`,
    );
  }

  return {
    port,
    host,
    sqlitePath,
    intervalMinutes,
    ...(webPassword ? { webPassword } : {}),
    isLoopback,
    persistenceTier: persistenceResult.persistenceTier,
    volumeMarker: persistenceResult.volumeMarker,
  };
}

async function main(): Promise<void> {
  const config = validateCloudStartupConfig(process.env);
  let isShuttingDown = false;

  console.log("================================================================");
  console.log("PriceRadar Cloud Service — Entrypoint (P5 Milestone 1)");
  console.log(`Port           : ${config.port}`);
  console.log(`Host           : ${config.host}`);
  console.log(`SQLite Path    : ${config.sqlitePath}`);
  console.log(`Scan Interval  : ${String(config.intervalMinutes)} minutes`);
  console.log(`Persistence    : ${config.persistenceTier}`);
  if (config.volumeMarker) {
    console.log(`Volume ID      : ${config.volumeMarker.volumeId}`);
  }
  console.log(
    `Web Auth       : ${config.webPassword ? "Enabled (Basic Auth)" : "Disabled (Loopback Only)"}`,
  );
  console.log("================================================================");

  // 1. Initialize and start Cloud Scheduler
  const scheduler = new CloudScheduler({
    dbPath: config.sqlitePath,
    intervalMinutes: config.intervalMinutes,
    scanOnStartup: process.env.PRICERADAR_SCAN_ON_STARTUP !== "false",
    logger: (msg: string) => console.log(`[Scheduler] ${msg}`),
  });

  await scheduler.start();

  // 2. Launch Next.js Dashboard Server
  console.log(
    `[Web] Starting Next.js dashboard server on ${config.host}:${config.port}...`,
  );
  const nextBin = path.resolve(webDir, "node_modules", ".bin", "next");

  const webProcess = spawn(nextBin, ["start", "-p", config.port, "-H", config.host], {
    cwd: webDir,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: config.port,
      HOST: config.host,
      PRICERADAR_SQLITE_PATH: config.sqlitePath,
    },
  });

  webProcess.on("error", (err) => {
    console.error(`[Web] Next.js process failed to start: ${err.message}`);
    scheduler.stop();
    process.exit(1);
  });

  // F7-06: Distinguish graceful shutdown from unexpected crash (exit nonzero)
  webProcess.on("exit", (code, signal) => {
    console.log(
      `[Web] Next.js server exited with code ${String(code)} / signal ${String(signal)}.`,
    );
    scheduler.stop();
    if (!isShuttingDown) {
      console.error(
        "[Web] Unexpected Next.js server exit. Terminating supervisor with nonzero exit code.",
      );
      const exitCode = code !== null && code !== 0 ? code : 1;
      process.exit(exitCode);
    }
    process.exit(code ?? 0);
  });

  // 3. Graceful termination handler
  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[CloudEntrypoint] Received ${signal}. Shutting down gracefully...`);
    scheduler.stop();
    if (!webProcess.killed) {
      webProcess.kill("SIGTERM");
    }
    setTimeout(() => {
      console.log("[CloudEntrypoint] Forcing exit after timeout.");
      process.exit(0);
    }, 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(
      `[CloudEntrypoint] Fatal startup error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
