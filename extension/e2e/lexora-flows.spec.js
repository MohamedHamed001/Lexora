import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

function extensionPath() {
  return path.join(process.cwd(), 'extension');
}

async function buildE2eExtensionDir() {
  // Build a test-only extension directory with broader permissions,
  // so E2E can exercise capture/injection without interactive permission prompts.
  const base = extensionPath();
  const outDir = path.join(os.tmpdir(), `lexora-e2e-extension-${Date.now()}`);
  await fs.cp(base, outDir, { recursive: true });

  const manifestPath = path.join(outDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);

  // Ensure required perms for the scenarios.
  manifest.permissions = Array.from(
    new Set([...(manifest.permissions || []), 'webNavigation'])
  );
  manifest.host_permissions = ['https://example.com/*'];

  // Keep optional permissions too (fine).
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return outDir;
}

let _e2eExtDirPromise = null;
async function getE2eExtensionDir() {
  if (!_e2eExtDirPromise) _e2eExtDirPromise = buildE2eExtensionDir();
  return _e2eExtDirPromise;
}

async function getExtensionOrigin(context) {
  // Service worker url looks like: chrome-extension://<id>/background.js
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const url = sw.url();
  return new URL(url).origin;
}

async function openSidepanelPage(context) {
  const origin = await getExtensionOrigin(context);
  const sidepanel = await context.newPage();
  await sidepanel.goto(`${origin}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await expect(sidepanel.locator('#capture-btn')).toBeVisible();
  const hasRuntime = await sidepanel.evaluate(() => {
    const api = globalThis.chrome || globalThis.browser;
    return !!api?.runtime?.sendMessage;
  });
  expect(hasRuntime).toBeTruthy();
  return sidepanel;
}

test.skip('deep capture updates sidepanel lesson title', async () => {
  const extDir = await getE2eExtensionDir();
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });

  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  const sidepanel = await openSidepanelPage(context);

  const tabId = await sidepanel.evaluate(async () => {
    const api = globalThis.chrome || globalThis.browser;
    const tabs = await api.tabs.query({ url: 'https://example.com/*' });
    const tab = tabs[0];
    return tab?.id || null;
  });
  expect(tabId).toBeTruthy();

  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const resp = await sw.evaluate(async ({ tabId }) => {
    const api = globalThis.chrome || globalThis.browser;
    return await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ r: null, err: 'Timed out waiting for response' });
      }, 25_000);
      try {
        api.runtime.sendMessage({ action: 'triggerDeepCapture', tabId }, (r) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          const err = api.runtime.lastError?.message;
          resolve({ r, err });
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ r: null, err: e?.message || String(e) });
      }
    });
  }, { tabId });
  expect(resp.err || '').toBe('');
  expect(resp.r?.success).toBeTruthy();
  expect(resp.r?.data?.content?.length || 0).toBeGreaterThan(50);

  await expect(sidepanel.locator('#lesson-title')).not.toHaveText('', { timeout: 20_000 });

  await context.close();
});

test.skip('selected text → Read sets "Selected Text" lesson in sidepanel', async () => {
  const extDir = await getE2eExtensionDir();
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });

  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  const sidepanel = await openSidepanelPage(context);

  // Trigger the same event via an injected extension-world function so sender.tab is set.
  const text = 'Example Domain';
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const ok = await sw.evaluate(async ({ text }) => {
    const api = globalThis.chrome || globalThis.browser;
    const tabs = await api.tabs.query({ url: 'https://example.com/*' });
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
  }, { text });
  expect(ok).toBeTruthy();

  await expect(sidepanel.locator('#lesson-header')).toBeVisible({ timeout: 20_000 });
  await expect(sidepanel.locator('#lesson-title')).toHaveText('Selected Text', { timeout: 20_000 });

  await context.close();
});

