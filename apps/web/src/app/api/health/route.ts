import { NextResponse } from "next/server";
import { getReadOnlyDatabase, fetchSchedulerStatus } from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const { dbExists, dbPath } = getReadOnlyDatabase();
  const schedulerStatus = fetchSchedulerStatus();

  const payload = {
    status: "healthy",
    service: "priceradar-cloud",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      connected: dbExists,
      path: dbPath,
    },
    scheduler: {
      active: schedulerStatus?.isRunning ?? false,
      intervalMinutes: schedulerStatus?.intervalMinutes ?? 60,
      totalScansExecuted: schedulerStatus?.totalScansExecuted ?? 0,
      lastScanStartedAt: schedulerStatus?.lastScanStartedAt ?? null,
      lastScanCompletedAt: schedulerStatus?.lastScanCompletedAt ?? null,
      lastScanStatus: schedulerStatus?.lastScanStatus ?? null,
      nextScheduledScanAt: schedulerStatus?.nextScheduledScanAt ?? null,
    },
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
    },
  });
}
