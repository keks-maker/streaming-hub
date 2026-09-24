#!/bin/bash
# v0.3.6.

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

SCRIPT="$0"
while [ -L "$SCRIPT" ]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT")" >/dev/null 2>&1 && pwd)"
  LINK_TARGET="$(readlink "$SCRIPT")"
  case "$LINK_TARGET" in
    /*) SCRIPT="$LINK_TARGET" ;;
    *) SCRIPT="$SCRIPT_DIR/$LINK_TARGET" ;;
  esac
done
APP_DIR="$(cd -P "$(dirname "$SCRIPT")" >/dev/null 2>&1 && pwd)"

cd "$APP_DIR"

npm start
