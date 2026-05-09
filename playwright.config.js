import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: 'extension/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Linux CI runners are slower; parallel extension launches can flake.
  workers: isCI ? 1 : undefined,
  retries: isCI ? 2 : 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
  },
});

