import { NextResponse } from "next/server";
import {
  getReadOnlyDatabase,
  fetchSchedulerStatus,
  fetchRecentScanRuns,
} from "../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Authenticated private operational telemetry endpoint (`F7-02`):
 * - Protected by middleware authentication (requires PRICERADAR_WEB_PASSWORD).
 * - Exposes detailed operational and scheduler metrics for authorized administrators.
 */
export async function GET(): Promise<NextResponse> {
  const { dbExists } = getReadOnlyDatabase();
  const schedulerStatus = fetchSchedulerStatus();
  const { runs } = fetchRecentScanRuns(5);

  const payload = {
    service: "priceradar-cloud",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      connected: dbExists,
    },
    scheduler: schedulerStatus,
    recentExecutionsCount: runs.length,
    latestExecution: runs[0] ?? null,
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
    },
  });
}
