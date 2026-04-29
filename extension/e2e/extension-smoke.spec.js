import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';

function extensionPath() {
  return path.join(process.cwd(), 'extension');
}

test('loads extension and opens a normal page', async () => {
  // Chromium extensions require a persistent context.
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath()}`,
      `--load-extension=${extensionPath()}`,
    ],
  });

  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/Example Domain/);

  // If the extension failed to load, Chromium usually logs errors; smoke test just ensures launch succeeds.
  await context.close();
});

