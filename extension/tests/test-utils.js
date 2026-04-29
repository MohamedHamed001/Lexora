import assert from 'assert';
import { splitIntoChunks } from '../sidepanel/js/utils.js';

function runTests() {
  console.log('Running tests for utils.js...');

  // Test splitIntoChunks
  const sampleText = "Hello world. This is a test. How are you today? I am fine!";
  const chunks = splitIntoChunks(sampleText, 20);
  
  assert.ok(chunks.length > 0, 'Should split text into chunks');
  assert.equal(chunks[0], 'Hello world.');
  assert.equal(chunks[1], 'This is a test.');
  assert.equal(chunks[2], 'How are you today?');
  assert.equal(chunks[3], 'I am fine!');

  const emptyChunks = splitIntoChunks("");
  assert.equal(emptyChunks.length, 0, 'Empty string should return empty array');

  console.log('✅ All chunking tests passed!');
}

runTests();
