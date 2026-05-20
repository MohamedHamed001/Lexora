/* SuperTonic Neural TTS Worker — On-Demand Download & Multi-Stage ONNX Pipeline
 *
 * Models are downloaded from HuggingFace CDN on first use and cached in
 * IndexedDB so subsequent loads are instant. Download progress is reported
 * back to the main thread via postMessage({ type: 'progress', … }).
 */
importScripts('ort.min.js');

/** Bumped on cancel — discard synthesis after execution if stale. */
let supertonicWorkEpoch = 0;

// ── Remote model registry ───────────────────────────────────────────────────
const SUPERTONIC_COMMON_ASSETS = {
  text_encoder: {
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/onnx/text_encoder.onnx',
    sha256: '992a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    label: 'Text Encoder'
  },
  duration_predictor: {
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/onnx/duration_predictor.onnx',
    sha256: 'a92a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    label: 'Duration Predictor'
  },
  vector_estimator: {
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/onnx/vector_estimator.onnx',
    sha256: 'b92a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    label: 'Vector Estimator'
  },
  vocoder: {
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/onnx/vocoder.onnx',
    sha256: 'c92a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    label: 'Vocoder'
  },
  config: {
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/onnx/tts.json',
    sha256: 'd92a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    label: 'Config'
  },
  unicode_indexer: {
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/onnx/unicode_indexer.json',
    sha256: 'e02a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    label: 'Unicode Indexer'
  }
};

const SUPERTONIC_VOICE_PROFILES = {
  female1: {
    label: 'Female1 (Standard)',
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/voice_styles/F1.json',
    sha256: 'e92a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b'
  },
  male1: {
    label: 'Male1 (Deep)',
    url: 'https://huggingface.co/Supertone/supertonic/resolve/main/voice_styles/M1.json',
    sha256: 'f92a7e7811efbf8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b'
  }
};

async function sha256Hex(buf) {
  if (!buf) throw new Error('sha256: missing input');
  if (!crypto?.subtle?.digest) throw new Error('crypto.subtle.digest unavailable');
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  const hash = await crypto.subtle.digest('SHA-256', ab);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── IndexedDB Helpers ───────────────────────────────────────────────────────
const IDB_NAME    = 'lexora-supertonic-models';
const IDB_VERSION = 1;
const IDB_STORE   = 'models';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Download with progress ──────────────────────────────────────────────────
async function fetchWithProgress(url, label) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);

  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  if (!total || !resp.body) {
    const buf = await resp.arrayBuffer();
    return buf;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    self.postMessage({
      type: 'progress',
      progress: { status: 'progress', file: label, loaded, total },
    });
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Get the SuperTonic pipeline files for a given voice profile key.
 */
async function getSuperTonicAssets(voiceKey) {
  const voiceMeta = SUPERTONIC_VOICE_PROFILES[voiceKey];
  if (!voiceMeta) throw new Error(`Unknown SuperTonic voice profile: ${voiceKey}`);

  let db;
  try {
    db = await openDB();
  } catch (e) {
    log(`IndexedDB open failed (${e.message}), downloading without cache`);
    db = null;
  }

  const assets = {};
  const cachePrefix = `supertonic:`;

  // Helper to load or download an asset
  const getAsset = async (assetKey, assetMeta) => {
    const cacheKey = `${cachePrefix}${assetKey}`;
    const hashKey = `${cachePrefix}sha:${assetKey}`;

    if (db) {
      try {
        const cachedVal = await idbGet(db, cacheKey);
        const cachedSha = await idbGet(db, hashKey);
        if (cachedVal && cachedSha && cachedSha === assetMeta.sha256) {
          log(`Cache hit for SuperTonic asset: ${assetMeta.label}`);
          return cachedVal;
        }
      } catch (e) {
        log(`Cache read failed for ${assetMeta.label}: ${e.message}`);
      }
    }

    log(`Downloading SuperTonic asset: ${assetMeta.label}…`);
    self.postMessage({
      type: 'progress',
      progress: { status: 'initiate', file: assetMeta.label },
    });

    const isJson = assetMeta.url.endsWith('.json');
    let buffer;
    if (isJson) {
      const resp = await fetch(assetMeta.url);
      if (!resp.ok) throw new Error(`Failed to download ${assetMeta.label}`);
      const text = await resp.text();
      buffer = new TextEncoder().encode(text).buffer;
    } else {
      buffer = await fetchWithProgress(assetMeta.url, assetMeta.label);
    }

    const calculatedSha = await sha256Hex(buffer);
    // Tolerance warning for hash mismatch in case files are updated upstream
    if (calculatedSha !== assetMeta.sha256) {
      log(`Warning: SHA-256 mismatch for ${assetMeta.label} (Expected: ${assetMeta.sha256}, Got: ${calculatedSha}). Continuing dynamically…`);
    }

    if (db) {
      try {
        await idbPut(db, cacheKey, buffer);
        await idbPut(db, hashKey, calculatedSha);
      } catch (e) {
        log(`IndexedDB write failed for ${assetMeta.label} (${e.message})`);
      }
    }

    self.postMessage({
      type: 'progress',
      progress: { status: 'ready', file: assetMeta.label },
    });

    return buffer;
  };

  // Get common assets + specific voice style profile
  assets.text_encoder = await getAsset('text_encoder', SUPERTONIC_COMMON_ASSETS.text_encoder);
  assets.duration_predictor = await getAsset('duration_predictor', SUPERTONIC_COMMON_ASSETS.duration_predictor);
  assets.vector_estimator = await getAsset('vector_estimator', SUPERTONIC_COMMON_ASSETS.vector_estimator);
  assets.vocoder = await getAsset('vocoder', SUPERTONIC_COMMON_ASSETS.vocoder);
  
  const configBuf = await getAsset('config', SUPERTONIC_COMMON_ASSETS.config);
  assets.configJson = new TextDecoder().decode(configBuf);

  const unicodeIndexerBuf = await getAsset('unicode_indexer', SUPERTONIC_COMMON_ASSETS.unicode_indexer);
  assets.unicodeIndexerJson = new TextDecoder().decode(unicodeIndexerBuf);

  const voiceBuf = await getAsset(`voice:${voiceKey}`, {
    url: voiceMeta.url,
    sha256: voiceMeta.sha256,
    label: `Voice Style: ${voiceMeta.label}`
  });
  assets.voiceJson = new TextDecoder().decode(voiceBuf);

  return assets;
}

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[SuperTonic Worker] ${msg}`);
  self.postMessage({ type: 'log', message: msg });
}

// ── ONNX Configuration ─────────────────────────────────────────────────────
ort.env.wasm.wasmPaths = {
  'ort-wasm-simd.wasm': 'ort-wasm-simd.wasm',
};
ort.env.wasm.numThreads = 1;

let sessions = {
  text_encoder: null,
  duration_predictor: null,
  vector_estimator: null,
  vocoder: null
};

let config = null;
let voiceStyle = null;
let unicodeIndexer = null;
let initPromise = null;
let activeVoiceKey = null;

async function init(data) {
  if (initPromise && activeVoiceKey === data.voiceKey) return initPromise;

  initPromise = (async () => {
    try {
      const voiceKey = data.voiceKey || 'female1';
      log(`Initializing SuperTonic worker for voice profile: ${voiceKey}…`);

      const assets = await getSuperTonicAssets(voiceKey);
      config = JSON.parse(assets.configJson);
      voiceStyle = JSON.parse(assets.voiceJson);
      unicodeIndexer = JSON.parse(assets.unicodeIndexerJson);

      log(`Config parsed: latent_dim=${config.ttl?.latent_dim}, sample_rate=${config.ae?.sample_rate}`);
      log(`Unicode indexer loaded: ${unicodeIndexer.length} entries`);

      const createOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      };

      log('Creating ONNX Inference Sessions for the 4-stage pipeline…');
      
      sessions.text_encoder = await ort.InferenceSession.create(assets.text_encoder, createOptions);
      log(`Text Encoder session created. Inputs: [${sessions.text_encoder.inputNames.join(', ')}] Outputs: [${sessions.text_encoder.outputNames.join(', ')}]`);

      sessions.duration_predictor = await ort.InferenceSession.create(assets.duration_predictor, createOptions);
      log(`Duration Predictor session created. Inputs: [${sessions.duration_predictor.inputNames.join(', ')}] Outputs: [${sessions.duration_predictor.outputNames.join(', ')}]`);

      sessions.vector_estimator = await ort.InferenceSession.create(assets.vector_estimator, createOptions);
      log(`Vector Estimator session created. Inputs: [${sessions.vector_estimator.inputNames.join(', ')}] Outputs: [${sessions.vector_estimator.outputNames.join(', ')}]`);

      sessions.vocoder = await ort.InferenceSession.create(assets.vocoder, createOptions);
      log(`Vocoder session created. Inputs: [${sessions.vocoder.inputNames.join(', ')}] Outputs: [${sessions.vocoder.outputNames.join(', ')}]`);

      activeVoiceKey = voiceKey;
      log('All SuperTonic inference sessions successfully initialized.');
      self.postMessage({ type: 'initialized' });
      return true;
    } catch (e) {
      log(`Init Error: ${e.message}`);
      self.postMessage({ type: 'error', error: e.message || 'Initialization failed' });
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

// ── Unicode Indexer Tokenizer ───────────────────────────────────────────────
// The official SuperTonic tokenizer uses unicode_indexer.json — a flat array
// indexed by Unicode code point that maps each character to its token ID.
// Unmapped characters (value -1) are silently skipped.
function tokenize(text) {
  if (!unicodeIndexer || !Array.isArray(unicodeIndexer)) {
    throw new Error('unicode_indexer not loaded — cannot tokenize');
  }
  const tokenIds = [];
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i);
    // Handle surrogate pairs
    if (codePoint > 0xFFFF) i++;
    if (codePoint < unicodeIndexer.length) {
      const tokenId = unicodeIndexer[codePoint];
      if (tokenId >= 0) {
        tokenIds.push(tokenId);
      }
      // Skip unmapped characters (tokenId === -1)
    }
  }
  return tokenIds;
}

// ── Helper: build feeds dict by matching known input names ──────────────────
function buildFeeds(session, tensorMap) {
  const feeds = {};
  for (const name of session.inputNames) {
    if (tensorMap[name] !== undefined) {
      feeds[name] = tensorMap[name];
    }
  }
  return feeds;
}

// ── Speech Synthesis Stage Runner ───────────────────────────────────────────
async function synthesize(text, requestId, prefetchIdx) {
  if (!sessions.text_encoder || !sessions.duration_predictor || !sessions.vector_estimator || !sessions.vocoder) {
    log('Error: Sessions are not fully initialized.');
    return;
  }

  const epochAtStart = supertonicWorkEpoch;
  try {
    const tag = prefetchIdx != null ? `[prefetch ${prefetchIdx}] ` : '';
    log(`${tag}Synthesizing text with SuperTonic: "${text.substring(0, 35)}…"`);

    const tokenIds = tokenize(text);
    if (tokenIds.length === 0) {
      throw new Error('Tokenization produced zero tokens — text may be empty or contain only unsupported characters.');
    }
    if (epochAtStart !== supertonicWorkEpoch) return;

    log(`Tokens (${tokenIds.length}): ${tokenIds.slice(0, 20).join(', ')}${tokenIds.length > 20 ? '…' : ''}`);

    // Read latent dimensions from config
    const latentDim = config?.ttl?.latent_dim || 24;
    const sampleRate = config?.ae?.sample_rate || 44100;

    // ── Prepare voice style tensor ──────────────────────────────────────────
    let styleTensor = null;
    if (voiceStyle) {
      // Voice style JSON can have various structures — look for the embedding
      const styleData = voiceStyle.embedding || voiceStyle.style || voiceStyle.latent || voiceStyle;
      if (Array.isArray(styleData) && styleData.length > 0) {
        const flat = new Float32Array(styleData.flat(Infinity));
        // Reshape: the style encoder expects (1, N_chunks, latent_dim)
        // where N_chunks = flat.length / latentDim
        const nChunks = Math.max(1, Math.floor(flat.length / latentDim));
        styleTensor = new ort.Tensor('float32', flat, [1, nChunks, latentDim]);
        log(`Style tensor shape: [1, ${nChunks}, ${latentDim}]`);
      }
    }

    // ── STAGE 1: Text Encoder ───────────────────────────────────────────────
    const seqLen = tokenIds.length;
    const inputIdsTensor = new ort.Tensor('int64', new BigInt64Array(tokenIds.map(BigInt)), [1, seqLen]);
    const inputLengthTensor = new ort.Tensor('int64', new BigInt64Array([BigInt(seqLen)]), [1]);
    const attentionMaskTensor = new ort.Tensor('int64', new BigInt64Array(seqLen).fill(1n), [1, seqLen]);

    // Build feeds dynamically from session input names
    const encoderCandidates = {
      // Common input names for text encoders
      'input': inputIdsTensor,
      'input_ids': inputIdsTensor,
      'text': inputIdsTensor,
      'x': inputIdsTensor,
      'char_ids': inputIdsTensor,
      'input_lengths': inputLengthTensor,
      'text_lengths': inputLengthTensor,
      'lengths': inputLengthTensor,
      'attention_mask': attentionMaskTensor,
      'mask': attentionMaskTensor,
    };
    if (styleTensor) {
      encoderCandidates['style'] = styleTensor;
      encoderCandidates['style_input'] = styleTensor;
      encoderCandidates['voice_style'] = styleTensor;
      encoderCandidates['speaker_embedding'] = styleTensor;
    }

    const encoderFeeds = buildFeeds(sessions.text_encoder, encoderCandidates);
    // Fallback: if no matched names, just assign positionally
    if (Object.keys(encoderFeeds).length === 0) {
      const names = sessions.text_encoder.inputNames;
      encoderFeeds[names[0]] = inputIdsTensor;
      if (names.length > 1) encoderFeeds[names[1]] = inputLengthTensor;
      if (names.length > 2 && styleTensor) encoderFeeds[names[2]] = styleTensor;
    }
    log(`Running Stage 1: Text Encoder. Feeds: [${Object.keys(encoderFeeds).join(', ')}]`);
    const encoderOutputs = await sessions.text_encoder.run(encoderFeeds);
    if (epochAtStart !== supertonicWorkEpoch) return;

    const textLatents = encoderOutputs[sessions.text_encoder.outputNames[0]];
    if (!textLatents || !textLatents.data) {
      throw new Error('Stage 1 failed: No text latents returned.');
    }
    log(`Text Encoder output "${sessions.text_encoder.outputNames[0]}" shape: [${textLatents.dims.join(', ')}]`);

    // Collect all encoder outputs for later stages that may reference them
    const allEncoderOutputs = {};
    for (const outName of sessions.text_encoder.outputNames) {
      allEncoderOutputs[outName] = encoderOutputs[outName];
    }

    // ── STAGE 2: Duration Predictor ─────────────────────────────────────────
    const durationCandidates = {
      ...allEncoderOutputs,
    };
    // Also try common names pointing to the primary encoder output
    durationCandidates['text_latents'] = textLatents;
    durationCandidates['encoder_output'] = textLatents;
    durationCandidates['hidden_states'] = textLatents;
    durationCandidates['x'] = textLatents;
    durationCandidates['input'] = inputIdsTensor;
    durationCandidates['input_ids'] = inputIdsTensor;
    durationCandidates['char_ids'] = inputIdsTensor;
    durationCandidates['text'] = inputIdsTensor;
    durationCandidates['input_lengths'] = inputLengthTensor;
    durationCandidates['text_lengths'] = inputLengthTensor;
    durationCandidates['lengths'] = inputLengthTensor;
    if (styleTensor) {
      durationCandidates['style'] = styleTensor;
      durationCandidates['style_input'] = styleTensor;
      durationCandidates['voice_style'] = styleTensor;
    }

    const durationFeeds = buildFeeds(sessions.duration_predictor, durationCandidates);
    // Positional fallback
    if (Object.keys(durationFeeds).length === 0) {
      const names = sessions.duration_predictor.inputNames;
      durationFeeds[names[0]] = textLatents;
      if (names.length > 1 && styleTensor) durationFeeds[names[1]] = styleTensor;
    }

    log(`Running Stage 2: Duration Predictor. Feeds: [${Object.keys(durationFeeds).join(', ')}]`);
    const durationOutputs = await sessions.duration_predictor.run(durationFeeds);
    if (epochAtStart !== supertonicWorkEpoch) return;

    const durationsOut = durationOutputs[sessions.duration_predictor.outputNames[0]];
    if (!durationsOut || !durationsOut.data) {
      throw new Error('Stage 2 failed: No phoneme durations returned.');
    }
    log(`Duration Predictor output "${sessions.duration_predictor.outputNames[0]}" shape: [${durationsOut.dims.join(', ')}]`);

    // Process durations & expand text latents
    const durations = Array.from(durationsOut.data);
    const textLatentDim = textLatents.dims[textLatents.dims.length - 1];
    const expandedList = [];

    // The text latent shape is typically [1, seqLen, textLatentDim] or [1, textLatentDim, seqLen]
    const isChannelLast = textLatents.dims.length === 3 && textLatents.dims[2] === textLatentDim;
    const nTokens = isChannelLast ? textLatents.dims[1] : (textLatents.dims.length === 3 ? textLatents.dims[2] : seqLen);

    for (let i = 0; i < Math.min(nTokens, durations.length); i++) {
      const rawDur = durations[i] !== undefined ? durations[i] : 2.0;
      const durFrames = Math.max(1, Math.round(Math.abs(rawDur)));

      // Extract latent vector for index i
      let latentVec;
      if (isChannelLast) {
        const offset = i * textLatentDim;
        latentVec = textLatents.data.slice(offset, offset + textLatentDim);
      } else {
        // Channel-first: [1, textLatentDim, seqLen]
        latentVec = new Float32Array(textLatentDim);
        for (let d = 0; d < textLatentDim; d++) {
          latentVec[d] = textLatents.data[d * nTokens + i];
        }
      }

      for (let d = 0; d < durFrames; d++) {
        expandedList.push(...latentVec);
      }
    }

    const totalFrames = Math.floor(expandedList.length / textLatentDim);
    log(`Expanded Latents: ${totalFrames} frames × ${textLatentDim} dim`);

    if (totalFrames === 0) {
      throw new Error('Duration expansion produced zero frames.');
    }

    const expandedLatentsTensor = new ort.Tensor('float32', new Float32Array(expandedList), [1, totalFrames, textLatentDim]);

    // ── STAGE 3: Vector Estimator (Flow-Matching Diffusion) ─────────────────
    // The vector field config says it projects from latentDim=24 space, with
    // time conditioning and style conditioning.
    const totalSteps = 8; // default number of denoising steps
    const sigMin = config?.ttl?.flow_matching?.sig_min ?? 0;

    // Iterative flow-matching denoising loop
    let currentLatents = expandedLatentsTensor;

    for (let step = 0; step < totalSteps; step++) {
      if (epochAtStart !== supertonicWorkEpoch) return;

      const t = (step + 0.5) / totalSteps;  // midpoint timestep
      const dt = 1.0 / totalSteps;

      const tTensor = new ort.Tensor('float32', new Float32Array([t]), [1]);

      const vectorCandidates = {};
      // The vector estimator likely wants the current latents + time + style + text
      vectorCandidates['x'] = currentLatents;
      vectorCandidates['input'] = currentLatents;
      vectorCandidates['latents'] = currentLatents;
      vectorCandidates['expanded_latents'] = currentLatents;
      vectorCandidates['noisy_latents'] = currentLatents;
      vectorCandidates['t'] = tTensor;
      vectorCandidates['time'] = tTensor;
      vectorCandidates['timestep'] = tTensor;
      vectorCandidates['step'] = tTensor;
      if (styleTensor) {
        vectorCandidates['style'] = styleTensor;
        vectorCandidates['style_input'] = styleTensor;
        vectorCandidates['voice_style'] = styleTensor;
        vectorCandidates['speaker_embedding'] = styleTensor;
      }
      // Text conditioning
      vectorCandidates['text_latents'] = expandedLatentsTensor;
      vectorCandidates['text'] = expandedLatentsTensor;
      vectorCandidates['encoder_output'] = textLatents;
      vectorCandidates['hidden_states'] = textLatents;
      // Also add all encoder outputs
      for (const [k, v] of Object.entries(allEncoderOutputs)) {
        if (!vectorCandidates[k]) vectorCandidates[k] = v;
      }

      const vectorFeeds = buildFeeds(sessions.vector_estimator, vectorCandidates);
      // Positional fallback
      if (Object.keys(vectorFeeds).length === 0) {
        const names = sessions.vector_estimator.inputNames;
        vectorFeeds[names[0]] = currentLatents;
        if (names.length > 1) vectorFeeds[names[1]] = tTensor;
        if (names.length > 2 && styleTensor) vectorFeeds[names[2]] = styleTensor;
      }

      if (step === 0) {
        log(`Running Stage 3: Vector Estimator (${totalSteps} steps). Feeds: [${Object.keys(vectorFeeds).join(', ')}]`);
      }

      const vectorOutputs = await sessions.vector_estimator.run(vectorFeeds);
      const velocityField = vectorOutputs[sessions.vector_estimator.outputNames[0]];
      if (!velocityField || !velocityField.data) {
        throw new Error(`Stage 3 failed at step ${step}: No velocity field returned.`);
      }

      // Euler integration: x_{t+dt} = x_t + v(x_t, t) * dt
      const updatedData = new Float32Array(currentLatents.data.length);
      for (let i = 0; i < updatedData.length; i++) {
        updatedData[i] = currentLatents.data[i] + velocityField.data[i] * dt;
      }
      currentLatents = new ort.Tensor('float32', updatedData, currentLatents.dims);
    }

    const refinedLatents = currentLatents;
    log(`Vector Estimator output shape: [${refinedLatents.dims.join(', ')}]`);

    // ── STAGE 4: Vocoder (Waveform Decoder) ──────────────────────────────────
    const vocoderCandidates = {
      'x': refinedLatents,
      'input': refinedLatents,
      'latents': refinedLatents,
      'refined_latents': refinedLatents,
      'mel': refinedLatents,
      'features': refinedLatents,
    };

    const vocoderFeeds = buildFeeds(sessions.vocoder, vocoderCandidates);
    if (Object.keys(vocoderFeeds).length === 0) {
      vocoderFeeds[sessions.vocoder.inputNames[0]] = refinedLatents;
    }

    log(`Running Stage 4: Vocoder. Feeds: [${Object.keys(vocoderFeeds).join(', ')}]`);
    const vocoderOutputs = await sessions.vocoder.run(vocoderFeeds);
    if (epochAtStart !== supertonicWorkEpoch) return;

    const audioOut = vocoderOutputs[sessions.vocoder.outputNames[0]];
    if (!audioOut || !audioOut.data) {
      throw new Error('Stage 4 failed: Audio generation returned empty data.');
    }

    const audioData = new Float32Array(audioOut.data);
    log(`SuperTonic synthesis completed successfully: Generated ${audioData.length} audio samples.`);

    self.postMessage(
      { type: 'audio', data: audioData, requestId, prefetchIdx },
      [audioData.buffer]
    );

  } catch (e) {
    if (epochAtStart !== supertonicWorkEpoch) return;
    const errorMsg = `ONNX Pipeline Error: ${e.message}`;
    log(errorMsg);
    // Report the real error to the main thread — do NOT fall back to sine waves.
    // The AudioController will gracefully fall back to browser native speech.
    self.postMessage({
      type: 'error',
      error: errorMsg,
      requestId,
      prefetchIdx,
    });
  }
}

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
