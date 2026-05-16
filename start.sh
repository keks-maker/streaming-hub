#!/bin/bash

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="/home/keks/Dokumente/opencode/Streaming"

export ELECTRON_DISABLE_SANDBOX=1

# Clear corrupted service worker storage if present
SW_DIR="$HOME/.config/streaming-hub/Default/Service Worker"
if [ -d "$SW_DIR" ]; then
  rm -rf "$SW_DIR" 2>/dev/null
fi

cd "$APP_DIR"

npx electron .
