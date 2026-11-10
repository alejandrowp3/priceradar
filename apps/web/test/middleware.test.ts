import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

describe("Web Dashboard Middleware Security", () => {
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
