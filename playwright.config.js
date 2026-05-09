import { defineConfig } from '@playwright/test';

// GitHub Actions sets GITHUB_ACTIONS; some runners omit CI for child processes.
const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);

export default defineConfig({
  testDir: 'extension/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Linux CI runners are slower; parallel extension launches can flake.
  // Extension + persistent profile: avoid parallel Chromium on shared runners.
  workers: isCI ? 1 : undefined,
  fullyParallel: !isCI,
  retries: isCI ? 2 : 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
  },
});

