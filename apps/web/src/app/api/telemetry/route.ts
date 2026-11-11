import { NextResponse } from "next/server";
import {
  getReadOnlyDatabase,
  fetchSchedulerStatus,
  fetchRecentScanRuns,
  checkStorageReadiness,
  checkSystemReadiness,
} from "../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Authenticated private operational telemetry endpoint (`F7-02`):
 * - Protected by middleware authentication (requires PRICERADAR_WEB_PASSWORD).
 * - Exposes detailed operational and scheduler metrics for authorized administrators.
 */
export async function GET(): Promise<NextResponse> {
  const { dbExists, repo } = getReadOnlyDatabase();
  const schedulerStatus = fetchSchedulerStatus();
  const storageReadiness = checkStorageReadiness();
  const systemReadiness = checkSystemReadiness();
  const { runs } = fetchRecentScanRuns(5);
  const summary = repo && dbExists ? repo.getDashboardSummary() : null;

  const payload = {
    service: "priceradar-cloud",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      connected: dbExists,
      storageReadiness,
      counts: summary?.counts ?? null,
    },
    storageReadiness,
    systemReadiness,
    scheduler: schedulerStatus,
    summary,
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
