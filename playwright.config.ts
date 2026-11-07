import { defineConfig, devices } from "@playwright/test";

export const PRICERADAR_E2E_BASE_URL = "http://127.0.0.1:4178";

/**
 * Playwright configuration enforcing PriceRadar's strict port policy:
 * - Connects strictly to http://127.0.0.1:4178
 * - Never reuses an arbitrary existing process (`reuseExistingServer: false`)
 * - Fails explicitly if port 4178 is already occupied
 */
export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: PRICERADAR_E2E_BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "node scripts/check-port.mjs && pnpm --filter @priceradar/web start",
    url: PRICERADAR_E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
