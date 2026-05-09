import { describe, expect, test } from 'vitest';

async function loadGuards() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const filePath = path.join(process.cwd(), 'extension', 'message-guards.js');
  const src = await fs.readFile(filePath, 'utf8');
  const run = new Function(`${src}\nreturn (typeof globalThis !== 'undefined' ? globalThis : this);`);
  const g = run();
  expect(g.LexoraMessageGuards).toBeTruthy();
  return g.LexoraMessageGuards;
}

describe('message-guards', () => {
  test('clampSelectionText trims and caps length', async () => {
    const G = await loadGuards();
    expect(G.clampSelectionText('  hi  ')).toBe('hi');
    const huge = 'x'.repeat(G.MAX_SELECTION_TEXT_CHARS + 100);
    expect(G.clampSelectionText(huge).length).toBe(G.MAX_SELECTION_TEXT_CHARS);
  });

  test('isTrustedSelectionSender requires tab id and matching extension id', async () => {
    const G = await loadGuards();
    expect(G.isTrustedSelectionSender(null, 'ext')).toBe(false);
    expect(G.isTrustedSelectionSender({ id: 'a', tab: { id: 1 } }, 'b')).toBe(false);
    expect(G.isTrustedSelectionSender({ id: 'x', tab: { id: 1 } }, 'x')).toBe(true);
    expect(G.isTrustedSelectionSender({ tab: {} }, 'x')).toBe(false);
  });

  test('normalizeAutoCaptureLesson rejects short content', async () => {
    const G = await loadGuards();
    expect(G.normalizeAutoCaptureLesson({ content: 'short', title: 'T', url: 'u' })).toBe(null);
  });

  test('normalizeAutoCaptureLesson accepts extractor-shaped lesson', async () => {
    const G = await loadGuards();
    const content = `${'paragraph '.repeat(20)}`; // > 80 chars
    const out = G.normalizeAutoCaptureLesson({
      title: 'Lesson',
      content,
      url: 'https://example.com/a',
    });
    expect(out.title).toBe('Lesson');
    expect(out.content).toBe(content);
    expect(out.url).toBe('https://example.com/a');
  });
});
