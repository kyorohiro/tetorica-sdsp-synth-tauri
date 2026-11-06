#!/bin/sh
set -eu
# Export APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID
# in your shell before running the signed and notarized macOS builds.
export CI=true

npx tauri build --target x86_64-apple-darwin --bundles app,dmg -- --locked
npx tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked
