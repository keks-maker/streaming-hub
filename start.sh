#!/bin/bash

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="$(cd "$(dirname "$0")" && pwd -P)"

export ELECTRON_DISABLE_SANDBOX=1

cd "$APP_DIR"

npm start
