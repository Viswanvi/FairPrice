import { randomUUID } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (Phase 13): seller flows, buyer page rendering, benchmark. No AI calls and no
 * PayPal logins — data is seeded straight into the database by tests/e2e/global-setup.ts and
 * removed by global-teardown.ts. PayPal approval stays a manual test (npm run e2e:sandbox).
 *
 * The app runs on its own port and build folder with a random seller password that exists only
 * in this test server's process (your .env is not touched or required to contain one).
 */
process.env.E2E_SELLER_PASSWORD ??= `e2e-${randomUUID()}`;
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /buyer\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      SELLER_DEMO_PASSWORD: process.env.E2E_SELLER_PASSWORD,
      DEMO_GEO_OVERRIDE: "true",
      APP_BASE_URL: baseURL,
    },
  },
});
