import js from "@eslint/js";
export default [
  js.configs.recommended,
  {
    ignores: [
      "dist/**",
      "extension/libs/**",
      "extension/sidepanel/ort*.{js,wasm,mjs}",
      "extension/sidepanel/*.wasm",
      "extension/sidepanel/*.onnx",
      "extension/sidepanel/kokoro.web.js",
      "extension/sidepanel/piper_phonemize.js",
      "extension/sidepanel/piper-worker.js",
      "extension/sidepanel/kokoro-worker.js",
      "extension/sidepanel/supertonic-worker.js"
    ],
  },
  {
    // Node-context files (tests, tooling, configs)
    files: [
      "**/*.config.js",
      "playwright.config.js",
      "scripts/**/*.mjs",
      "extension/tests/**/*.js",
      "extension/e2e/**/*.js",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        URL: "readonly",
        chrome: "readonly",
        browser: "readonly",
        indexedDB: "readonly",
        self: "readonly",
        importScripts: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        window: "readonly",
        document: "readonly",
        location: "readonly",
        crypto: "readonly",
        console: "readonly",
        performance: "readonly",
        Worker: "readonly",
        Audio: "readonly",
        Blob: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        SpeechSynthesisUtterance: "readonly",
        NodeFilter: "readonly",
        MutationObserver: "readonly",
        LexoraProtocol: "readonly",
        LexoraStorage: "readonly",
        LexoraProxy: "readonly",
        LexoraLessonCapture: "readonly",
        TextDecoder: "readonly",
        cleanCapturedLessonNonAi: "readonly"
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
];

