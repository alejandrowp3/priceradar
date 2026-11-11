import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_LOOPBACK_HOSTS = new Set([
  "127.0.0.1:4178",
  "localhost:4178",
  "127.0.0.1",
  "localhost",
]);

/**
 * Detects whether the current environment is a cloud or production deployment (`F7-07`).
 * In cloud or production environments, client-provided Host headers are untrusted and
 * authentication is strictly mandatory.
 */
export function isCloudMode(): boolean {
  return (
    process.env.PRICERADAR_ENV === "cloud" ||
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT_ID) ||
    Boolean(process.env.RAILWAY_SERVICE_ID) ||
    Boolean(process.env.RAILWAY_VOLUME_NAME) ||
    Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH) ||
    Boolean(process.env.RAILWAY_STATIC_URL) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.FLY_APP_NAME)
  );
}

/**
 * Checks whether the server process is genuinely bound exclusively to local loopback (`F7-07`).
 * If bound to 0.0.0.0 or running in cloud/production, it is externally reachable and NOT loopback-only.
 */
export function isGenuinelyLoopbackBoundServer(): boolean {
  if (isCloudMode()) {
    return false;
  }
  const host = (process.env.HOST ?? "").trim().toLowerCase();
  if (host === "0.0.0.0" || host === "::") {
    return false;
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "";
}

/**
 * Checks whether a host string matches a standard local loopback identifier.
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
 * Validates Host header against allowed domains to neutralize DNS rebinding attacks (`F7-07`).
 * In cloud mode, client-provided loopback hostnames are untrusted unless explicitly allowed.
 */
export function isHostAllowed(
  host: string,
  customAllowedHosts?: string,
  options?: { isCloud?: boolean },
): boolean {
  if (!host) return false;
  const isCloud = options?.isCloud ?? isCloudMode();

  // In trusted local development, loopback hosts are permitted by default
  if (!isCloud && isLoopbackHost(host)) {
    return true;
  }

  const rawConfig = customAllowedHosts ?? process.env.PRICERADAR_ALLOWED_HOSTS ?? "";
  const patterns = rawConfig
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const hostname = host.split(":")[0]?.trim().toLowerCase() ?? "";
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
 * Validates HTTP Basic Authentication credentials against configured secret.
 */
function validateBasicAuth(request: NextRequest, secret: string): boolean {
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
 * Checks HTTP Basic Authentication with fail-closed semantics (`F7-01`, `F7-07`):
 * - Cloud / production requests ALWAYS require valid credentials, regardless of client Host header.
 * - Client-provided "Host: 127.0.0.1" or "Host: localhost" NEVER establishes loopback trust in cloud mode.
 * - Missing or empty PRICERADAR_WEB_PASSWORD in cloud mode rejects all requests (fail-closed).
 * - Passwordless access is strictly limited to genuinely loopback-bound servers in local development.
 */
export function isAuthorized(
  request: NextRequest,
  expectedPassword?: string,
  options?: { isCloud?: boolean; isLoopbackBound?: boolean },
): boolean {
  const secret = (expectedPassword ?? process.env.PRICERADAR_WEB_PASSWORD)?.trim();
  const host = request.headers.get("host") ?? "";
  const isCloud = options?.isCloud ?? isCloudMode();
  const isLoopbackBound = options?.isLoopbackBound ?? isGenuinelyLoopbackBoundServer();

  // F7-07: In cloud / production mode, client Host header is untrusted.
  // All requests require authentication without exception.
  if (isCloud) {
    if (!secret || secret === "") {
      // Fail-closed: missing password in cloud rejects all requests
      return false;
    }
    return validateBasicAuth(request, secret);
  }

  // If a password is configured in local mode, it must be validated
  if (secret && secret !== "") {
    return validateBasicAuth(request, secret);
  }

  // Passwordless access allowed ONLY if server is genuinely bound to loopback AND host is loopback
  if (isLoopbackBound && isLoopbackHost(host)) {
    return true;
  }

  // Fail-closed: any external / non-loopback binding without password is unauthorized
  return false;
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
