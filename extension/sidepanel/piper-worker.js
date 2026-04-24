/* Piper Neural TTS Worker — On-Demand Download Edition
 *
 * Models are downloaded from HuggingFace CDN on first use and cached in
 * IndexedDB so subsequent loads are instant.  Download progress is reported
 * back to the main thread via postMessage({ type: 'progress', … }).
 */
importScripts('ort.min.js', 'piper_phonemize.js');

// ── Remote model registry ───────────────────────────────────────────────────
const PIPER_REMOTE_MODELS = {
  amy: {
    onnxUrl:   'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/low/en_US-amy-low.onnx',
    configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/low/en_US-amy-low.onnx.json',
    label: 'Amy (low)',
    sampleRate: 16000,
  },
  hfc_female: {
    onnxUrl:   'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx',
    configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json',
    label: 'Google Female EN (medium)',
    sampleRate: 22050,
  },
};

// ── IndexedDB helpers ───────────────────────────────────────────────────────
const IDB_NAME    = 'lexora-piper-models';
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
    // Fallback: no streaming progress (small files or no content-length)
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

  // Merge chunks into a single ArrayBuffer
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Get the model + config for a given modelKey.
 * Returns { modelBuffer: ArrayBuffer, configJson: string }.
 *
 * Priority: IndexedDB cache → HuggingFace CDN download → store in IDB.
 */
async function getModelAssets(modelKey) {
  const meta = PIPER_REMOTE_MODELS[modelKey];
  if (!meta) throw new Error(`Unknown Piper model: ${modelKey}`);

  const onnxCacheKey  = `onnx:${modelKey}`;
  const configCacheKey = `config:${modelKey}`;

  let db;
  try { db = await openDB(); } catch (e) {
    log(`IndexedDB open failed (${e.message}), downloading without cache`);
    db = null;
  }

  // 1. Try IndexedDB cache
  if (db) {
    try {
      const [cachedModel, cachedConfig] = await Promise.all([
        idbGet(db, onnxCacheKey),
        idbGet(db, configCacheKey),
      ]);
      if (cachedModel && cachedConfig) {
        log(`Cache hit for ${modelKey} — loading from IndexedDB`);
        self.postMessage({
          type: 'progress',
          progress: { status: 'ready', file: meta.label },
        });
        return { modelBuffer: cachedModel, configJson: cachedConfig };
      }
    } catch (e) {
      log(`IndexedDB read failed: ${e.message}`);
    }
  }

  // 2. Download from HuggingFace CDN
  log(`Downloading ${meta.label} from HuggingFace…`);
  self.postMessage({
    type: 'progress',
    progress: { status: 'initiate', file: `${meta.label} model` },
  });

  const modelBuffer = await fetchWithProgress(meta.onnxUrl, `${meta.label} model`);

  self.postMessage({
    type: 'progress',
    progress: { status: 'initiate', file: `${meta.label} config` },
  });
  const configResp = await fetch(meta.configUrl);
  if (!configResp.ok) throw new Error(`Failed to download config for ${meta.label}`);
  const configJson = await configResp.text();

  // 3. Cache in IndexedDB for next time
  if (db) {
    try {
      await Promise.all([
        idbPut(db, onnxCacheKey, modelBuffer),
        idbPut(db, configCacheKey, configJson),
      ]);
      log(`Cached ${meta.label} in IndexedDB`);
    } catch (e) {
      log(`IndexedDB write failed (${e.message}) — model works but won't be cached`);
    }
  }

  self.postMessage({
    type: 'progress',
    progress: { status: 'ready', file: meta.label },
  });

  return { modelBuffer, configJson };
}

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[Piper Worker] ${msg}`);
  self.postMessage({ type: 'log', message: msg });
}

// ── ONNX Configuration ─────────────────────────────────────────────────────
ort.env.wasm.wasmPaths = {
  'ort-wasm-simd.wasm': 'ort-wasm-simd.wasm',
};
ort.env.wasm.numThreads = 1;

let session = null;
let phonemizer = null;
let config = null;
let initPromise = null;

/**
 * Initialize the worker.  Accepts either:
 *   { modelKey: string }            — worker downloads the model itself (new)
 *   { model: ArrayBuffer, config }  — caller provides the buffer  (legacy)
 */
async function init(data) {
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    try {
      let modelArray, configJson;

      if (data.modelKey) {
        // New path: download on demand
        const assets = await getModelAssets(data.modelKey);
        modelArray = assets.modelBuffer;
        configJson = assets.configJson;
      } else if (data.model) {
        // Legacy path: caller provided the buffer
        modelArray = data.model;
        configJson = data.config;
      } else {
        throw new Error('init requires either modelKey or model+config');
      }

      log('Initializing…');
      config = JSON.parse(configJson);
    
    log('Creating ONNX session…');
    session = await ort.InferenceSession.create(modelArray, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });

    log(`Session created. Inputs: ${session.inputNames.join(', ')} | Outputs: ${session.outputNames.join(', ')}`);

    let stdoutBuffer = [];
    const printCallback = (text) => {
      stdoutBuffer.push(text);
    };

    phonemizer = await createPiperPhonemize({
      print: printCallback,
      printErr: (text) => log(`WASM Stderr: ${text}`),
      locateFile: (path) => path.startsWith('data:') ? path : path 
    });

    log('Phonemizer ready.');
    
    // Some versions of piper_phonemize.js already define Module.phonemize
    // If not, we bridge it via callMain
    if (typeof phonemizer.phonemize !== 'function') {
      log('Building phonemize bridge using callMain CLI interface…');
      
      phonemizer.phonemize = (text, voice) => {
        stdoutBuffer = [];
        try {
          // Arguments: language, input text (as JSON array of objects), espeak_data path
          // The CLI usually expects: -l voice --input 'JSON'
          const args = [
            "-l", voice || "en-us",
            "--input", JSON.stringify([{ text: text.trim() }]),
            "--espeak_data", "/espeak-ng-data"
          ];
          
          log(`Calling callMain with args: ${args.join(' ')}`);
          phonemizer.callMain(args);
          
        } catch (e) {
          // Emscripten modules often throw ExitStatus(0) on success
          if (e.name !== 'ExitStatus') {
            log(`callMain Error: ${e.message}`);
            throw e;
          }
        }
        
        const output = stdoutBuffer.join('\n');
        if (!output) {
          throw new Error('phonemize produced no stdout output');
        }
        
        try {
          // The output might be multiple lines or a single JSON string
          // piper-phonemize usually returns one JSON per line for each sentence
          const parsed = JSON.parse(output);
          // If we passed an array of 1, we expect 1 result (or it might be the array itself)
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch (err) {
          log(`JSON Parse Error on WASM output: ${output.substring(0, 100)}…`);
          throw new Error(`Failed to parse phonemizer output: ${err.message}`);
        }
      };
    }

    log(`Phonemizer initialized. Sub-keys: ${phonemizer.asm ? 'asm ' : ''}${phonemizer.instance?.exports ? 'exports ' : ''}`);
    self.postMessage({ type: 'initialized' });
    return true;
  } catch (e) {
    log(`Init Error: ${e.message}`);
    self.postMessage({ type: 'error', error: e.message || 'Initialization failed' });
    initPromise = null; // Allow retry
    throw e;
  }
})();
return initPromise;
}

async function synthesize(text, requestId, prefetchIdx) {
  if (!session || !phonemizer) {
    log('Error: Session or Phonemizer not ready.');
    return;
  }

  try {
    const tag = prefetchIdx != null ? `[prefetch ${prefetchIdx}] ` : '';
    log(`${tag}Synthesizing text: "${text.substring(0, 30)}${text.length > 30 ? '…' : ''}"`);
    
    const phonemeRes = phonemizer.phonemize(text, config.espeak.voice);
    if (!phonemeRes || !phonemeRes.length || !phonemeRes[0].phonemes) {
      throw new Error('Phonemize failed: unexpected output structure');
    }
    
    // piper-phonemize returns an array of sentences
    const phonemes = phonemeRes[0].phonemes;
    log(`Phonemes: ${phonemes.join('')}`);
    
    const phonemeIds = [];
    const pad = config.phoneme_id_map['_'][0];
    const bos = config.phoneme_id_map['^'][0];
    const eos = config.phoneme_id_map['$'][0];

    phonemeIds.push(bos);
    phonemeIds.push(pad);
    for (const p of phonemes) {
      if (config.phoneme_id_map[p]) {
        phonemeIds.push(config.phoneme_id_map[p][0]);
        phonemeIds.push(pad);
      }
    }
    phonemeIds.push(eos);

    log(`IDs Length: ${phonemeIds.length}`);

    const input = new ort.Tensor('int64', new BigInt64Array(phonemeIds.map(BigInt)), [1, phonemeIds.length]);
    const inputLengths = new ort.Tensor('int64', new BigInt64Array([BigInt(phonemeIds.length)]), [1]);
    const scales = new ort.Tensor('float32', new Float32Array([
      config.inference.noise_scale || 0.667, 
      config.inference.length_scale || 1.0, 
      config.inference.noise_w || 0.8
    ]), [3]);
    
    // Many Piper models use 'sid' (speaker id)
    const sid = new ort.Tensor('int64', new BigInt64Array([0n]), [1]);

    const feeds = {
      input: input,
      input_lengths: inputLengths,
      scales: scales
    };
    // Only add sid if it's an expected input
    if (session.inputNames.includes('sid')) {
      feeds.sid = sid;
    }

    const startTime = performance.now();
    const outputs = await session.run(feeds);
    const endTime = performance.now();
    
    const audioOut = outputs[session.outputNames[0]]; // Use first output
    if (!audioOut || !audioOut.data) {
      throw new Error('Inference failed: No audio data in output');
    }

    log(`Synthesis complete: ${audioOut.data.length} samples in ${(endTime - startTime).toFixed(2)}ms`);

    const audioData = audioOut.data; 
    self.postMessage(
      { type: 'audio', data: audioData, requestId, prefetchIdx },
      [audioData.buffer]
    );
  } catch (e) {
    log(`Synthesis Error: ${e.message}`);
    self.postMessage({
      type: 'error',
      error: e.message || 'Synthesis failed',
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
  }
};
