export async function loadReadingProgressForLesson(browserAPI, lesson) {
  if (!browserAPI?.storage?.local?.get) return null;
  if (!lesson?.url || lesson?.title === 'Selected Text') return null;

  const hasStorage = globalThis.LexoraStorage && LexoraStorage.progressKeyForUrl;
  const progressKey = hasStorage
    ? LexoraStorage.progressKeyForUrl(lesson.url)
    : 'progress_' + lesson.url;
  const legacyKey =
    hasStorage && LexoraStorage.legacyProgressKeyForUrl
      ? LexoraStorage.legacyProgressKeyForUrl(lesson.url)
      : null;
  const keys = legacyKey ? [progressKey, legacyKey] : [progressKey];

  const res = await new Promise((resolve) => {
    try {
      browserAPI.storage.local.get(keys, (r) => resolve(r || {}));
    } catch (_) {
      resolve({});
    }
  });

  const v =
    res[progressKey] !== undefined
      ? res[progressKey]
      : legacyKey && res[legacyKey] !== undefined
        ? res[legacyKey]
        : undefined;

  if (v === undefined) return null;

  // One-way migrate legacy keys if needed.
  if (legacyKey && res[progressKey] === undefined && res[legacyKey] !== undefined) {
    try {
      browserAPI.storage.local.set({ [progressKey]: v }, () => {
        browserAPI.storage.local.remove([legacyKey], () => {});
      });
    } catch (_) {}
  }

  return v;
}

export function saveReadingProgressForLesson(browserAPI, lesson, sentenceIdx) {
  if (!browserAPI?.storage?.local?.set) return;
  if (!lesson?.url || lesson?.title === 'Selected Text') return;

  const hasStorage = globalThis.LexoraStorage && LexoraStorage.progressKeyForUrl;
  const progressKey = hasStorage
    ? LexoraStorage.progressKeyForUrl(lesson.url)
    : 'progress_' + lesson.url;
  const indexKey =
    hasStorage && LexoraStorage.KEYS && LexoraStorage.KEYS.PROGRESS_INDEX
      ? LexoraStorage.KEYS.PROGRESS_INDEX
      : 'lexoraProgressIndex';

  try {
    browserAPI.storage.local.set({ [progressKey]: sentenceIdx }, () => {
      try {
        browserAPI.storage.local.get([indexKey], (res) => {
          const prev = Array.isArray(res && res[indexKey]) ? res[indexKey] : [];
          const now = Date.now();
          const next = [{ k: progressKey, url: lesson.url, t: now }]
            .concat(prev.filter((e) => e && e.k !== progressKey).slice(0, 199));
          browserAPI.storage.local.set({ [indexKey]: next });
        });
      } catch (_) {}
    });
  } catch (_) {}
}

