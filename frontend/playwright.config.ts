import { defineConfig, devices } from 'playwright/test';

const installedWheel = process.env.COURSEWEAVE_INSTALLED_WHEEL === '1';
const installedAdapter = process.env.COURSEWEAVE_INSTALLED_ADAPTER === '1';
const installedRun = installedWheel || installedAdapter;

if (installedWheel && installedAdapter) {
  throw new Error('Select exactly one installed CourseWeave browser suite.');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: installedWheel ? 'installed-wheel-lab.spec.ts' : installedAdapter ? 'agent-harness-path.spec.ts' : undefined,
  testIgnore: installedRun ? undefined : ['installed-wheel-lab.spec.ts', 'agent-harness-path.spec.ts'],
  outputDir: installedWheel ? './test-results/installed-wheel' : installedAdapter ? './test-results/installed-adapter' : './test-results',
  reporter: 'list',
  workers: installedRun ? 1 : undefined,
  fullyParallel: !installedRun,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    actionTimeout: installedRun ? 10_000 : 0,
    trace: installedRun ? 'off' : 'retain-on-failure',
    screenshot: installedRun ? 'off' : 'only-on-failure',
    video: 'off'
  },
  webServer: installedRun ? undefined : {
    command: 'pnpm --filter @courseweave/learn exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
