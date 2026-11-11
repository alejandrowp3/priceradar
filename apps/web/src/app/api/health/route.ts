import { NextResponse } from "next/server";
import { checkSystemReadiness } from "../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Public readiness probe endpoint (`F7-02`, `F7-08`):
 * - Returns only minimal fields ({ status: "healthy", ready: true }).
 * - Exposes zero absolute filesystem paths, session data, or operational history.
 * - Returns HTTP 503 if persistent storage is missing, unmounted, read-only, or corrupted.
 * - Returns HTTP 503 if scheduler heartbeat is stale in cloud mode.
 * - Distinguishes legitimate first-time deployment initialization (returns 200).
 * - Compatible with cloud platform healthcheck probes (Railway, Render).
 */
export async function GET(): Promise<NextResponse> {
  const readiness = checkSystemReadiness();

  if (!readiness.ready) {
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
}
