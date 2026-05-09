/**
 * Pure helpers for building bounded, fenced lesson context for the chat system prompt.
 */

export const MAX_LESSON_CONTEXT_CHARS = 8000;
/** When over max, keep start + end so questions about conclusions still work. */
export const CONTEXT_HEAD_CHARS = 5200;
export const CONTEXT_TAIL_CHARS = 2400;

// Must stay in sync with chat.js system prompt — unique fence tokens.
export const FENCE_OPEN = '<<<LEXORA_SOURCE_START>>>';
export const FENCE_CLOSE = '<<<LEXORA_SOURCE_END>>>';

export function stripFenceTokens(raw, open = FENCE_OPEN, close = FENCE_CLOSE) {
  const s = String(raw ?? '');
  return s.split(open).join('').split(close).join('');
}

/**
 * Truncate captured lesson text for the LLM: head + tail if over budget.
 */
export function budgetLessonContext(
  raw,
  maxChars = MAX_LESSON_CONTEXT_CHARS,
  headChars = CONTEXT_HEAD_CHARS,
  tailChars = CONTEXT_TAIL_CHARS
) {
  let text = stripFenceTokens(raw);
  if (text.length <= maxChars) return text;

  const markerBudget = 80;
  const head = Math.min(headChars, Math.max(1000, Math.floor(maxChars * 0.62)));
  const tail = Math.min(tailChars, Math.max(800, Math.floor(maxChars * 0.28)));
  if (head + tail + markerBudget >= text.length) {
    return text.slice(0, maxChars) + '\n...[content truncated]...';
  }
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n...[middle omitted — ${omitted} characters]...\n\n` +
    text.slice(-tail)
  );
}
