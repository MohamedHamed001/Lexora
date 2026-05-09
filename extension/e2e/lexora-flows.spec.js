import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import http from 'node:http';
import { launchChromiumWithExtension } from './chromium-extension-context.js';

function extensionPath() {
  return path.join(process.cwd(), 'extension');
}

async function buildE2eExtensionDir() {
  const base = extensionPath();
  const outDir = path.join(os.tmpdir(), `lexora-e2e-extension-${Date.now()}`);
  await fs.cp(base, outDir, { recursive: true });

  const manifestPath = path.join(outDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);

  manifest.permissions = Array.from(
    new Set([...(manifest.permissions || []), 'webNavigation'])
  );
  manifest.host_permissions = ['http://127.0.0.1/*'];

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return outDir;
}

async function startFixtureServer() {
  // Must exceed LexoraCaptureExtractor.LIMITS.HTML_READY_CHARS (800) so extractPageContent is non-null.
  const fillerParagraphs = Array.from(
    { length: 12 },
    (_, i) =>
      `<p>Fixture paragraph ${i} adds readable text so deep capture crosses the HTML readiness threshold without external network access.</p>`
  ).join('\n');
  const articleHtml = `
    <!doctype html>
    <html>
      <head><title>Lexora Fixture Lesson - Test</title></head>
      <body>
        <main>
          <article>
            <h1>Lexora Fixture Lesson</h1>
            <p>Example Domain selected reading content appears here for the selection workflow.</p>
            <p>This deterministic article has enough readable text for deep capture to extract a useful lesson.</p>
            ${fillerParagraphs}
          </article>
        </main>
      </body>
    </html>
  `;

  const server = http.createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(articleHtml);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function launchExtensionContext(extDir) {
  return launchChromiumWithExtension(extDir);
}

async function getExtensionOrigin(context) {
  const deadline = Date.now() + (process.env.CI ? 45_000 : 15_000);
  while (Date.now() < deadline) {
    const sw = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
    if (sw) {
      const u = new URL(sw.url());
      return `${u.protocol}//${u.host}`;
    }
    await Promise.race([
      context.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }
  throw new Error('Extension service worker did not start.');
}

async function openSidepanelPage(context) {
  const origin = await getExtensionOrigin(context);
  const sidepanel = await context.newPage();
  await sidepanel.goto(`${origin}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await expect(sidepanel.locator('#capture-btn')).toBeVisible();
  return sidepanel;
}

test('deep capture updates sidepanel lesson title', async () => {
  const fixture = await startFixtureServer();
  const extDir = await buildE2eExtensionDir();
  const context = await launchExtensionContext(extDir);

  try {
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/article`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    const sidepanel = await openSidepanelPage(context);
    const tabId = await sidepanel.evaluate(async (url) => {
      const api = globalThis.chrome || globalThis.browser;
      const tabs = await api.tabs.query({ url });
      return tabs[0]?.id || null;
    }, `${fixture.origin}/article`);
    expect(tabId).toBeTruthy();

    const resp = await sidepanel.evaluate(async (tabId) => {
      const api = globalThis.chrome || globalThis.browser;
      return new Promise((resolve) => {
        api.runtime.sendMessage({ action: 'triggerDeepCapture', tabId }, (r) => {
          resolve({ response: r, error: api.runtime.lastError?.message || '' });
        });
      });
    }, tabId);

    expect(resp.error).toBe('');
    expect(
      resp.response?.success,
      `deep capture failed: ${resp.response?.error || JSON.stringify(resp.response)}`
    ).toBeTruthy();
    expect(resp.response?.data?.content).toContain('deterministic article');
    await expect(sidepanel.locator('#lesson-title')).toHaveText('Lexora Fixture Lesson', { timeout: 20_000 });
  } finally {
    await context.close();
    await fixture.close();
  }
});

test('selected text Read sets Selected Text lesson in sidepanel', async () => {
  const fixture = await startFixtureServer();
  const extDir = await buildE2eExtensionDir();
  const context = await launchExtensionContext(extDir);

  try {
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/article`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    const sidepanel = await openSidepanelPage(context);
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const ok = await sw.evaluate(async ({ url, text }) => {
      const api = globalThis.chrome || globalThis.browser;
      const tabs = await api.tabs.query({ url });
      const tab = tabs[0];
      if (!tab?.id) return false;
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: (t) => {
          try {
            chrome.runtime.sendMessage({ action: 'captureText', text: t });
            return true;
          } catch (_) {
            return false;
          }
        },
        args: [text],
      });
      return true;
    }, { url: `${fixture.origin}/article`, text: 'Example Domain selected reading content' });

    expect(ok).toBeTruthy();
    await expect(sidepanel.locator('#lesson-header')).toBeVisible({ timeout: 20_000 });
    await expect(sidepanel.locator('#lesson-title')).toHaveText('Selected Text', { timeout: 20_000 });
    await expect(sidepanel.locator('#lesson-text')).toContainText('Example Domain selected reading content');
  } finally {
    await context.close();
    await fixture.close();
  }
});
