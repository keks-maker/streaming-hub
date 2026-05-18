#!/bin/bash

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="$(dirname "$(readlink -f "$0")")"

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
export ELECTRON_DISABLE_SANDBOX=1



cd "$APP_DIR"

npx electron .
