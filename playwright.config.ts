import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:4321", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run build && npx wrangler dev --config dist/server/wrangler.json --port 4321 --ip 127.0.0.1 --local",
    url: "http://127.0.0.1:4321/editor",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
