import { test } from '@playwright/test';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { launchChromiumWithExtension } from './chromium-extension-context.js';

function extensionPath() {
  return path.join(process.cwd(), 'extension');
}

async function startFixtureServer() {
  const articleHtml = `
    <!doctype html>
    <html>
      <head><title>SuperTonic Debug Lesson</title></head>
      <body>
        <main>
          <article>
            <h1>SuperTonic Debug Lesson</h1>
            <p>This is a short test sentence for SuperTonic synthesis debug.</p>
          </article>
        </main>
      </body>
    </html>
  `;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(articleHtml);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('SuperTonic Debug test to capture worker console logs', async () => {
  test.setTimeout(300_000); // 5 minutes
  const logFile = path.join(process.cwd(), 'playwright-console.log');
  if (fs.existsSync(logFile)) {
    try {
      fs.unlinkSync(logFile);
    } catch (err) {
      console.warn('Could not delete old log file:', err);
    }
  }
  const log = (msg) => {
    fs.appendFileSync(logFile, `${new Date().toISOString()} - ${msg}\n`);
    console.log(msg);
  };

  log("1. Starting SuperTonic E2E Debug Test...");

  const fixture = await startFixtureServer();
  log(`2. Fixture server listening at ${fixture.origin}`);

  log("3. Launching Chromium with Lexora extension...");
  const context = await launchChromiumWithExtension(extensionPath());
  log("4. Chromium launched successfully.");

  try {
    const page = await context.newPage();
    page.on('console', msg => {
      log(`[PAGE CONSOLE] [${msg.type()}] ${msg.text()}`);
    });

    log(`5. Navigating page to fixture article: ${fixture.origin}/`);
    await page.goto(`${fixture.origin}/`, { waitUntil: 'domcontentloaded' });
    log("6. Page navigation completed.");

    // Open sidepanel
    log("7. Checking for extension service worker...");
    const sw = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
    if (!sw) {
      log("ERROR: Extension service worker NOT found!");
      throw new Error("Service worker not found");
    }
    const u = new URL(sw.url());
    const origin = `${u.protocol}//${u.host}`;
    log(`8. Service worker found! Origin: ${origin}`);
    
    log("9. Creating new tab for sidepanel...");
    const sidepanel = await context.newPage();
    sidepanel.on('console', msg => {
      log(`[SIDEPANEL CONSOLE] [${msg.type()}] ${msg.text()}`);
    });
    
    log(`10. Navigating sidepanel page to ${origin}/sidepanel/sidepanel.html`);
    await sidepanel.goto(`${origin}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    log("11. Sidepanel page loaded.");
    
    log("12. Injecting debug lesson into chrome.storage.local...");
    await sidepanel.evaluate(() => {
      const api = globalThis.chrome || globalThis.browser;
      api.storage.local.set({
        currentLesson: {
          title: 'Debug Lesson',
          content: 'This is a test sentence for SuperTonic synthesis pipeline debugging.'
        }
      });
    });
    log("13. Debug lesson injected.");

    log("14. Clicking Audio tab...");
    await sidepanel.locator('.tab[data-tab="audio"]').click();
    log("15. Audio tab clicked.");

    log("16. Selecting SuperTonic engine in tts-engine dropdown...");
    await sidepanel.locator('#tts-engine').selectOption('supertonic');
    log("17. SuperTonic engine selected.");
    
    log("18. Waiting 2 seconds for voicepicker list to populate...");
    await sidepanel.waitForTimeout(2000);
    log("19. Wait complete.");

    log("22. Clicking Play button to trigger SuperTonic TTS...");
    await sidepanel.locator('#play-btn').click();
    log("23. Play button clicked!");

    log("24. Waiting 180 seconds to allow ONNX model download, compilation, and synthesis...");
    await sidepanel.waitForTimeout(180000);
    log("25. Done waiting 180 seconds.");
  } catch (err) {
    log(`FATAL EXCEPTION: ${err.message}\n${err.stack || ''}`);
    throw err;
  } finally {
    log("26. Closing browser context and server fixture...");
    await context.close();
    await fixture.close();
    log("27. Test execution finished.");
  }
});
