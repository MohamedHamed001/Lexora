import { describe, expect, test } from 'vitest';

async function loadCaptureClean() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const filePath = path.join(process.cwd(), 'extension', 'capture-clean.js');
  const src = await fs.readFile(filePath, 'utf8');

  // Evaluate in an isolated function and return the functions we need.
  // This avoids changing production code just for exports.
  const factory = new Function(
    `${src}\n\nreturn { cleanCapturedMarkdownNonAi, cleanCapturedLessonNonAi };`
  );
  return factory();
}

describe('capture-clean', () => {
  test('removes obvious boilerplate blocks/lines', async () => {
    const { cleanCapturedMarkdownNonAi } = await loadCaptureClean();
    const input = [
      'Skip to main content',
      '',
      '## Lesson Title',
      '',
      'We use cookies to improve your experience.',
      '',
      'This is the real content paragraph.',
      '',
      '© 2026 Example Inc. All rights reserved.',
    ].join('\n');

    const out = cleanCapturedMarkdownNonAi(input);
    expect(out).toContain('## Lesson Title');
    expect(out).toContain('This is the real content paragraph.');
    expect(out.toLowerCase()).not.toContain('skip to main');
    expect(out.toLowerCase()).not.toContain('cookies');
    expect(out.toLowerCase()).not.toContain('all rights reserved');
  });

  test('does not over-strip: preserves content when output becomes too small', async () => {
    const { cleanCapturedMarkdownNonAi } = await loadCaptureClean();
    const bigContent = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: real content.`).join(
      '\n\n'
    );

    // Craft input that could over-trigger boilerplate removal if buggy
    const input = `${bigContent}\n\nCookie policy\n\nAccept all cookies`;
    const out = cleanCapturedMarkdownNonAi(input);

    // Should still contain most of the original content (or fall back to original)
    expect(out.length).toBeGreaterThan(input.length * 0.15);
    expect(out).toContain('Paragraph 0: real content.');
  });

  test('cleanCapturedLessonNonAi returns lesson with cleaned content', async () => {
    const { cleanCapturedLessonNonAi } = await loadCaptureClean();
    const lesson = { title: 'T', url: 'U', content: 'Skip to main content\n\nHello world.' };
    const out = cleanCapturedLessonNonAi(lesson);
    expect(out.title).toBe('T');
    expect(out.url).toBe('U');
    expect(out.content).toContain('Hello world.');
    expect(out.content.toLowerCase()).not.toContain('skip to main');
  });
});

