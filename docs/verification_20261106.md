# S-DSP desktop verification — 2026-11-06

Desktop version **0.0.1**, imported Web Synth **0.0.7**.

## Imported source release

- Archive SHA-256: `3a600c50ded29dc98e9bc923b3a722ee06435beb6e4861f2075b89f4ef4c726c`.
- All 62 ZIP entries are present in `dist/` with their original bytes, including
  JS / CSS modules, WASM, browser source archive, complete matching `snes_spc`
  C++ sources, rebuilding instructions and LGPL notices.
- The importer checks product identity, the source-copy builder, relative
  dependency closure, original source archive and native receipts. Its 27
  required native files include the relocated wrapper and build recipe.
- `python3 scripts/import_release.py --check` passes after the builds.
- `.gitattributes` preserves imported bytes on Windows. Local edits can be
  recorded separately without replacing the original release hashes.

## Automated checks

| Check | Result |
| --- | --- |
| `npm ci` | Passed; dependency audit reported 0 vulnerabilities |
| `npm test` | Python 24 passed; Node 42 passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline` | 25 passed; 2 physical-device tests ignored by default |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed |
| Desktop browser check | Chromium and WebKit passed with real S-DSP WASM |
| Offline transport stress | 21 scenarios recorded; production settings passed |
| Actual CPAL output | 30 seconds of silence, 0 underruns |
| macOS Apple Silicon app build | Passed; app launched |
| macOS Intel app build | Passed; cross-build, not launched |

## Browser and desktop adapters

[Browser record](desktop_browser_20261106.json) uses the actual Synth and
AudioWorklets with a mocked Tauri IPC host and muted speakers. It covers:

- Menu / Pin, native binary preset saving, cancelled save / reload / file
  selection and keyboard focus after menu use.
- SPC / audio / BRR menu operations, WAV conversion and preset reloading.
- Eight Wave voices, eight Noise envelopes, live Noise clock, four PMON pairs,
  Echo, waveform drawing, Master 380% and Pitch.
- SPC PMON pair extraction with captured modulator / carrier PITCH 2048 / 3072,
  independent envelopes, captured Echo and both BRR samples saved in v5 JSON.
- Web Audio / Native switching stops all held sources and resets Pitch while
  retaining the instrument and both samples. Performance is blocked during a
  switch; a native failure restores Web Audio safely.
- Finite captured stereo PCM at a mocked 48 kHz device with the actual nine
  credits / four-packet startup settings, one AudioContext, no page errors or
  missing assets, and zero horizontal overflow at 390px.

Desktop and narrow WebKit screenshots were inspected. Native-host interactions
in this report are simulated and do not establish physical-device behavior.

## Native output transport

The desktop capture resampler now uses compensated phase addition so rational
32-to-96 kHz conversion retains exact frame counts across render quanta. Its
tests compare PCM and frame counts rather than only checking for finite output.

The bounded pipeline has nine packet credits and still starts after four
packets: about 43 ms of startup PCM at 48 kHz with 512-frame packets. Its maximum
queued PCM is nine packets, about 96 ms at that rate. The extra credit provides
burst margin without increasing the startup threshold.

[Transport record](audio_transport_20261106.json) contains 21 modeled scenarios,
including 32 / 44.1 / 48 / 53.267 kHz input clocks, 128 / 512-frame bursts,
recurring 25 ms UI delays, device clock drift and slow IPC replies. Production
nine-credit settings retain zero modeled drops / underruns. The previous
eight-credit 32 kHz / 512-frame case is retained as a regression demonstrating
29 dropped frames over 30 seconds. Long stalls remain bounded and can discard
stale audio rather than growing the queue indefinitely.

The S-DSP renders at native 32 kHz, then the Synth resamples to its AudioContext
clock, usually 44.1 / 48 kHz. A 32 kHz capture scenario represents a possible
context rate; it is not an unresampled production DSP tap. These adapter fixes
are local to this desktop repository; other Synth repositories were unchanged.

## Physical CPAL service check

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline native_device_continuous -- --ignored --nocapture
```

The actual default CoreAudio output accepted 30 seconds of silence at 48 kHz.
It consumed 1,440,256 frames with **0 underruns**, including 29 injected 25 ms
producer delays. The longest observed producer write gap was 54.686375 ms.

[Physical-output record](native_audio_20261106.json). This directly tests the
Rust service. It does not test continuous WebView-to-native IPC, human listening
or background / pinned-window playback. The audible tone smoke test was not run.

## Native macOS apps

```sh
npm run build -- --bundles app --no-sign -- --locked --offline
npm run build -- --target x86_64-apple-darwin --bundles app --no-sign -- --locked --offline
```

Both apps were built with signing explicitly skipped:

- `src-tauri/target/release/bundle/macos/Tetorica S-DSP Synth.app` — arm64.
- `src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Tetorica S-DSP Synth.app` — x86_64.

The Apple Silicon app was launched. Its actual `tauri://localhost` window
exposed the S-DSP title, Menu / Pin, SPC PMON / Echo import options, source
controls and keyboard. This was an initial accessibility-tree inspection;
physical Pin toggling, file dialogs, device switching and listening were not
inferred from it. Native UI inspection was slow, so extended GUI testing was
kept separate from the browser evidence. The Intel app was not launched.

[Build record and input hashes](build_20261106.json).

## Remaining checks

- Human listening with representative SPC, BRR, WAV and saved v5 presets.
- Real app Menu / Pin interactions, native file dialogs and WebView-to-CPAL
  switching on the user's machine.
- Prolonged playback and background / pinned-window behavior.
- Hosted macOS / Windows / Linux builds and installers after the initial push.
  The workflow is configured for main-branch artifacts and v-tag draft releases.
- Signed / notarized distribution through exported credentials and
  `deploy_mac.sh`, when publishing is requested.

No stage, commit, push, tag, deploy or release action was performed. The
existing Git metadata and remote were preserved; the parent Web project and
other Tauri repositories were unchanged.
