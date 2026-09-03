import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "author-studio.spec.ts",
  outputDir: "./test-results-author",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "pnpm --filter @courseweave/author exec vite preview --host 127.0.0.1 --port 4174 --strictPort",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
