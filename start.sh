#!/bin/bash
# v0.3.6.

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd -P)"

cd "$APP_DIR"

npm start
