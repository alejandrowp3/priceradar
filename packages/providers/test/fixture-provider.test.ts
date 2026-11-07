import { describe, expect, it } from "vitest";
import { FixtureCatalogProvider, FIXTURE_PROVIDER_ID } from "../src/index.ts";

describe("FixtureCatalogProvider (SC-005)", () => {
  it("reports accurate provider capabilities with isSimulatedFixture=true", () => {
    const provider = new FixtureCatalogProvider();
    const caps = provider.getCapabilities();

    expect(provider.id).toBe(FIXTURE_PROVIDER_ID);
    expect(caps.supportsCatalogExploration).toBe(true);
    expect(caps.supportsPagination).toBe(true);
    expect(caps.supportsProductVariants).toBe(true);
    expect(caps.isSimulatedFixture).toBe(true);
  });

  it("discovers products automatically from category/store targets without specifying product IDs", async () => {
    const provider = new FixtureCatalogProvider();
    const targets = provider.getDefaultTargets();
    expect(targets.length).toBeGreaterThanOrEqual(3);

    const firstTarget = targets[0];
    expect(firstTarget).toBeDefined();
    if (!firstTarget) {
      return;
    }

    const result = await provider.discover(firstTarget, {
      nowIso: "2026-11-07T12:00:00.000Z",
    });

    expect(result.providerId).toBe(FIXTURE_PROVIDER_ID);
    expect(result.listings.length).toBeGreaterThan(0);

    for (const listing of result.listings) {
      expect(Number.isSafeInteger(listing.observedPriceCop)).toBe(true);
      expect(listing.provenance).toBe("DEMO_FIXTURE");
      expect(listing.geographicContext.countryCode).toBe("CO");
    }
  });

  it("supports deterministic pagination with cursors", async () => {
    const provider = new FixtureCatalogProvider();
    const target = provider.getDefaultTargets()[0];
    if (!target) {
      throw new Error("Expected default target");
    }

    const page1 = await provider.discover(target, { pageSize: 2 });
    expect(page1.listings).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe("2");

    const page2 = await provider.discover(target, {
      pageSize: 2,
      ...(page1.nextCursor !== undefined ? { cursor: page1.nextCursor } : {}),
    });
    expect(page2.listings).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
  });
});
