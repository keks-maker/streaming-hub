#!/bin/bash
# v0.3.6.

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd -P)"

export ELECTRON_DISABLE_SANDBOX=1

cd "$APP_DIR"

npm start
