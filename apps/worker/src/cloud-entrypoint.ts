import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudScheduler } from "./cloud-scheduler.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "../../..");
const webDir = path.resolve(workspaceRoot, "apps", "web");

async function main(): Promise<void> {
  const port = process.env.PORT ?? "4178";
  const host = process.env.HOST ?? "0.0.0.0";
  const sqlitePath = process.env.PRICERADAR_SQLITE_PATH ?? "/data/private-history.sqlite";
  const intervalMinutes = Number(
    process.env.PRICERADAR_SCHEDULE_INTERVAL_MINUTES ?? "60",
  );

  console.log("================================================================");
  console.log("PriceRadar Cloud Service — Entrypoint (P5 Milestone 1)");
  console.log(`Port           : ${port}`);
  console.log(`Host           : ${host}`);
  console.log(`SQLite Path    : ${sqlitePath}`);
  console.log(`Scan Interval  : ${String(intervalMinutes)} minutes`);
  console.log(
    `Web Auth       : ${process.env.PRICERADAR_WEB_PASSWORD ? "Enabled (Basic Auth)" : "Disabled (Loopback / Open)"}`,
  );
  console.log("================================================================");

  // 1. Initialize and start Cloud Scheduler
  const scheduler = new CloudScheduler({
    dbPath: sqlitePath,
    intervalMinutes,
    scanOnStartup: process.env.PRICERADAR_SCAN_ON_STARTUP !== "false",
    logger: (msg: string) => console.log(`[Scheduler] ${msg}`),
  });

  await scheduler.start();

  // 2. Launch Next.js Dashboard Server
  console.log(`[Web] Starting Next.js dashboard server on ${host}:${port}...`);
  const nextBin = path.resolve(webDir, "node_modules", ".bin", "next");

  const webProcess = spawn(nextBin, ["start", "-p", port, "-H", host], {
    cwd: webDir,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: port,
      HOST: host,
      PRICERADAR_SQLITE_PATH: sqlitePath,
    },
  });

  webProcess.on("error", (err) => {
    console.error(`[Web] Next.js process failed to start: ${err.message}`);
    scheduler.stop();
    process.exit(1);
  });

  webProcess.on("exit", (code, signal) => {
    console.log(
      `[Web] Next.js server exited with code ${String(code)} / signal ${String(signal)}.`,
    );
    scheduler.stop();
    process.exit(code ?? 0);
  });

  // 3. Graceful termination handler
  const shutdown = (signal: string) => {
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

main().catch((err: unknown) => {
  console.error(
    `[CloudEntrypoint] Fatal startup error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
