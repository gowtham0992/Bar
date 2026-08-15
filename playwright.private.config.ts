import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/private-e2e",
  outputDir: "./test-results/private",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8790",
    browserName: "chromium",
    channel: "chrome",
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "private-desktop-chrome",
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "private-mobile-chrome",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command:
      "npx wrangler dev --local --config wrangler.private.example.jsonc --port 8790",
    url: "http://127.0.0.1:8790/private.css",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
