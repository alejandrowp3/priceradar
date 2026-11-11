import { NextResponse } from "next/server";
import { getReadOnlyDatabase } from "../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Public readiness probe endpoint (`F7-02`):
 * - Returns only minimal fields ({ status: "healthy", ready: true }).
 * - Exposes zero absolute filesystem paths, session data, or operational history.
 * - Returns HTTP 503 if required dependencies are genuinely broken or unreadable.
 * - Compatible with cloud platform healthcheck probes (Railway, Render).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { repo, dbExists } = getReadOnlyDatabase();

    // If database exists on disk, verify read capability
    if (dbExists && repo) {
      // Simple lightweight query to verify SQLite integrity
      repo.getDashboardSummary();
    }

    return NextResponse.json(
      {
        status: "healthy",
        ready: true,
      },
      {
        status: 200,
        headers: {
          "cache-control": "no-store, max-age=0",
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "unhealthy",
        ready: false,
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store, max-age=0",
        },
      },
    );
  }
}
