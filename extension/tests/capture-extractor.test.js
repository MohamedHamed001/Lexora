import { describe, expect, test } from 'vitest';

async function loadExtractor() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const filePath = path.join(process.cwd(), 'extension', 'capture-extractor.js');
  const src = await fs.readFile(filePath, 'utf8');

  const factory = new Function(
    `${src}\n\nreturn globalThis.LexoraCaptureExtractor;`
  );
  return factory();
}

describe('capture-extractor', () => {
  test('extracts readable article content without duplicating parent containers', async () => {
    const extractor = await loadExtractor();
    document.title = 'Test Lesson - Site';
    document.body.innerHTML = `
      <main>
        <article>
          <h1>Readable Lesson</h1>
          <p>This is a substantial paragraph with enough text to be captured by the extractor.</p>
          <p>This second paragraph gives the capture enough volume and should only appear once.</p>
        </article>
      </main>
      <footer>This footer should not be captured.</footer>
    `;

    const out = extractor.extractPageContent(document, { protocol: 'https:', href: 'https://example.test/lesson' });

    expect(out.title).toBe('Test Lesson');
    expect(out.content).toContain('## Readable Lesson');
    expect(out.content).toContain('This second paragraph gives the capture enough volume');
    expect(out.content).not.toContain('footer should not be captured');
    expect(out.url).toBe('https://example.test/lesson');
  });

  test('prefers PDF text layer when it is the strongest signal', async () => {
    const extractor = await loadExtractor();
    document.title = 'PDF';
    const pdfText = Array.from({ length: 30 }, (_, i) => `<span>PDF line ${i} with selectable training content.</span>`).join('');
    document.body.innerHTML = `
      <p>Short HTML paragraph.</p>
      <div class="textLayer">${pdfText}</div>
    `;

    const out = extractor.extractPageContent(document, { protocol: 'https:', href: 'https://example.test/file.pdf' });

    expect(out.content).toContain('PDF line 0');
    expect(out.content).toContain('PDF line 29');
    expect(out.content).not.toContain('Short HTML paragraph.');
  });

  test('probe reports ready for sufficiently large html content', async () => {
    const extractor = await loadExtractor();
    const body = Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i} with enough repeated educational text to pass readiness checks.</p>`).join('');
    document.body.innerHTML = `<article>${body}</article>`;

    const out = extractor.probePageContent(document, { protocol: 'https:', href: 'https://example.test/ready' });

    expect(out.capturable).toBe(true);
    expect(out.status).toBe('ready');
    expect(out.kind).toBe('html');
  });
});
