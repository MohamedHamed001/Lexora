import { describe, expect, test } from 'vitest';
import { splitIntoChunks, mdToDomFragment, markMatches } from '../sidepanel/js/utils.js';

describe('splitIntoChunks', () => {
  test('splits basic sentences', () => {
    const sampleText = 'Hello world. This is a test. How are you today? I am fine!';
    const chunks = splitIntoChunks(sampleText, 20);
    expect(chunks).toEqual(['Hello world.', 'This is a test.', 'How are you today?', 'I am fine!']);
  });

  test('empty string returns empty array', () => {
    expect(splitIntoChunks('')).toEqual([]);
  });

  test('does not split after honorific or e.g. / i.e.', () => {
    const t = 'Mr. Smith went home. Coffee can be prepared (e.g., espresso). i.e. it varies.';
    const chunks = splitIntoChunks(t, 200);
    expect(chunks.some((c) => c.includes('Mr. Smith'))).toBe(true);
    expect(chunks.some((c) => /\(e\.g\.,\s*espresso\)/.test(c))).toBe(true);
    expect(chunks.some((c) => c.includes('i.e.'))).toBe(true);
  });
});

describe('mdToDomFragment', () => {
  test('does not create real HTML elements from input', () => {
    const frag = mdToDomFragment('<img src=x onerror=alert(1) />');
    const host = document.createElement('div');
    host.appendChild(frag);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img');
  });
});

describe('markMatches', () => {
  test('marks every match inside a text node', () => {
    const host = document.createElement('div');
    host.textContent = 'repeat once, repeat twice, repeat three times';

    markMatches(host, 'repeat');

    expect(host.querySelectorAll('mark')).toHaveLength(3);
    expect(host.textContent).toBe('repeat once, repeat twice, repeat three times');
  });
});
