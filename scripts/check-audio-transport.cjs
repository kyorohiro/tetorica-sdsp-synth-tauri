// Offline transport stress evidence; no audio device or browser is opened.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {simulate} = require('../tests/helpers/audio-transport.cjs');
const root = path.join(__dirname, '..');
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/audio.rs'), 'utf8');
const credits = Number(/const QUEUE_PACKETS: usize = (\d+);/.exec(rust)[1]);
const prefillPackets = Number(/const PREFILL_PACKETS: usize = (\d+);/.exec(rust)[1]);
const rows = [];
for (const inputRate of [32000, 44100, 48000, 53267]) for (const burstFrames of [128, 512]) {
  for (const count of [4, credits]) rows.push(simulate({credits: count, prefillPackets:count===credits?prefillPackets:2, inputRate, burstFrames, stallMs: 25, duration: 30}));
}
for (const drift of [-.001, .001]) rows.push(simulate({credits, prefillPackets, drift, duration: 60}));
for (const batch of [false,true]) rows.push(simulate({credits, prefillPackets, replyMs:13, batch, duration:30}));
rows.push(simulate({credits:8,prefillPackets:4,inputRate:32000,burstFrames:512,stallMs:25,duration:30}));
for (const row of rows.filter(row => row.credits === credits && row.batch)) {
  assert.equal(row.underruns, 0, JSON.stringify(row)); assert.equal(row.droppedFrames, 0, JSON.stringify(row));
}
assert(rows.some(row => row.credits === 4 && row.underruns > 0 && row.droppedFrames > 0));
assert(rows.some(row => !row.batch && row.replyMs === 13 && row.underruns > 0 && row.droppedFrames > 0));
assert(rows.some(row=>row.credits===8&&row.inputRate===32000&&row.droppedFrames>0&&row.underruns===0));
const files = ['desktop/audio-worklet.js', 'desktop/audio-interface.js', 'src-tauri/src/audio.rs',
  'tests/helpers/audio-transport.cjs', 'scripts/check-audio-transport.cjs'];
const report = {schemaVersion: 1, passed: true, createdAt: new Date().toISOString(),
  scope: 'Offline scheduling model with actual desktop AudioWorklet; native queue and IPC scheduling are modeled.',
  sourceClock: 'S-DSP renders natively at 32 kHz, then the Synth resamples to the Web Audio context clock (usually 44.1/48 kHz). The 32 kHz capture case models a possible context/device-rate conversion, not an unresampled production DSP tap.',
  queuePackets:credits,prefillPackets,
  limitations: ['Not a WebView, CPAL, or listening test.', '25ms UI stalls every 2 seconds; 1ms native delivery; 1ms or 13ms reply delay; 4ms polling.',
    '512-frame device callbacks; FIFO packets; fixed 48kHz device. Longer stalls may still lose audio.'],
  sources: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])), rows};
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
else console.log(JSON.stringify(report, null, 2));
console.log('PASS: bounded transport scheduling stress');
