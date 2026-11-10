import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_HOSTS = new Set([
  "127.0.0.1:4178",
  "localhost:4178",
  "127.0.0.1",
  "localhost",
]);

/**
 * Enforces local trust boundary protections (`Section 7`):
 * - Validates Host header against local loopback bindings to neutralize DNS rebinding attacks.
 * - Rejects unauthorized cross-site requests via Sec-Fetch-Site.
 */
export function middleware(request: NextRequest): NextResponse {
  const host = request.headers.get("host") ?? "";
  if (!ALLOWED_HOSTS.has(host)) {
    return new NextResponse(
      JSON.stringify({
        error: "Acceso prohibido: PriceRadar es una aplicación exclusivamente local.",
      }),
      {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return new NextResponse(
      JSON.stringify({
        error: "Acceso prohibido: Petición cross-site no autorizada.",
      }),
      {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const response = NextResponse.next();
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
