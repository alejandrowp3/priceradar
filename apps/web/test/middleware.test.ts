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

  describe("F7-07: Host-Header-Based Loopback Authentication Exception Protection", () => {
    it("F7-07: rejects forged Host: 127.0.0.1:4178 in cloud mode when unauthenticated", () => {
      process.env.PRICERADAR_ENV = "cloud";
      process.env.PRICERADAR_WEB_PASSWORD = "cloud-password-xyz";
      process.env.PRICERADAR_ALLOWED_HOSTS = "127.0.0.1:4178,priceradar.up.railway.app";

      // Attacker attempts to forge Host: 127.0.0.1:4178 to bypass auth
      const forgedReq = new NextRequest("http://127.0.0.1:4178/", {
        headers: {
          host: "127.0.0.1:4178",
        },
      });
      const res = middleware(forgedReq);
      // In cloud mode, forged Host: 127.0.0.1 MUST NOT establish loopback trust!
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Basic");
    });

    it("F7-07: rejects forged Host: localhost:4178 in cloud mode when unauthenticated", () => {
      process.env.PRICERADAR_ENV = "cloud";
      process.env.PRICERADAR_WEB_PASSWORD = "cloud-password-xyz";
      process.env.PRICERADAR_ALLOWED_HOSTS = "localhost:4178,priceradar.up.railway.app";

      const forgedReq = new NextRequest("http://localhost:4178/products", {
        headers: {
          host: "localhost:4178",
        },
      });
      const res = middleware(forgedReq);
      expect(res.status).toBe(401);
    });

    it("F7-07: fails closed in cloud mode even if PRICERADAR_WEB_PASSWORD is missing and Host is loopback", () => {
      process.env.PRICERADAR_ENV = "cloud";
      delete process.env.PRICERADAR_WEB_PASSWORD;
      process.env.PRICERADAR_ALLOWED_HOSTS = "127.0.0.1:4178";

      const forgedReq = new NextRequest("http://127.0.0.1:4178/opportunities", {
        headers: {
          host: "127.0.0.1:4178",
        },
      });
      const res = middleware(forgedReq);
      expect(res.status).toBe(401);
    });

    it("F7-07: fails closed when Next.js is started directly in production (NODE_ENV=production) without password", () => {
      process.env.NODE_ENV = "production";
      delete process.env.PRICERADAR_ENV;
      delete process.env.PRICERADAR_WEB_PASSWORD;
      process.env.PRICERADAR_ALLOWED_HOSTS = "127.0.0.1:4178";

      // Direct Next.js production server startup without cloud-entrypoint
      const req = new NextRequest("http://127.0.0.1:4178/", {
        headers: {
          host: "127.0.0.1:4178",
        },
      });
      const res = middleware(req);
      expect(res.status).toBe(401);
    });

    it("F7-07: fails closed when server is bound to 0.0.0.0 without password even in dev mode", () => {
      process.env.NODE_ENV = "development";
      delete process.env.PRICERADAR_ENV;
      delete process.env.PRICERADAR_WEB_PASSWORD;
      process.env.HOST = "0.0.0.0"; // Externally reachable server binding

      const req = new NextRequest("http://127.0.0.1:4178/", {
        headers: {
          host: "127.0.0.1:4178",
        },
      });
      const res = middleware(req);
      expect(res.status).toBe(401);
    });

    it("F7-07: allows passwordless access ONLY on a genuinely loopback-bound server in local dev", () => {
      process.env.NODE_ENV = "development";
      delete process.env.PRICERADAR_ENV;
      delete process.env.PRICERADAR_WEB_PASSWORD;
      process.env.HOST = "127.0.0.1"; // Genuinely bound to loopback

      const req = new NextRequest("http://127.0.0.1:4178/", {
        headers: {
          host: "127.0.0.1:4178",
        },
      });
      const res = middleware(req);
      expect(res.status).toBe(200);
    });
  });
});
