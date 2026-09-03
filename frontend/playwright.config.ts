import { defineConfig, devices } from 'playwright/test';

const installedWheel = process.env.COURSEWEAVE_INSTALLED_WHEEL === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: installedWheel ? 'installed-wheel-lab.spec.ts' : undefined,
  testIgnore: installedWheel ? undefined : 'installed-wheel-lab.spec.ts',
  outputDir: installedWheel ? './test-results/installed-wheel' : './test-results',
  reporter: 'list',
  workers: installedWheel ? 1 : undefined,
  fullyParallel: !installedWheel,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: installedWheel ? 'off' : 'retain-on-failure',
    screenshot: installedWheel ? 'off' : 'only-on-failure',
    video: 'off'
  },
  webServer: installedWheel ? undefined : {
    command: 'pnpm --filter @courseweave/learn exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
