/**
 * Kokoro TTS Web Worker — Streaming + Prefetch Edition
 *
 * Uses an internal job queue so "cancel" can clear pending work immediately.
 * In-flight synthesis cannot be aborted, but when it finishes after cancel,
 * results are discarded and the main thread is notified so audioCache placeholders clear.
 */

import { KokoroTTS, env } from "./kokoro.web.js";

const localDir = self.location.href.substring(
  0,
  self.location.href.lastIndexOf("/") + 1
);
env.wasmPaths = localDir;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts = null;
let initPromise = null;

/** Bumped on cancel — jobs with older epoch are skipped after generate() returns. */
let workEpoch = 0;
const jobQueue = [];
let pumpRunning = false;

function log(msg) {
  console.log(`[Kokoro Worker] ${msg}`);
  self.postMessage({ type: "log", message: msg });
}

async function init(dtype = "q8", device = "wasm") {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      log(`WASM paths → ${localDir}`);
      log(`Loading model: ${MODEL_ID} (${dtype}/${device})…`);

      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype,
        device,
        progress_callback: (p) => self.postMessage({ type: "progress", progress: p }),
      });

      let voices = [];
      try { voices = tts.list_voices() || []; } catch (_) {}

      log(`Model loaded. ${voices.length} voices.`);
      self.postMessage({ type: "initialized", voices });
      return true;
    } catch (e) {
      log(`Init error: ${e.message}`);
      self.postMessage({ type: "error", error: e.message });
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

function extractAudio(result) {
  let samples = null;
  let rate = 24000;
  if (!result) return { samples, rate };

  if (result.audio instanceof Float32Array) {
    samples = result.audio;
    rate = result.sampling_rate || rate;
  } else if (result instanceof Float32Array) {
    samples = result;
  } else if (result.audio && result.audio.audio instanceof Float32Array) {
    samples = result.audio.audio;
    rate = result.audio.sampling_rate || rate;
  } else if (result.data instanceof Float32Array) {
    samples = result.data;
    rate = result.sampling_rate || result.sample_rate || rate;
  } else if (result.audio && typeof result.audio.length === "number") {
    samples = new Float32Array(result.audio);
    rate = result.sampling_rate || result.sample_rate || rate;
  }
  return { samples, rate };
}

async function runJob(job) {
  if (!tts) {
    self.postMessage({ type: "error", error: "Model not loaded", requestId: job.requestId });
    return;
  }

  const { text, voice, requestId, prefetchIdx, epoch: epochAtStart } = job;
  const tag = prefetchIdx != null ? `[prefetch ${prefetchIdx}]` : "";

  try {
    log(`${tag} Synth (${voice}): "${text.substring(0, 35)}…"`);
    const t0 = performance.now();

    const result = await tts.generate(text, { voice });

    if (epochAtStart !== workEpoch) {
      log(`${tag} Discarded after generate (stale epoch)`);
      self.postMessage({ type: "discarded", requestId, prefetchIdx });
      return;
    }

    const ms = (performance.now() - t0).toFixed(0);
    const { samples, rate } = extractAudio(result);
    if (!samples || samples.length === 0) {
      throw new Error("No audio data from generate()");
    }

    log(`${tag} Done ${ms}ms — ${samples.length} samples @ ${rate}Hz`);

    const copy = new Float32Array(samples);
    self.postMessage(
      { type: "audio", audio: copy, sampleRate: rate, requestId, prefetchIdx },
      [copy.buffer]
    );
  } catch (e) {
    if (epochAtStart !== workEpoch) {
      self.postMessage({ type: "discarded", requestId, prefetchIdx });
      return;
    }
    log(`Synthesis error: ${e.message}`);
    self.postMessage({ type: "error", error: e.message, requestId, prefetchIdx });
  }
}

async function pump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    if (initPromise) await initPromise;
    while (jobQueue.length) {
      const job = jobQueue.shift();
      if (job.epoch !== workEpoch) continue;
      await runJob(job);
    }
  } finally {
    pumpRunning = false;
    if (jobQueue.length) pump();
  }
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === "init") {
    init(d.dtype, d.device).then(() => pump()).catch(() => {});
    return;
  }
  if (d.type === "cancel") {
    workEpoch++;
    jobQueue.length = 0;
    log(`cancel — epoch ${workEpoch}`);
    return;
  }
  if (d.type === "synthesize" || d.type === "prefetch") {
    jobQueue.push({
      text: d.text,
      voice: d.voice,
      requestId: d.requestId,
      prefetchIdx: d.prefetchIdx,
      epoch: workEpoch,
    });
    pump();
    return;
  }
  if (d.type === "list_voices") {
    if (tts) self.postMessage({ type: "voices", voices: tts.list_voices() });
    else self.postMessage({ type: "error", error: "Model not loaded yet" });
  }
};
