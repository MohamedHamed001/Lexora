/* Piper Neural TTS Worker */
importScripts('ort.min.js', 'piper_phonemize.js');

function log(msg) {
  console.log(`[Piper Worker] ${msg}`);
  self.postMessage({ type: 'log', message: msg });
}

// ── ONNX Configuration ──────────────────────────────────────────────────────
ort.env.wasm.wasmPaths = {
  'ort-wasm.wasm': 'ort-wasm.wasm',
  'ort-wasm-simd.wasm': 'ort-wasm-simd.wasm',
};
ort.env.wasm.numThreads = 1;

let session = null;
let phonemizer = null;
let config = null;
let initPromise = null;

async function init(modelArray, configJson) {
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    try {
      log('Initializing...');
      config = JSON.parse(configJson);
    
    log('Creating ONNX session...');
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
      log('Building phonemize bridge using callMain CLI interface...');
      
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
          log(`JSON Parse Error on WASM output: ${output.substring(0, 100)}...`);
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

async function synthesize(text, requestId) {
  if (!session || !phonemizer) {
    log('Error: Session or Phonemizer not ready.');
    return;
  }

  try {
    log(`Synthesizing text: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`);
    
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
    self.postMessage({ type: 'audio', data: audioData, requestId: requestId }, [audioData.buffer]);
  } catch (e) {
    log(`Synthesis Error: ${e.message}`);
    self.postMessage({ type: 'error', error: e.message || 'Synthesis failed', requestId: requestId });
  }
}

self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    await init(e.data.model, e.data.config);
  } else if (e.data.type === 'synthesize') {
    if (initPromise) await initPromise;
    await synthesize(e.data.text, e.data.requestId);
  }
};
