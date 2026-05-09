import { describe, expect, test } from 'vitest';
import {
  budgetLessonContext,
  stripFenceTokens,
  FENCE_OPEN,
  FENCE_CLOSE,
  MAX_LESSON_CONTEXT_CHARS,
} from '../sidepanel/js/chat-context.js';

describe('chat-context', () => {
  test('stripFenceTokens removes fence markers', () => {
    const raw = `a ${FENCE_OPEN} b ${FENCE_CLOSE} c`;
    expect(stripFenceTokens(raw)).toBe('a  b  c');
  });

  test('budgetLessonContext keeps head and tail when over max', () => {
    const chunk = 'x'.repeat(1200);
    const raw = chunk + 'MIDDLE_MARK' + chunk + 'END_TAIL';
    const out = budgetLessonContext(raw, 2000, 400, 300);
    expect(out.length).toBeLessThanOrEqual(raw.length);
    expect(out).toContain('...[middle omitted');
    expect(out.startsWith('x')).toBe(true);
    expect(out.endsWith('END_TAIL')).toBe(true);
    expect(out).not.toContain('MIDDLE_MARK');
  });

  test('budgetLessonContext returns short text unchanged', () => {
    const s = 'short lesson';
    expect(budgetLessonContext(s, MAX_LESSON_CONTEXT_CHARS)).toBe(s);
  });
});
