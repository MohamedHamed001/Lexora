import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import http from 'node:http';

function extensionPath() {
  return path.join(process.cwd(), 'extension');
}

test('loads extension and opens a normal page', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Lexora Smoke Fixture</title><main><p>Local smoke fixture.</p></main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // Chromium extensions require a persistent context.
  const context = await chromium.launchPersistentContext('', {
    args: [
      `--disable-extensions-except=${extensionPath()}`,
      `--load-extension=${extensionPath()}`,
    ],
  });

  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/Lexora Smoke Fixture/);
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }

  // If the extension failed to load, Chromium usually logs errors; smoke test just ensures launch succeeds.
});
