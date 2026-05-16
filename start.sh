#!/bin/bash

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="/home/keks/Dokumente/opencode/Streaming"

export ELECTRON_DISABLE_SANDBOX=1

cd "$APP_DIR"

npx electron .
