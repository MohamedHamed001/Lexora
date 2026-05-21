/* SuperTonic Neural TTS Worker — Powered by @huggingface/transformers
 *
 * Uses the official transformers.js pipeline("text-to-speech") API with
 * the onnx-community/Supertonic-TTS-ONNX model. The library handles
 * tokenization, ONNX session orchestration, and tensor plumbing automatically.
 *
 * Voice embeddings are binary .bin files (Float32Array) from HuggingFace.
 * Models are cached by transformers.js in the browser Cache Storage.
 */
import { pipeline, env, Tensor } from './transformers.min.js';

/** Bumped on cancel — discard synthesis after execution if stale. */
let supertonicWorkEpoch = 0;

const SAMPLE_RATE = 44100;

const MODEL_ID = 'onnx-community/Supertonic-TTS-ONNX';
const VOICES_BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/`;

const SUPERTONIC_VOICE_PROFILES = {
  female1: { label: 'Female1 (Standard)', file: 'F1.bin' },
  female2: { label: 'Female2 (Warm)', file: 'F2.bin' },
  female3: { label: 'Female3 (Clear)', file: 'F3.bin' },
  male1:   { label: 'Male1 (Deep)', file: 'M1.bin' },
  male2:   { label: 'Male2 (Warm)', file: 'M2.bin' },
  male3:   { label: 'Male3 (Clear)', file: 'M3.bin' },
};

let ttsInstance = null;
let voiceEmbeddings = {}; // key -> Float32Array
let initPromise = null;
let activeVoiceKey = null;

// ── Configure transformers.js for Chrome extension environment ──────────────
const localDir = self.location.href.substring(
  0,
  self.location.href.lastIndexOf("/") + 1
);
env.wasmPaths = localDir;
env.allowLocalModels = false;
env.useBrowserCache = true;
// Disable remote code execution (transformers.js v3 feature)
env.allowRemoteModels = true;

// Force local assets and single-threaded WASM to prevent dynamic imports from CDNs
if (!env.backends) env.backends = {};
if (!env.backends.onnx) env.backends.onnx = {};
if (!env.backends.onnx.wasm) env.backends.onnx.wasm = {};
env.backends.onnx.wasm.wasmPaths = localDir;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;


// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[SuperTonic Worker] ${msg}`);
  self.postMessage({ type: 'log', message: msg });
}

log('SuperTonic worker loaded (transformers.js module).');

// ── Download voice embedding (.bin → Float32Array) ──────────────────────────
async function loadVoiceEmbedding(voiceKey) {
  if (voiceEmbeddings[voiceKey]) return voiceEmbeddings[voiceKey];

  const profile = SUPERTONIC_VOICE_PROFILES[voiceKey];
  if (!profile) throw new Error(`Unknown voice: ${voiceKey}`);

  const url = `${VOICES_BASE_URL}${profile.file}`;
  log(`Downloading voice embedding: ${profile.label}…`);

  self.postMessage({
    type: 'progress',
    progress: { status: 'initiate', file: `Voice: ${profile.label}` },
  });

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${profile.label}: HTTP ${resp.status}`);

  const buffer = await resp.arrayBuffer();
  const embedding = new Float32Array(buffer);
  voiceEmbeddings[voiceKey] = embedding;

  log(`Voice embedding loaded: ${profile.label} (${embedding.length} floats, shape inferred: [1, ${Math.floor(embedding.length / 128)}, 128])`);
  self.postMessage({
    type: 'progress',
    progress: { status: 'ready', file: `Voice: ${profile.label}` },
  });

  return embedding;
}

// ── Initialize the TTS pipeline ─────────────────────────────────────────────
async function init(data) {
  const voiceKey = data.voiceKey || 'female1';
  if (initPromise && activeVoiceKey === voiceKey) return initPromise;

  initPromise = (async () => {
    try {
      log(`Initializing SuperTonic (voice: ${voiceKey})…`);

      // Create the TTS pipeline (downloads + caches ONNX models automatically)
      if (!ttsInstance) {
        log(`Creating TTS pipeline with model: ${MODEL_ID}…`);

        self.postMessage({
          type: 'progress',
          progress: { status: 'initiate', file: 'TTS Pipeline' },
        });

        ttsInstance = await pipeline('text-to-speech', MODEL_ID, {
          device: 'wasm', // WASM backend for broad compatibility
          progress_callback: (info) => {
            if (info.status === 'progress') {
              self.postMessage({
                type: 'progress',
                progress: {
                  status: 'progress',
                  file: info.file || 'Model',
                  loaded: info.loaded || 0,
                  total: info.total || 0,
                },
              });
            } else if (info.status === 'done') {
              log(`Downloaded: ${info.file || 'Model file'}`);
            }
          },
        });

        log('TTS pipeline created successfully.');

        // Warm up with a short utterance to compile WASM kernels
        log('Warming up model…');
        const dummyEmbedding = new Float32Array(1 * 101 * 128);
        const dummyTensor = new Tensor('float32', dummyEmbedding, [1, 101, 128]);
        await ttsInstance('Hi', {
          speaker_embeddings: dummyTensor,
          num_inference_steps: 1,
          speed: 1.0,
        });
        log('Model warm-up complete.');
      }

      // Load voice embedding
      await loadVoiceEmbedding(voiceKey);

      activeVoiceKey = voiceKey;
      log('SuperTonic fully initialized and ready.');

      self.postMessage({
        type: 'progress',
        progress: { status: 'ready', file: 'TTS Pipeline' },
      });
      self.postMessage({ type: 'initialized' });
      return true;
    } catch (e) {
      log(`Init Error: ${e.message}\n${e.stack || ''}`);
      self.postMessage({ type: 'error', error: e.message || 'Initialization failed' });
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

// ── Speech Synthesis ────────────────────────────────────────────────────────
async function synthesize(text, requestId, prefetchIdx) {
  if (!ttsInstance) {
    log('Error: TTS pipeline not initialized.');
    self.postMessage({ type: 'error', error: 'TTS pipeline not initialized', requestId, prefetchIdx });
    return;
  }

  const voiceKey = activeVoiceKey || 'female1';
  const embedding = voiceEmbeddings[voiceKey];
  if (!embedding) {
    log(`Error: Voice embedding not loaded for ${voiceKey}.`);
    self.postMessage({ type: 'error', error: `Voice embedding not loaded for ${voiceKey}`, requestId, prefetchIdx });
    return;
  }

  const epochAtStart = supertonicWorkEpoch;
  try {
    const tag = prefetchIdx != null ? `[prefetch ${prefetchIdx}] ` : '';
    log(`${tag}Synthesizing: "${text.substring(0, 50)}…"`);

    const seqLen = Math.floor(embedding.length / 128);
    const speakerEmbeddingsTensor = new Tensor('float32', embedding, [1, seqLen, 128]);

    const output = await ttsInstance(text, {
      speaker_embeddings: speakerEmbeddingsTensor,
      num_inference_steps: 8,
      speed: 1.0,
    });

    if (epochAtStart !== supertonicWorkEpoch) return;

    // transformers.js returns { audio: Float32Array, sampling_rate: number }
    const audioData = output.audio instanceof Float32Array
      ? output.audio
      : new Float32Array(output.audio);

    const sampleRate = output.sampling_rate || SAMPLE_RATE;
    log(`${tag}Synthesis complete: ${audioData.length} samples @ ${sampleRate}Hz`);

    self.postMessage(
      { type: 'audio', data: audioData, requestId, prefetchIdx, sampleRate },
      [audioData.buffer]
    );
  } catch (e) {
    if (epochAtStart !== supertonicWorkEpoch) return;
    const errorMsg = `Synthesis Error: ${e.message}`;
    log(errorMsg);
    self.postMessage({ type: 'error', error: errorMsg, requestId, prefetchIdx });
  }
}

// ── Message Handler ─────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    await init(e.data);
  } else if (e.data.type === 'synthesize') {
    if (initPromise) await initPromise;
    await synthesize(e.data.text, e.data.requestId, e.data.prefetchIdx);
  } else if (e.data.type === 'cancel') {
    supertonicWorkEpoch++;
  }
};
