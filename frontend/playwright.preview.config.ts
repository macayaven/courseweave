import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: ['author-student-roundtrip.spec.ts', 'author-recovery.spec.ts'],
  outputDir: process.env.COURSEWEAVE_AUTHOR_PREVIEW_WORKROOT ? `${process.env.COURSEWEAVE_AUTHOR_PREVIEW_WORKROOT}/playwright` : './test-results/author-preview',
  workers: 1, reporter: 'list', timeout: 300_000,
  use: { trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 15_000, navigationTimeout: 30_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
