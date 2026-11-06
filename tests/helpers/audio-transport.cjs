// Deterministic scheduling probe: real shipped capture processor, model of the
// native bounded packet queue/half-full prefill and consumed-packet credits.
// This does not simulate a WebView, CPAL device, or physical listening output.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../desktop/audio-worklet.js'), 'utf8');

function simulate({duration = 10, credits = 8, stallMs = 0, drift = 0,
  burstFrames = 128, inputRate = 44100, deviceRate = 48000, replyMs = 1, batch = true,
  prefillPackets = credits / 2} = {}) {
  let Processor, time = 0, queued = 0, consumed = 0, returned = 0, playing = false;
  let underruns = 0, sequence = 0, maxQueue = 0, packets = 0;
  const pending = [], frames = 512;
  // Every two seconds, pause only UI/IPC delivery. Both audio clocks continue.
  const uiTime = t => {
    const phase = t % 2000;
    return phase >= 1000 && phase < 1000 + stallMs ? t + 1000 + stallMs - phase : t;
  };
  const schedule = (t, fn) => pending.push({t, fn, sequence: sequence++});
  let writing = false, awaitingWrites = 0, writeRequests = 0, largestBatch = 0;
  function flushWrites() {
    if (writing || !awaitingWrites) return;
    writing = true;
    const count = batch ? Math.min(credits, awaitingWrites) : 1;
    awaitingWrites -= count; writeRequests++; largestBatch = Math.max(largestBatch, count);
    const delivered = uiTime(time) + 1;
    schedule(delivered, () => {
      queued += frames * count; maxQueue = Math.max(maxQueue, queued);
      if (queued > frames * credits) throw Error('Native queue overflow');
    });
    schedule(uiTime(delivered + replyMs), () => { writing = false; flushWrites(); });
  }
  vm.runInNewContext(source, {
    sampleRate: inputRate, Float32Array, Number, Math, RangeError,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {postMessage(packet) {
          if (!(packet instanceof ArrayBuffer)) return;
          if (packet.byteLength !== frames * 8) throw Error('Wrong PCM packet length');
          for (const sample of new Float32Array(packet)) if (!Number.isFinite(sample)) throw Error('Nonfinite PCM');
          packets++;
          schedule(uiTime(time), () => { awaitingWrites++; flushWrites(); });
        }};
      }
    },
    registerProcessor(_name, constructor) { Processor = constructor; },
  });
  const processor = new Processor({processorOptions: {frames, maxCredits: credits, outputSampleRate: deviceRate}});
  const send = data => processor.port.onmessage({data});
  send({type: 'credit', count: credits});
  const left = new Float32Array(128).fill(.25);
  const outputs = [[new Float32Array(128), new Float32Array(128)]];
  let nextInput = 0, nextDevice = 0, nextPoll = 0, lastPoll = 0;
  while (time < duration * 1000) {
    pending.sort((a, b) => a.t - b.t || a.sequence - b.sequence);
    const nextPending = pending[0]?.t ?? Infinity;
    time = Math.min(nextInput, nextDevice, nextPoll, nextPending);
    if (time === nextPending) { pending.shift().fn(); continue; }
    if (time === nextInput) {
      // Batch four real 128-frame quanta to model bursty audio scheduling.
      for (let offset = 0; offset < burstFrames; offset += 128) processor.process([[left, left]], outputs);
      nextInput += burstFrames / inputRate * 1000; continue;
    }
    if (time === nextDevice) {
      if (!playing && queued >= frames * prefillPackets) playing = true;
      if (playing) {
        const count = Math.min(frames, queued); queued -= count; consumed += count;
        if (count < frames) { playing = false; underruns++; }
      }
      nextDevice += frames / (deviceRate * (1 + drift)) * 1000; continue;
    }
    const count = Math.floor(consumed / frames) - returned; returned += count;
    const snapshot = queued, intervalSeconds = (time - lastPoll) / 1000; lastPoll = time;
    schedule(uiTime(time) + 1, () => {
      if (count) send({type: 'credit', count});
      send({type: 'clock', queuedFrames: snapshot, intervalSeconds});
    });
    nextPoll = uiTime(time + 4);
  }
  return {credits, prefillPackets, stallMs, drift, burstFrames, inputRate, deviceRate, duration, replyMs, batch, writeRequests, largestBatch,
    underruns, droppedFrames: processor.droppedFrames, queued, maxQueue, packets,
    correction: processor.step / processor.baseStep - 1};
}
module.exports = {simulate};
