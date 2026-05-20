import { test } from '@playwright/test';
import path from 'node:path';
import http from 'node:http';
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
  const fixture = await startFixtureServer();
  const context = await launchChromiumWithExtension(extensionPath());

  try {
    const page = await context.newPage();
    page.on('console', msg => {
      console.log(`[PAGE CONSOLE] [${msg.type()}] ${msg.text()}`);
    });

    await page.goto(`${fixture.origin}/`, { waitUntil: 'domcontentloaded' });

    // Open sidepanel
    const sw = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
    if (!sw) throw new Error("Service worker not found");
    const u = new URL(sw.url());
    const origin = `${u.protocol}//${u.host}`;
    
    const sidepanel = await context.newPage();
    sidepanel.on('console', msg => {
      console.log(`[SIDEPANEL CONSOLE] [${msg.type()}] ${msg.text()}`);
    });
    
    await sidepanel.goto(`${origin}/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    
    // Inject a lesson
    await sidepanel.evaluate(() => {
      const api = globalThis.chrome || globalThis.browser;
      api.storage.local.set({
        currentLesson: {
          title: 'Debug Lesson',
          content: 'This is a test sentence for SuperTonic synthesis pipeline debugging.'
        }
      });
    });

    // Select SuperTonic engine in select
    await sidepanel.locator('#tts-engine-select').selectOption('supertonic');
    
    // Wait for voicepicker to populated with supertonic voices
    await sidepanel.waitForTimeout(2000);

    // Switch to audio tab (in case it is needed to click play)
    await sidepanel.locator('.tab[data-tab="audio"]').click();

    // Click play button to start synthesis
    await sidepanel.locator('#play-btn').click();

    // Wait a while so synthesis has plenty of time to download and run the ONNX pipeline
    console.log("Waiting for synthesis to run and print logs...");
    await sidepanel.waitForTimeout(30000); // 30 seconds to allow Hugging Face model download/synthesis
    console.log("Done waiting.");
  } finally {
    await context.close();
    await fixture.close();
  }
});
