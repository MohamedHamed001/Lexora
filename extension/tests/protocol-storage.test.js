import { describe, expect, test } from 'vitest';

async function loadGlobalScript(relPath, globalKey) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const filePath = path.join(process.cwd(), relPath);
  const src = await fs.readFile(filePath, 'utf8');
  const run = new Function(`${src}\nreturn (typeof globalThis !== 'undefined' ? globalThis : this);`);
  const g = run();
  expect(g[globalKey]).toBeTruthy();
  return g[globalKey];
}

describe('protocol.js', () => {
  test('exports ACTIONS and recognizes known actions', async () => {
    const P = await loadGlobalScript('extension/protocol.js', 'LexoraProtocol');
    expect(P.ACTIONS.PROXY_FETCH).toBe('proxyFetch');
    expect(P.isKnownAction('proxyFetch')).toBe(true);
    expect(P.isKnownAction('not-a-real-action')).toBe(false);
    expect(P.getAction({ action: 'probeCapturable' })).toBe('probeCapturable');
    expect(P.getAction({})).toBe(null);
    expect(P.isTextSelectionRequest({ action: 'captureText', text: 'hello' })).toBe(true);
    expect(P.isTextSelectionRequest({ action: 'captureText', text: '   ' })).toBe(false);
    expect(P.isHighlightWordRequest({ action: 'highlightWord', chunkText: 'hello', wordIndex: 0 })).toBe(true);
    expect(P.isHighlightWordRequest({ action: 'highlightWord', chunkText: 'hello', wordIndex: -1 })).toBe(false);
    expect(P.isProxyFetchRequest({ action: 'proxyFetch', url: 'http://127.0.0.1', method: 'POST' })).toBe(true);
  });
});

describe('storage.js', () => {
  test('exports KEYS and progress key helper', async () => {
    const S = await loadGlobalScript('extension/storage.js', 'LexoraStorage');
    expect(S.KEYS.CURRENT_LESSON).toBe('currentLesson');
    expect(S.KEYS.PROGRESS_INDEX).toBe('lexoraProgressIndex');
    expect(typeof S.progressKeyForUrl).toBe('function');
    expect(typeof S.legacyProgressKeyForUrl).toBe('function');

    const k = S.progressKeyForUrl('https://example.com/a');
    expect(k.startsWith('progress_')).toBe(true);
    expect(k.includes('https://')).toBe(false);

    expect(S.legacyProgressKeyForUrl('https://example.com/a')).toBe('progress_https://example.com/a');
    expect(S.progressKeyForUrl(null).startsWith('progress_')).toBe(true);
  });
});
