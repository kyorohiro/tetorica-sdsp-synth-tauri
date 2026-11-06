const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {simulate} = require('./helpers/audio-transport.cjs');
const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/audio.rs'), 'utf8');
const credits = Number(/const QUEUE_PACKETS: usize = (\d+);/.exec(rust)[1]);
const prefillPackets = Number(/const PREFILL_PACKETS: usize = (\d+);/.exec(rust)[1]);

test('bounded transport tolerates recurring 25ms UI delays at supported source clocks and burst sizes', () => {
  for (const inputRate of [32000, 44100, 48000, 53267]) for (const burstFrames of [128, 512]) {
    const result = simulate({credits, prefillPackets, inputRate, burstFrames, stallMs: 25});
    assert.equal(result.underruns, 0, JSON.stringify(result));
    assert.equal(result.droppedFrames, 0, JSON.stringify(result));
    assert(result.maxQueue <= 512 * credits);
  }
  const old = simulate({credits: 4, stallMs: 25});
  assert(old.underruns > 0 && old.droppedFrames > 0, 'fixture must reproduce the previous short-buffer failure');
  const previous32k=simulate({credits:8,prefillPackets:4,inputRate:32000,burstFrames:512,stallMs:25});
  assert.equal(previous32k.underruns,0);assert(previous32k.droppedFrames>0,'eight credits lose capture frames at the modeled 32kHz burst boundary');
});

test('independent audio clocks remain bounded during one minute of device drift', () => {
  for (const drift of [-.001, .001]) {
    const result = simulate({credits, prefillPackets, drift, duration: 60});
    assert.equal(result.underruns, 0, JSON.stringify(result));
    assert.equal(result.droppedFrames, 0, JSON.stringify(result));
    assert(Math.abs(result.correction) <= .002);
  }
});

test('long UI stalls still discard bounded audio and recover rather than accumulating stale notes', () => {
  const result = simulate({credits, prefillPackets, stallMs: 200});
  assert(result.underruns > 0 && result.droppedFrames > 0);
  assert(result.queued > 0 && result.queued <= 512 * credits);
});

test('batching sustains device throughput when individual IPC acknowledgements take 13ms', () => {
  const serial = simulate({credits, prefillPackets, replyMs:13, batch:false});
  assert(serial.underruns > 0 && serial.droppedFrames > 0, JSON.stringify(serial));
  const batched = simulate({credits, prefillPackets, replyMs:13, batch:true});
  assert.equal(batched.underruns,0,JSON.stringify(batched));
  assert.equal(batched.droppedFrames,0,JSON.stringify(batched));
  assert(batched.largestBatch>1&&batched.largestBatch<=credits);
  assert(batched.maxQueue<=512*credits);
});
