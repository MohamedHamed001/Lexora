/**
 * Deterministic capture cleanup (no AI): whitespace, Unicode, light dedup, boilerplate trim.
 * Used by the service worker before persisting; exposed globally for the sidepanel if needed.
 */
function cleanCapturedMarkdownNonAi(text) {
  if (typeof text !== 'string' || !text.trim()) return text;

  const original = text;
  let s = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .normalize('NFKC');

  const paragraphs = s.split(/\n{2,}/);
  const cleaned = [];
  let lastHeadingNorm = null;
  let prevParaNorm = null;

  for (let raw of paragraphs) {
    const lines = raw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) continue;

    const block = lines.join('\n');
    const norm = block.toLowerCase().replace(/\s+/g, ' ').trim();

    if (isBoilerplateBlock(norm)) continue;

    const hm = block.match(/^##\s+(.+)$/);
    if (hm) {
      const hNorm = hm[1].trim().toLowerCase();
      if (hNorm === lastHeadingNorm) continue;
      lastHeadingNorm = hNorm;
    } else {
      lastHeadingNorm = null;
    }

    if (norm.length > 40 && norm === prevParaNorm) continue;
    prevParaNorm = norm.length > 40 ? norm : null;

    cleaned.push(block);
  }

  let out = cleaned.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!out.trim()) return original;
  // Avoid wiping real content if a bug strips too aggressively (only for longer captures).
  if (original.length >= 400 && out.length < original.length * 0.15) return original;
  return out;
}

function cleanCapturedLessonNonAi(lesson) {
  if (!lesson || typeof lesson.content !== 'string') return lesson;
  return { ...lesson, content: cleanCapturedMarkdownNonAi(lesson.content) };
}

function isBoilerplateBlock(norm) {
  if (norm.length > 140) return false;
  const t = norm.replace(/[.!?…]+$/g, '').trim();

  const patterns = [
    /^skip to main( content)?$/i,
    /^(cookie|cookies)(\s+policy|\s+settings|\s+preferences)?$/i,
    /^accept(\s+all)?(\s+cookies)?$/i,
    /^reject(\s+all)?(\s+(cookies|non-essential))?$/i,
    /^we(\s+)?use(\s+)?cookies?/i,
    /^manage(\s+)?(cookie\s+)?preferences$/i,
    /^privacy(\s+policy)?$/i,
    /^terms(\s+of(\s+service|\s+use))?$/i,
    /^subscribe(\s+to(\s+our)?\s+newsletter)?$/i,
    /^sign\s+in$/i,
    /^log\s+in$/i,
    /^create(\s+an?)?\s+account$/i,
    /^copyright\s+©?\s*\d{4}/i,
    /^all\s+rights\s+reserved\.?$/i,
  ];
  return patterns.some((re) => re.test(t));
}
