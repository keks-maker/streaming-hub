#!/bin/bash

# Streaming Hub - Castlabs Electron mit Widevine DRM Support

APP_DIR="$(dirname "$(readlink -f "$0")")"

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
export ELECTRON_DISABLE_SANDBOX=1

# Clear stale cookies and caches (Google-Login-Fix)
PART_DIR="$HOME/.config/streaming-hub/Partitions/streaming"
if [ -d "$PART_DIR" ]; then
  rm -rf "$PART_DIR/Cookies" "$PART_DIR/Cookies-journal" \
         "$PART_DIR/Local Storage" "$PART_DIR/Session Storage" \
         "$PART_DIR/Service Worker" "$PART_DIR/Cache" \
         "$PART_DIR/Code Cache" "$PART_DIR/blob_storage" \
         "$PART_DIR/Shared Dictionary" "$PART_DIR/IndexedDB" \
         "$PART_DIR/SharedStorage" "$PART_DIR/DIPS" 2>/dev/null
fi

cd "$APP_DIR"

npx electron .
