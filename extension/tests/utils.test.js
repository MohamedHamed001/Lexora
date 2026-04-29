import { describe, expect, test } from 'vitest';
import { splitIntoChunks, mdToDomFragment } from '../sidepanel/js/utils.js';

describe('splitIntoChunks', () => {
  test('splits basic sentences', () => {
    const sampleText = 'Hello world. This is a test. How are you today? I am fine!';
    const chunks = splitIntoChunks(sampleText, 20);
    expect(chunks).toEqual(['Hello world.', 'This is a test.', 'How are you today?', 'I am fine!']);
  });

  test('empty string returns empty array', () => {
    expect(splitIntoChunks('')).toEqual([]);
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

