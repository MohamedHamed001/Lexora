import { describe, expect, test } from 'vitest';

async function loadAlignment() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const filePath = path.join(process.cwd(), 'extension/content/highlighter-alignment.js');
  const src = await fs.readFile(filePath, 'utf8');
  const run = new Function(`${src}\nreturn globalThis.LexoraHighlighterAlignment;`);
  return run();
}

describe('highlighter-alignment', () => {
  test('alignChunkToPage pairs sequential words', async () => {
    const A = await loadAlignment();
    const pageWords = [
      { word: 'Hello', node: {}, start: 0, end: 5 },
      { word: 'world', node: {}, start: 6, end: 11 },
      { word: 'today', node: {}, start: 12, end: 17 },
    ];
    const chunkWords = ['Hello', 'world'];
    const pairs = A.alignChunkToPage(pageWords, chunkWords, 0);
    expect(pairs.map((p) => p.chunkIdx)).toEqual([0, 1]);
    expect(pairs.map((p) => p.pageIdx)).toEqual([0, 1]);
  });

  test('findChunkStart locates chunk after cursor', async () => {
    const A = await loadAlignment();
    const pageWords = [
      { word: 'skip', node: {}, start: 0, end: 4 },
      { word: 'The', node: {}, start: 0, end: 3 },
      { word: 'quick', node: {}, start: 4, end: 9 },
    ];
    const idx = A.findChunkStart(pageWords, 1, ['The', 'quick']);
    expect(idx).toBe(1);
  });
});
