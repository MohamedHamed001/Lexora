import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'extension/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
  },
});

