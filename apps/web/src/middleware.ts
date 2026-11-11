import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_LOOPBACK_HOSTS = new Set([
  "127.0.0.1:4178",
  "localhost:4178",
  "127.0.0.1",
  "localhost",
]);

/**
 * Checks whether a host string represents a verified local loopback interface.
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0]?.trim().toLowerCase() ?? "";
  return (
    ALLOWED_LOOPBACK_HOSTS.has(host) ||
    hostname === "127.0.0.1" ||
    hostname === "localhost"
  );
}

/**
 * Validates Host header against local loopback bindings and configured cloud hostnames
 * to neutralize DNS rebinding attacks while supporting secure cloud deployments.
 */
export function isHostAllowed(host: string, customAllowedHosts?: string): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0]?.trim().toLowerCase() ?? "";
  if (isLoopbackHost(host)) {
    return true;
  }

  const rawConfig = customAllowedHosts ?? process.env.PRICERADAR_ALLOWED_HOSTS ?? "";
  const patterns = rawConfig
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const lowerHostname = hostname.toLowerCase();
  const lowerHost = host.toLowerCase();

  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // e.g. ".railway.app"
      if (lowerHostname.endsWith(suffix) || `.${lowerHostname}` === suffix) {
        return true;
      }
    } else if (lowerHostname === pattern || lowerHost === pattern) {
      return true;
    }
  }

  const railwayUrl = process.env.RAILWAY_STATIC_URL?.toLowerCase();
  if (railwayUrl && (lowerHostname === railwayUrl || lowerHost === railwayUrl)) {
    return true;
  }
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME?.toLowerCase();
  if (renderHost && (lowerHostname === renderHost || lowerHost === renderHost)) {
    return true;
  }

  return false;
}

/**
 * Checks HTTP Basic Authentication with fail-closed semantics (`F7-01`):
 * - Remote (non-loopback) access with missing or empty password MUST fail closed.
 * - Passwordless access is strictly forbidden outside verified loopback binding.
 */
export function isAuthorized(request: NextRequest, expectedPassword?: string): boolean {
  const host = request.headers.get("host") ?? "";
  const isLoopback = isLoopbackHost(host);
  const secret = (expectedPassword ?? process.env.PRICERADAR_WEB_PASSWORD)?.trim();

  // Local loopback binding without password configured is permitted for local development only
  if (isLoopback && (!secret || secret === "")) {
    return true;
  }

  // Fail-closed: non-loopback (remote/cloud) access with missing or empty password is NEVER authorized
  if (!secret || secret === "") {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }

  try {
    const base64 = authHeader.slice(6).trim();
    const decoded = atob(base64);
    const colonIndex = decoded.indexOf(":");
    const password = colonIndex !== -1 ? decoded.slice(colonIndex + 1) : decoded;
    return password === secret;
  } catch {
    return false;
  }
}

/**
 * Enforces local and cloud trust boundary protections:
 * - Validates Host header against loopback and allowed cloud domains (DNS rebinding protection).
 * - Rejects unauthorized cross-site requests via Sec-Fetch-Site.
 * - Protects remote access via HTTP Basic Auth when PRICERADAR_WEB_PASSWORD is set.
 * - Permits unauthenticated health checks at /api/health for platform orchestrators.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Unauthenticated health checks are permitted for container orchestrator probes
  if (pathname === "/api/health") {
    const response = NextResponse.next();
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  }

  const host = request.headers.get("host") ?? "";
  if (!isHostAllowed(host)) {
    return new NextResponse(
      JSON.stringify({
        error: "Acceso prohibido: Host no autorizado para PriceRadar.",
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

  if (!isAuthorized(request)) {
    return new NextResponse(
      JSON.stringify({
        error: "Autenticación requerida. Ingrese sus credenciales de PriceRadar.",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "WWW-Authenticate":
            'Basic realm="PriceRadar Private Dashboard", charset="UTF-8"',
        },
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
