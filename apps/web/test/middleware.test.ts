import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

describe("Web Dashboard Middleware Security (Local & Cloud Trust Boundary)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows requests with Host 127.0.0.1:4178", () => {
    const req = new NextRequest("http://127.0.0.1:4178/", {
      headers: {
        host: "127.0.0.1:4178",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(200);
  });

  it("allows requests with Host localhost:4178", () => {
    const req = new NextRequest("http://localhost:4178/products", {
      headers: {
        host: "localhost:4178",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(200);
  });

  it("blocks requests with unauthorized external Host headers (DNS rebinding protection)", () => {
    const req = new NextRequest("http://attacker.com/products", {
      headers: {
        host: "attacker.com",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(403);
  });

  it("allows configured cloud domain via PRICERADAR_ALLOWED_HOSTS when authenticated", () => {
    process.env.PRICERADAR_ALLOWED_HOSTS = "priceradar.up.railway.app,*.railway.app";
    process.env.PRICERADAR_WEB_PASSWORD = "test-cloud-pass";

    const authHeader = `Basic ${btoa("admin:test-cloud-pass")}`;

    const req = new NextRequest("https://priceradar.up.railway.app/products", {
      headers: {
        host: "priceradar.up.railway.app",
        authorization: authHeader,
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(200);

    const subReq = new NextRequest("https://my-feature-pr.railway.app/coverage", {
      headers: {
        host: "my-feature-pr.railway.app",
        authorization: authHeader,
      },
    });
    const subRes = middleware(subReq);
    expect(subRes.status).toBe(200);
  });

  it("allows unauthenticated /api/health probes even from external callers", () => {
    process.env.PRICERADAR_WEB_PASSWORD = "super-secret-password";

    const req = new NextRequest("https://orchestrator.internal/api/health", {
      headers: {
        host: "orchestrator.internal",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(200);
  });

  it("enforces HTTP Basic Auth when PRICERADAR_WEB_PASSWORD is configured", () => {
    process.env.PRICERADAR_WEB_PASSWORD = "cloud-pass-2026";
    process.env.PRICERADAR_ALLOWED_HOSTS = "priceradar.cloud";

    // 1. Missing credentials -> 401 with WWW-Authenticate
    const unauthReq = new NextRequest("https://priceradar.cloud/products", {
      headers: {
        host: "priceradar.cloud",
      },
    });
    const unauthRes = middleware(unauthReq);
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.headers.get("www-authenticate")).toContain("Basic");

    // 2. Wrong password -> 401
    const badCreds = btoa("admin:wrong-password");
    const badReq = new NextRequest("https://priceradar.cloud/products", {
      headers: {
        host: "priceradar.cloud",
        authorization: `Basic ${badCreds}`,
      },
    });
    const badRes = middleware(badReq);
    expect(badRes.status).toBe(401);

    // 3. Valid password -> 200
    const goodCreds = btoa("admin:cloud-pass-2026");
    const goodReq = new NextRequest("https://priceradar.cloud/products", {
      headers: {
        host: "priceradar.cloud",
        authorization: `Basic ${goodCreds}`,
      },
    });
    const goodRes = middleware(goodReq);
    expect(goodRes.status).toBe(200);
  });

  it("blocks cross-site fetch requests (Sec-Fetch-Site: cross-site)", () => {
    const req = new NextRequest("http://127.0.0.1:4178/products", {
      headers: {
        host: "127.0.0.1:4178",
        "sec-fetch-site": "cross-site",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(403);
  });

  it("fails closed on remote/cloud requests when PRICERADAR_WEB_PASSWORD is missing", () => {
    delete process.env.PRICERADAR_WEB_PASSWORD;
    process.env.PRICERADAR_ALLOWED_HOSTS = "priceradar.up.railway.app";

    const req = new NextRequest("https://priceradar.up.railway.app/products", {
      headers: {
        host: "priceradar.up.railway.app",
      },
    });
    const res = middleware(req);
    // Must FAIL CLOSED (401), never allow unauthenticated remote access
    expect(res.status).toBe(401);
  });

  it("fails closed on remote/cloud requests when PRICERADAR_WEB_PASSWORD is empty or whitespace", () => {
    process.env.PRICERADAR_WEB_PASSWORD = "   ";
    process.env.PRICERADAR_ALLOWED_HOSTS = "priceradar.up.railway.app";

    const req = new NextRequest("https://priceradar.up.railway.app/coverage", {
      headers: {
        host: "priceradar.up.railway.app",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(401);
  });

  it("requires authentication on loopback if PRICERADAR_WEB_PASSWORD is set", () => {
    process.env.PRICERADAR_WEB_PASSWORD = "loopback-guard";

    // 1. Missing credentials on loopback -> 401
    const unauthReq = new NextRequest("http://127.0.0.1:4178/", {
      headers: {
        host: "127.0.0.1:4178",
      },
    });
    expect(middleware(unauthReq).status).toBe(401);

    // 2. Valid credentials on loopback -> 200
    const authReq = new NextRequest("http://127.0.0.1:4178/", {
      headers: {
        host: "127.0.0.1:4178",
        authorization: `Basic ${btoa("owner:loopback-guard")}`,
      },
    });
    expect(middleware(authReq).status).toBe(200);
  });

  it("rejects hostile Host headers attempting substring or suffix spoofing", () => {
    process.env.PRICERADAR_ALLOWED_HOSTS = "priceradar.up.railway.app,*.railway.app";

    const hostileHosts = [
      "priceradar.up.railway.app.evil.com",
      "attacker-railway.app",
      "notrailway.app",
      "evil.com",
      "127.0.0.1.attacker.com",
      "localhost.evil.com:4178",
    ];

    for (const hostileHost of hostileHosts) {
      const req = new NextRequest(`https://${hostileHost}/products`, {
        headers: { host: hostileHost },
      });
      const res = middleware(req);
      expect(res.status).toBe(403);
    }
  });

  it("allows same-origin or none Sec-Fetch-Site", () => {
    const req = new NextRequest("http://127.0.0.1:4178/opportunities", {
      headers: {
        host: "127.0.0.1:4178",
        "sec-fetch-site": "same-origin",
      },
    });
    const res = middleware(req);
    expect(res.status).toBe(200);
  });
});
