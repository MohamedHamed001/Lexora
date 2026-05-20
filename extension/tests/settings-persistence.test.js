import { describe, expect, test, beforeEach, vi } from 'vitest';

// `settings.js` calls `document.getElementById` at import time (via `dom.js`).
// jsdom is provided by the vitest config, so DOM is available; the helpers
// we test don't need any specific elements.

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildPersistedConfig', () => {
  test('strips key when rememberKey is false', async () => {
    const { buildPersistedConfig } = await import('../sidepanel/js/settings.js');
    const out = buildPersistedConfig(
      { url: 'http://x', model: 'm', key: 'sk-secret', ttsEngine: 'kokoro' },
      false,
    );
    expect(out.key).toBeUndefined();
    expect(out.url).toBe('http://x');
    expect(out.ttsEngine).toBe('kokoro');
  });

  test('preserves key when rememberKey is true', async () => {
    const { buildPersistedConfig } = await import('../sidepanel/js/settings.js');
    const out = buildPersistedConfig(
      { url: 'http://x', key: 'sk-secret' },
      true,
    );
    expect(out.key).toBe('sk-secret');
  });

  test('also strips legacy ttsKey field when rememberKey is false', async () => {
    const { buildPersistedConfig } = await import('../sidepanel/js/settings.js');
    const out = buildPersistedConfig(
      { url: 'http://x', key: 'sk', ttsKey: 'cloud-secret' },
      false,
    );
    expect(out.key).toBeUndefined();
    expect(out.ttsKey).toBeUndefined();
  });

  test('does not mutate the input config', async () => {
    const { buildPersistedConfig } = await import('../sidepanel/js/settings.js');
    const input = { url: 'http://x', key: 'sk' };
    const out = buildPersistedConfig(input, false);
    expect(input.key).toBe('sk');
    expect(out).not.toBe(input);
  });

  test('handles null/undefined config without throwing', async () => {
    const { buildPersistedConfig } = await import('../sidepanel/js/settings.js');
    expect(() => buildPersistedConfig(null, false)).not.toThrow();
    expect(() => buildPersistedConfig(undefined, true)).not.toThrow();
    expect(buildPersistedConfig(null, false)).toEqual({});
  });
});

// Integration test: simulate the TTS engine change handler and verify it
// never re-persists the in-memory key when the user has not opted in.
describe('initSettings persistence on TTS engine change', () => {
  test('TTS engine change does not write `key` to storage.local when rememberKey was off', async () => {
    document.body.innerHTML = `
      <input id="setting-url" />
      <input id="setting-model" />
      <input id="setting-key" />
      <input type="checkbox" id="setting-remember-key" />
      <input type="checkbox" id="setting-theme" />
      <input type="checkbox" id="setting-autocapture" />
      <button id="save-settings-btn"></button>
      <span id="settings-status"></span>
      <select id="tts-engine"><option value="kokoro">kokoro</option><option value="piper">piper</option><option value="supertonic">supertonic</option></select>
      <select id="kokoro-dtype"><option value="q4">q4</option><option value="q8">q8</option></select>
      <span id="stat-session-words"></span>
      <span id="stat-session-time"></span>
      <span id="stat-alltime-words"></span>
      <span id="stat-alltime-time"></span>
    `;

    vi.resetModules();

    const localSet = vi.fn((_obj, cb) => cb && cb());
    const localGet = vi.fn((_keys, cb) => cb({}));
    const sessionGet = vi.fn((_keys, cb) => cb({}));
    const onChangedAdd = vi.fn();

    const { state } = await import('../sidepanel/js/state.js');
    state.browserAPI = {
      storage: {
        local: { get: localGet, set: localSet },
        session: { get: sessionGet, set: vi.fn((_, cb) => cb && cb()), remove: vi.fn((_, cb) => cb && cb()) },
        onChanged: { addListener: onChangedAdd },
      },
    };
    // Simulate a session-only key already in memory (typical after the user
    // saved with rememberKey unchecked).
    state.config.key = 'sk-session-only';
    state.config.ttsEngine = 'kokoro';

    const { initSettings } = await import('../sidepanel/js/settings.js');
    initSettings({ audio: null });

    // Trigger the TTS engine change handler.
    const sel = document.getElementById('tts-engine');
    sel.value = 'piper';
    sel.dispatchEvent(new Event('change'));

    // Find the lexoraConfig set call.
    const writes = localSet.mock.calls
      .map((c) => c[0])
      .filter((arg) => arg && Object.prototype.hasOwnProperty.call(arg, 'lexoraConfig'));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.lexoraConfig.key).toBeUndefined();
    }
  });

  test('TTS engine change to supertonic persists correctly', async () => {
    document.body.innerHTML = `
      <input id="setting-url" />
      <input id="setting-model" />
      <input id="setting-key" />
      <input type="checkbox" id="setting-remember-key" />
      <input type="checkbox" id="setting-theme" />
      <input type="checkbox" id="setting-autocapture" />
      <button id="save-settings-btn"></button>
      <span id="settings-status"></span>
      <select id="tts-engine"><option value="kokoro">kokoro</option><option value="piper">piper</option><option value="supertonic">supertonic</option></select>
      <select id="kokoro-dtype"><option value="q4">q4</option><option value="q8">q8</option></select>
      <span id="stat-session-words"></span>
      <span id="stat-session-time"></span>
      <span id="stat-alltime-words"></span>
      <span id="stat-alltime-time"></span>
    `;

    vi.resetModules();

    const localSet = vi.fn((_obj, cb) => cb && cb());
    const localGet = vi.fn((_keys, cb) => cb({}));
    const sessionGet = vi.fn((_keys, cb) => cb({}));
    const onChangedAdd = vi.fn();

    const { state } = await import('../sidepanel/js/state.js');
    state.browserAPI = {
      storage: {
        local: { get: localGet, set: localSet },
        session: { get: sessionGet, set: vi.fn((_, cb) => cb && cb()), remove: vi.fn((_, cb) => cb && cb()) },
        onChanged: { addListener: onChangedAdd },
      },
    };
    state.config.ttsEngine = 'kokoro';

    const { initSettings } = await import('../sidepanel/js/settings.js');
    initSettings({ audio: null });

    const sel = document.getElementById('tts-engine');
    sel.value = 'supertonic';
    sel.dispatchEvent(new Event('change'));

    expect(state.config.ttsEngine).toBe('supertonic');
    const writes = localSet.mock.calls
      .map((c) => c[0])
      .filter((arg) => arg && Object.prototype.hasOwnProperty.call(arg, 'lexoraConfig'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1].lexoraConfig.ttsEngine).toBe('supertonic');
  });
});
