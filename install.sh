#!/bin/bash
# v0.3.7.
#
# Streaming Hub Installer
# =======================
# Installiert Streaming Hub (Castlabs Electron + Widevine) auf Linux und macOS.
#
# Aufruf:
#   curl -fsSL https://raw.githubusercontent.com/keks-maker/streaming-hub/main/install.sh | bash
#
# Optional: Installationsverzeichnis via INSTALL_DIR=/pfad setzen

set -euo pipefail

REPO_URL="${STREAMING_HUB_REPO_URL:-https://github.com/keks-maker/streaming-hub.git}"
RAW_BASE="${STREAMING_HUB_RAW_BASE:-https://raw.githubusercontent.com/keks-maker/streaming-hub/main}"
RELEASES_API_URL="${STREAMING_HUB_RELEASES_API_URL:-https://api.github.com/repos/keks-maker/streaming-hub/releases}"
INSTALL_SOURCE="${STREAMING_HUB_SOURCE:-release}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}→${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }
header(){ echo -e "${CYAN}==${NC} $* ${CYAN}==${NC}"; }

for arg in "$@"; do
  case "$arg" in
    --source=git) INSTALL_SOURCE="git" ;;
    --source=release) INSTALL_SOURCE="release" ;;
    *) error "Unbekannte Option: $arg (verwende --source=git oder --source=release)." ;;
  esac
done
case "$INSTALL_SOURCE" in
  release|git) ;;
  *) error "Ungültige Quelle: $INSTALL_SOURCE (erlaubt: release, git)." ;;
esac

# ------------------------------------------------------------------
# Sudo / Root-Erkennung
# ------------------------------------------------------------------
SUDO_CMD=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo &>/dev/null; then
    SUDO_CMD="sudo"
  elif command -v doas &>/dev/null; then
    SUDO_CMD="doas"
  else
    # Weder root noch sudo/doas – die Paketinstallation wird später fehlschlagen,
    # aber wir lassen es erstmal laufen (der User kann abbrechen).
    warn "Weder root noch sudo/doas gefunden – Paketinstallation wird vermutlich fehlschlagen."
  fi
fi

header "Streaming Hub Installer"

# ------------------------------------------------------------------
# OS / Arch
# ------------------------------------------------------------------
# >>> arch-helpers (von tests/install-arch.test.js extrahiert und ausgefuehrt)
# Normalisiert Architektur-Namen auf arm64 | x64; leer bei unbekanntem Wert.
normalize_arch() {
  case "$1" in
    arm64|aarch64) echo "arm64" ;;
    x64|x86_64|amd64) echo "x64" ;;
    *) echo "" ;;
  esac
}

# Architektur des Macs (Hardware, nicht der Shell). In einer Rosetta-Shell meldet uname -m
# x86_64 auf Apple-Silicon-Hardware; hw.optional.arm64 ist dort trotzdem 1 und korrigiert das.
# Override fuer Tests: STREAMING_HUB_ARCH=arm64|x64.
detect_mac_arch() {
  local raw arch
  if [ -n "${STREAMING_HUB_ARCH:-}" ]; then
    arch="$(normalize_arch "$STREAMING_HUB_ARCH")"
    [ -n "$arch" ] || return 1
    echo "$arch"
    return 0
  fi
  raw="$(uname -m)"
  arch="$(normalize_arch "$raw")"
  [ -n "$arch" ] || return 1
  if [ "$arch" = "x64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi
  echo "$arch"
}

# Prueft, ob die Mach-O-Datei $1 (thin oder universal) Code fuer die Architektur $2 (arm64|x64) enthaelt.
macho_matches_arch() {
  local info token
  case "$2" in
    arm64) token="arm64" ;;
    x64) token="x86_64" ;;
    *) return 1 ;;
  esac
  [ -f "$1" ] || return 1
  info="$(file -b "$1" 2>/dev/null || true)"
  case "$info" in
    *Mach-O*) ;;
    *) return 1 ;;
  esac
  case "$info" in
    *"$token"*) return 0 ;;
    *) return 1 ;;
  esac
}
# <<< arch-helpers

OS="$(uname -s)"
MACHINE_ARCH="$(uname -m)"
PKG_MANAGER=""
INSTALL_CMD=""
UPDATE_CMD=""

case "$OS" in
  Linux)
    case "$MACHINE_ARCH" in
      x86_64|amd64) ELECTRON_ARCH="x64" ;;
      *) error "Unterstützt wird unter Linux nur x86_64 (Architektur: $MACHINE_ARCH)." ;;
    esac
    ELECTRON_PLATFORM="linux"
    ;;
  Darwin)
    ELECTRON_ARCH="$(detect_mac_arch)" || error "Nicht unterstützte macOS-Architektur: ${STREAMING_HUB_ARCH:-$MACHINE_ARCH} (erlaubt: arm64, x64)."
    ELECTRON_PLATFORM="darwin"
    ;;
  *)
    error "Nicht unterstütztes Betriebssystem: $OS (unterstützt: Linux, macOS)."
    ;;
esac

if [ "$OS" = "Linux" ]; then
  if command -v apt &>/dev/null; then
    PKG_MANAGER="apt"
    UPDATE_CMD="$SUDO_CMD apt update -y"
    INSTALL_CMD="$SUDO_CMD apt install -y"
  elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
    UPDATE_CMD="$SUDO_CMD dnf makecache"
    INSTALL_CMD="$SUDO_CMD dnf install -y"
  elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
    UPDATE_CMD="$SUDO_CMD pacman -Sy --noconfirm"
    INSTALL_CMD="$SUDO_CMD pacman -S --noconfirm"
  elif command -v zypper &>/dev/null; then
    PKG_MANAGER="zypper"
    UPDATE_CMD="$SUDO_CMD zypper refresh"
    INSTALL_CMD="$SUDO_CMD zypper install -y"
  else
    error "Kein unterstützter Paketmanager gefunden (apt, dnf, pacman, zypper)."
  fi
  info "Paketmanager: $PKG_MANAGER"
elif command -v brew &>/dev/null; then
  PKG_MANAGER="brew"
  info "Paketmanager: Homebrew"
else
  info "macOS erkannt; vorhandene Systemwerkzeuge werden verwendet."
fi

# ------------------------------------------------------------------
# curl installieren (für NodeSource-Setup)
# ------------------------------------------------------------------
if ! command -v curl &>/dev/null; then
  if [ "$OS" = "Linux" ]; then
    info "Installiere curl …"
    $UPDATE_CMD
    $INSTALL_CMD curl
  else
    error "curl fehlt. Bitte installiere die macOS Command Line Tools oder curl."
  fi
fi

# ------------------------------------------------------------------
# ca-certificates installieren (für HTTPS-Curls auf Minimal-Systemen)
# ------------------------------------------------------------------
if [ "$OS" = "Linux" ] && ! curl -fsSL --connect-timeout 5 "https://github.com" >/dev/null 2>&1; then
  info "Installiere ca-certificates für HTTPS …"
  case $PKG_MANAGER in
    apt|dnf) $INSTALL_CMD ca-certificates ;;
  esac
fi

# ------------------------------------------------------------------
# git installieren (nur im expliziten Entwicklungs-/Checkout-Modus)
# ------------------------------------------------------------------
if [ "$INSTALL_SOURCE" = "git" ] && ! command -v git &>/dev/null; then
  if [ "$OS" = "Linux" ]; then
    info "Installiere git …"
    $UPDATE_CMD
    $INSTALL_CMD git
  else
    error "git fehlt. Bitte installiere die macOS Command Line Tools."
  fi
fi

# ------------------------------------------------------------------
# unzip installieren (wird für Electron-Binary-Extraktion benötigt)
# ------------------------------------------------------------------
if [ "$OS" = "Linux" ] && ! command -v unzip &>/dev/null; then
  info "Installiere unzip …"
  $UPDATE_CMD
  $INSTALL_CMD unzip
fi
if [ "$OS" = "Darwin" ] && ! command -v tar &>/dev/null; then
  error "tar fehlt; es wird für die Electron-Binary-Extraktion benötigt."
fi

# ------------------------------------------------------------------
# Node.js prüfen / installieren
# ------------------------------------------------------------------
install_nodejs() {
  case $PKG_MANAGER in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO_CMD bash -
      $SUDO_CMD apt install -y nodejs
      ;;
    dnf)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO_CMD bash -
      $SUDO_CMD dnf install -y nodejs
      ;;
    pacman)
      $INSTALL_CMD nodejs npm
      ;;
    zypper)
      $INSTALL_CMD nodejs22 nodejs22-npm
      ;;
    brew)
      if brew list --versions node >/dev/null 2>&1; then
        brew upgrade node
      else
        brew install node
      fi
      ;;
    *)
      error "Node.js >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR wird benötigt. Installiere Node.js und starte den Installer erneut."
      ;;
  esac
}

if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/^v//')
  NODE_MAJOR=${NODE_VERSION%%.*}
  NODE_MINOR=${NODE_VERSION#*.}
  NODE_MINOR=${NODE_MINOR%%.*}
  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
    warn "Node.js $(node -v) ist zu alt (>= $MIN_NODE_MAJOR.$MIN_NODE_MINOR benötigt). Führe Update durch …"
    if [ "$OS" = "Linux" ]; then
      $UPDATE_CMD
    fi
    install_nodejs
  else
    info "Node.js $(node -v) OK"
  fi
else
  info "Installiere Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR oder neuer …"
  if [ "$OS" = "Linux" ]; then
    $UPDATE_CMD
  fi
  install_nodejs
fi

# npm prüfen
if ! command -v npm &>/dev/null; then
  warn "npm nicht gefunden – installiere nach …"
  case $PKG_MANAGER in
    apt|dnf|pacman) $INSTALL_CMD npm ;;
    zypper) $INSTALL_CMD nodejs22-npm ;;
    brew) brew install node ;;
    *) error "npm fehlt. Bitte Node.js inklusive npm installieren." ;;
  esac
fi

# ------------------------------------------------------------------
# Installationsverzeichnis
# ------------------------------------------------------------------
if [ -z "${INSTALL_DIR:-}" ]; then
  if [ "$OS" = "Darwin" ]; then
    INSTALL_DIR="$HOME/Library/Application Support/Streaming Hub"
  else
    INSTALL_DIR="$HOME/.local/share/streaming-hub"
  fi
fi

RELEASE_MODE=0
RELEASE_VERSION=""
RELEASE_APP=""
RELEASE_TMP=""
RELEASE_INSTALL_STAGE=""
APP_BUNDLE_STAGE=""
cleanup_staging() {
  if [ -n "${RELEASE_TMP:-}" ]; then rm -rf "$RELEASE_TMP"; fi
  if [ -n "${APP_BUNDLE_STAGE:-}" ]; then rm -rf "$APP_BUNDLE_STAGE"; fi
}
trap cleanup_staging EXIT
if [ "$INSTALL_SOURCE" = "git" ]; then
  if [ "$OS" = "Darwin" ]; then
    info "Entwicklungs-/Checkout-Modus aktiviert (--source=git)."
  fi
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Aktualisiere vorhandene Git-Installation in $INSTALL_DIR …"
    cd "$INSTALL_DIR"
    git fetch --tags --force origin 2>/dev/null || git fetch --tags origin
    git stash --include-untracked 2>/dev/null || true
    git checkout --force master 2>/dev/null || git checkout --force main
    git pull --ff-only
    git stash pop 2>/dev/null || true
  else
    if [ -d "$INSTALL_DIR" ]; then
      warn "Verzeichnis $INSTALL_DIR existiert, ist aber kein Git-Repo."
      warn "Bitte entfernen oder leeren: rm -rf $INSTALL_DIR"
      exit 1
    fi
    info "Klone Repository nach $INSTALL_DIR …"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
else
  if [ "$OS" != "Darwin" ]; then
    error "GitHub-Release-Assets sind macOS-Apps. Unter Linux explizit --source=git verwenden."
  fi
  RELEASE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/streaming-hub-release.XXXXXX")"
  RELEASE_LIB="$RELEASE_TMP/github-releases.js"
  RELEASE_HELPER="$RELEASE_TMP/select-release.js"
  curl -fsSL "$RAW_BASE/lib/github-releases.js" -o "$RELEASE_LIB" || error "Release-Kriterien konnten nicht geladen werden."
  cat > "$RELEASE_HELPER" <<'NODE'
'use strict';
const { fetchReleaseCandidates, resolveTarget } = require(process.argv[2]);
const apiUrl = process.argv[3];
const target = process.argv[4];
if (typeof resolveTarget !== 'function') {
  console.error('Release-Kriterien sind veraltet (keine Plattform-Kategorien).');
  process.exit(3);
}
fetchReleaseCandidates(fetch, apiUrl, target).then(candidates => {
  const candidate = candidates.at(-1);
  if (!candidate) process.exitCode = 2;
  else process.stdout.write(JSON.stringify(candidate));
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE
  RELEASE_TARGET="darwin-$ELECTRON_ARCH"
  RELEASE_STATUS=0
  RELEASE_JSON="$(node "$RELEASE_HELPER" "$RELEASE_LIB" "$RELEASES_API_URL" "$RELEASE_TARGET")" || RELEASE_STATUS=$?
  if [ "$RELEASE_STATUS" != "0" ]; then
    if [ "$RELEASE_STATUS" = "3" ]; then
      error "Die geladenen Release-Kriterien sind veraltet (keine Plattform-Kategorien). Es wurde nichts installiert."
    fi
    if [ "$RELEASE_STATUS" = "2" ] && [ "$ELECTRON_ARCH" = "x64" ]; then
      error "Für Intel-Macs (x64) gibt es noch kein Release. Es wird bewusst kein arm64-Release installiert."
    fi
    error "Kein gültiges GitHub-Release für macOS $ELECTRON_ARCH gefunden (draft/prerelease, Tag oder Asset fehlen). Es gibt keinen Fallback auf Git-Tags oder andere Architekturen."
  fi
  RELEASE_VERSION="$(node -p 'JSON.parse(process.argv[1]).version' "$RELEASE_JSON")"
  RELEASE_URL="$(node -p 'JSON.parse(process.argv[1]).asset.browserDownloadUrl' "$RELEASE_JSON")"
  RELEASE_ZIP="$RELEASE_TMP/$(node -p 'JSON.parse(process.argv[1]).asset.name' "$RELEASE_JSON")"
  RELEASE_STAGE="$RELEASE_TMP/extracted"
  info "Installiere GitHub-Release v$RELEASE_VERSION (macOS $ELECTRON_ARCH) …"
  curl -fL --retry 3 --proto '=https' --tlsv1.2 "$RELEASE_URL" -o "$RELEASE_ZIP" || error "Release-Asset konnte nicht geladen werden."
  mkdir -p "$RELEASE_STAGE"
  unzip -q "$RELEASE_ZIP" -d "$RELEASE_STAGE" || error "Release-Asset ist kein gültiges ZIP-Archiv."
  RELEASE_APP="$(find "$RELEASE_STAGE" -type d -name '*.app' -print -quit)"
  [ -n "$RELEASE_APP" ] || error "Release-Asset enthält kein macOS-App-Bundle."
  RELEASE_EXEC_NAME="$(plutil -extract CFBundleExecutable raw -o - "$RELEASE_APP/Contents/Info.plist" 2>/dev/null || true)"
  RELEASE_EXEC="$RELEASE_APP/Contents/MacOS/${RELEASE_EXEC_NAME:-Streaming Hub}"
  macho_matches_arch "$RELEASE_EXEC" "$ELECTRON_ARCH" || error "Das Release-Asset enthält kein Programm für diese Architektur ($ELECTRON_ARCH): $(file -b "$RELEASE_EXEC" 2>/dev/null || echo 'Hauptprogramm nicht lesbar'). Es wurde nichts installiert."

  EVS_PY="${EVS_PYTHON:-$HOME/evs-venv/bin/python3}"
  if [ ! -x "$EVS_PY" ]; then EVS_PY="$(command -v python3 || true)"; fi
  if [ -n "$EVS_PY" ] && "$EVS_PY" -c "import castlabs_evs" >/dev/null 2>&1; then
    info "Prüfe EVS/VMP-Signatur des Release-Assets …"
    "$EVS_PY" -m castlabs_evs.vmp verify-pkg "$(dirname "$RELEASE_APP")" || error "EVS-Signaturprüfung des Release-Assets fehlgeschlagen."
  else
    info "Prüfe codesign-Signatur des Release-Assets …"
    codesign --verify --deep --strict "$RELEASE_APP" || error "Keine gültige macOS-Signatur im Release-Asset."
  fi

  RELEASE_APP_SOURCE="$RELEASE_APP/Contents/Resources/app"
  if [ -d "$RELEASE_APP_SOURCE" ]; then
    : # Neue Releases mit asar:false verwenden das erwartete Verzeichnis.
  elif [ -f "$RELEASE_APP/Contents/Resources/app.asar" ]; then
    # Bereits veröffentlichte 0.5.x-ZIPs enthalten noch app.asar. Für
    # Rückwärtskompatibilität entpacken wir sie in dasselbe Staging-Layout.
    info "Entpacke legacy app.asar in das Installations-Staging …"
    RELEASE_APP_SOURCE="$RELEASE_TMP/app-unpacked"
    npx --yes @electron/asar@3.4.1 extract "$RELEASE_APP/Contents/Resources/app.asar" "$RELEASE_APP_SOURCE" || error "Legacy app.asar konnte nicht entpackt werden."
  else
    error "Release-App enthält weder Contents/Resources/app noch app.asar."
  fi
  # So zerstört ein fehlendes codesign/EVS die bestehende Installation nicht.
  mkdir -p "$(dirname "$INSTALL_DIR")"
  RELEASE_INSTALL_STAGE="$RELEASE_TMP/install-stage"
  mkdir -p "$RELEASE_INSTALL_STAGE"
  RELEASE_USER_BACKUP="$RELEASE_TMP/user-backup"
  mkdir -p "$RELEASE_USER_BACKUP"
  for user_file in services.json tvsources.json history.json; do
    [ -f "$INSTALL_DIR/$user_file" ] && cp -p "$INSTALL_DIR/$user_file" "$RELEASE_USER_BACKUP/$user_file"
  done
  ditto "$RELEASE_APP_SOURCE" "$RELEASE_INSTALL_STAGE"
  for user_file in services.json tvsources.json history.json; do
    [ -f "$RELEASE_USER_BACKUP/$user_file" ] && cp -p "$RELEASE_USER_BACKUP/$user_file" "$RELEASE_INSTALL_STAGE/$user_file"
  done
  RELEASE_MODE=1
  cd "$RELEASE_INSTALL_STAGE"
fi

# ------------------------------------------------------------------
# npm-Abhängigkeiten und Build (nur Git-Quellmodus; Releases sind bereits gebaut)
# ------------------------------------------------------------------
if [ "$RELEASE_MODE" = "0" ]; then
  info "Installiere npm-Abhängigkeiten …"
  cd "$INSTALL_DIR"

  npm install --include=dev --ignore-scripts

  ELECTRON_DIR="node_modules/electron"
  DIST_DIR="$ELECTRON_DIR/dist"
  PATH_FILE="$ELECTRON_DIR/path.txt"
  if [ "$OS" = "Darwin" ]; then
    ELECTRON_EXECUTABLE="Electron.app/Contents/MacOS/Electron"
  else
    ELECTRON_EXECUTABLE="electron"
  fi

  if [ ! -f "$DIST_DIR/$ELECTRON_EXECUTABLE" ]; then
    info "Lade Electron-Binary (Castlabs, $ELECTRON_PLATFORM/$ELECTRON_ARCH) …"
    ZIP_PATH=$(node -e "
      const { downloadArtifact } = require('@electron/get');
      downloadArtifact({
        version: require('./$ELECTRON_DIR/package').version,
        artifactName: 'electron',
        mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/' },
        platform: '$ELECTRON_PLATFORM',
        arch: '$ELECTRON_ARCH'
      }).then(p => console.log(p));
    ") || true

    if [ -n "$ZIP_PATH" ] && [ -f "$ZIP_PATH" ]; then
      info "Extrahiere Electron-Binary …"
      mkdir -p "$DIST_DIR"
      if [ "$OS" = "Darwin" ]; then
        tar -xkf "$ZIP_PATH" -C "$DIST_DIR"
      else
        unzip -qo "$ZIP_PATH" -d "$DIST_DIR"
      fi
      printf "%s" "$ELECTRON_EXECUTABLE" > "$PATH_FILE"
      chmod +x "$DIST_DIR/$ELECTRON_EXECUTABLE" 2>/dev/null || true
      info "Electron-Binary bereit ($ZIP_PATH)"
    else
      error "Electron-Binary konnte nicht geladen werden.
  Siehe Fehlerausgabe oben. Mögliche Ursachen:
  - Keine Internetverbindung
  - Castlabs-Mirror nicht erreichbar (https://github.com/castlabs/electron-releases)
  - Netzwerk oder Zertifikate prüfen"
    fi
  fi

  info "Baue Laufzeitdateien …"
  npm run build:all

  # ------------------------------------------------------------------
  # ffmpeg/ffprobe (Aufnahme-Feature)
  # ------------------------------------------------------------------
  info "Prüfe gebündelte ffmpeg/ffprobe-Binaries …"
  node "$INSTALL_DIR/bin/ensure-ffmpeg.js" || error "ffmpeg-Bündelung fehlgeschlagen.

  Die Aufnahme-Funktion benötigt ffmpeg/ffprobe im App-Verzeichnis
  ($INSTALL_DIR/bin/). Ursache siehe Ausgabe oben (Netzwerk/Prüfsumme).
  Lösung: Installer erneut ausführen oder beschädigte Dateien in
  $INSTALL_DIR/bin/ löschen."
fi

# ------------------------------------------------------------------
# Desktop-Eintrag
# ------------------------------------------------------------------
if [ "$OS" = "Linux" ]; then
  DESKTOP_FILE="$HOME/.local/share/applications/streaming-hub.desktop"
  mkdir -p "$(dirname "$DESKTOP_FILE")"

  cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=Streaming Hub
Comment=Zentrale Streaming-Anwendung mit Widevine-DRM
Exec=$INSTALL_DIR/start.sh
Icon=$INSTALL_DIR/assets/icon.svg
Terminal=false
Type=Application
Categories=AudioVideo;Network;
StartupWMClass=Streaming Hub
MimeType=x-scheme-handler/streaming-hub;
EOF

  if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$HOME/.local/share/applications/" &>/dev/null || true
  fi
  info "Desktop-Eintrag: $DESKTOP_FILE"
else
  APP_BUNDLE="$HOME/Applications/Streaming Hub.app"
  APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
  APP_VERSION=$(node -p "require('./package.json').version")
  mkdir -p "$HOME/Applications"
  APP_BUNDLE_STAGE="$HOME/Applications/.Streaming Hub.app.stage.$$"
  rm -rf "$APP_BUNDLE_STAGE"
  if [ "$RELEASE_MODE" = "1" ]; then
    ditto "$RELEASE_APP" "$APP_BUNDLE_STAGE"
    # Das Release-Staging wird nach dem Signieren nach INSTALL_DIR verschoben
    # und der Temp-Pfad danach vom EXIT-Trap gelöscht; der Symlink muss deshalb
    # dauerhaft auf das finale Installationsverzeichnis zeigen.
    APP_LINK_TARGET="$INSTALL_DIR"
  else
    ditto "$DIST_DIR/Electron.app" "$APP_BUNDLE_STAGE"
    APP_LINK_TARGET="$INSTALL_DIR"
  fi
  APP_STAGE_RESOURCES="$APP_BUNDLE_STAGE/Contents/Resources"
  APP_STAGE_PLIST="$APP_BUNDLE_STAGE/Contents/Info.plist"
  # Release-Modus: Das Build-Bundle trägt Name/Identifier/Version/Kategorie/Icon
  # bereits korrekt. Nur bei Abweichung wird die Info.plist angepasst (jede
  # Änderung bricht das Siegel; der Nicht-Release-Pfad setzt immer).
  PLIST_NEEDS_UPDATE=1
  if [ "$RELEASE_MODE" = "1" ]; then
    PLIST_NEEDS_UPDATE=0
    for kv in "CFBundleName=Streaming Hub" "CFBundleDisplayName=Streaming Hub" \
      "CFBundleIdentifier=com.streaming-hub.app" "CFBundleVersion=$APP_VERSION" \
      "CFBundleShortVersionString=$APP_VERSION" "LSApplicationCategoryType=public.app-category.video"; do
      [ "$(plutil -extract "${kv%%=*}" raw -o - "$APP_STAGE_PLIST" 2>/dev/null)" = "${kv#*=}" ] || PLIST_NEEDS_UPDATE=1
    done
  fi
  if [ "$PLIST_NEEDS_UPDATE" = "1" ]; then
    plutil -replace CFBundleName -string "Streaming Hub" "$APP_STAGE_PLIST"
    plutil -replace CFBundleDisplayName -string "Streaming Hub" "$APP_STAGE_PLIST"
    plutil -replace CFBundleIdentifier -string "com.streaming-hub.app" "$APP_STAGE_PLIST"
    plutil -replace CFBundleVersion -string "$APP_VERSION" "$APP_STAGE_PLIST"
    plutil -replace CFBundleShortVersionString -string "$APP_VERSION" "$APP_STAGE_PLIST"
    plutil -replace LSApplicationCategoryType -string "public.app-category.video" "$APP_STAGE_PLIST"
  fi
  rm -rf "$APP_STAGE_RESOURCES/app"
  ln -s "$APP_LINK_TARGET" "$APP_STAGE_RESOURCES/app"
  # Icon-Konsistenz: CFBundleIconFile darf nur auf eine existierende Datei in
  # Resources zeigen. Die Logik (Quelle assets/icon.icns aus dem Install-Staging,
  # Fallback auf Builder-.icns, Pointer-Garantie) liegt testbar in
  # scripts/stage-mac-icon.js (Regressionstest: tests/mac-icon-consistency.test.js).
  # Wichtig: RELEASE_INSTALL_STAGE als Quelle — nicht $APP_LINK_TARGET/$INSTALL_DIR,
  # das wird erst NACH dem Signieren ersetzt (Regression aus v0.5.18, e5def7a).
  ICON_FILE="$(plutil -extract CFBundleIconFile raw -o - "$APP_STAGE_PLIST" 2>/dev/null || true)"
  ICON_FILE="${ICON_FILE%.icns}.icns"
  if [ "$RELEASE_MODE" = "1" ] && [ "$ICON_FILE" != ".icns" ] && [ -f "$APP_STAGE_RESOURCES/$ICON_FILE" ]; then
    info "Release-Bundle hat bereits ein konsistentes Icon ($ICON_FILE) — unverändert."
  else
    MAC_ICON_SCRIPT="$(pwd)/scripts/stage-mac-icon.js"
    [ -f "$MAC_ICON_SCRIPT" ] || MAC_ICON_SCRIPT="$INSTALL_DIR/scripts/stage-mac-icon.js"
    [ -f "$MAC_ICON_SCRIPT" ] || error "scripts/stage-mac-icon.js fehlt im Release-Paket (erwartet: $MAC_ICON_SCRIPT); Installation abgebrochen, bestehende Installation bleibt erhalten."
    if ! node "$MAC_ICON_SCRIPT" "$APP_BUNDLE_STAGE" "$APP_LINK_TARGET" "$RELEASE_INSTALL_STAGE"; then
      error "App-Icon konnte nicht konsistent ins Bundle gestagt werden; bestehende Installation bleibt erhalten."
    fi
  fi

  # ------------------------------------------------------------------
  # EVS/VMP-Signierung — die castlabs-Widevine-CDM registriert sich nur
  # in Bundles mit gültiger EVS-"streaming"-Signatur. Ohne sie: Netflix
  # E100, Disney+-Fehler 83, Prime 403 (CDM init fail).
  # Die Prüfung läuft auf dem vollständig veränderten Staging-Bundle,
  # bevor INSTALL_DIR oder das bestehende Finder-Bundle ersetzt werden.
  # ------------------------------------------------------------------
  EVS_PY="${EVS_PYTHON:-$HOME/evs-venv/bin/python3}"
  if [ ! -x "$EVS_PY" ]; then
    EVS_PY="$(command -v python3 || true)"
  fi
  if [ -n "$EVS_PY" ] && "$EVS_PY" -c "import castlabs_evs" >/dev/null 2>&1; then
    info "EVS/VMP-Signierung des App-Bundles (Widevine) …"
    EVS_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/streaming-hub-evs.XXXXXX")"
    ln -sfn "$APP_BUNDLE_STAGE" "$EVS_STAGE/Streaming Hub.app"
    if ! "$EVS_PY" -m castlabs_evs.vmp sign-pkg "$EVS_STAGE"; then
      rm -rf "$EVS_STAGE"
      error "EVS sign-pkg fehlgeschlagen — Installation abgebrochen; bestehende Installation bleibt erhalten."
    fi
    if ! "$EVS_PY" -m castlabs_evs.vmp verify-pkg "$EVS_STAGE"; then
      rm -rf "$EVS_STAGE"
      error "EVS verify-pkg fehlgeschlagen — Installation abgebrochen; bestehende Installation bleibt erhalten."
    fi
    rm -rf "$EVS_STAGE"
    info "EVS-Signatur gültig (verify-pkg: streaming)."
  else
    warn "EVS (castlabs_evs) nicht verfügbar — DRM-Dienste (Netflix, Disney+, Prime Video) können eingeschränkt sein (Widevine benötigt EVS-Signatur)."
    if ! command -v codesign >/dev/null 2>&1; then
      error "Installation abgebrochen: weder castlabs-evs noch codesign verfügbar; bestehende Installation bleibt erhalten."
    fi
    # Die obigen Änderungen (Info.plist, Resources/app-Symlink, Icon) brechen das
    # Siegel des Release-Bundles. Wie die Release-Pipeline (afterPack-Hook)
    # daher ad-hoc neu signieren und erst danach verifizieren. Ohne --strict, da
    # Resources/app bewusst auf das Installationsverzeichnis außerhalb des Bundles
    # zeigt (--strict lehnt solche Symlinks ab; EVS verify-pkg tut das nicht).
    info "Signiere App-Bundle ad-hoc neu (codesign) …"
    if ! codesign --force --deep --sign - "$APP_BUNDLE_STAGE"; then
      error "Installation abgebrochen: ad-hoc codesign fehlgeschlagen; bestehende Installation bleibt erhalten."
    fi
    if ! codesign --verify --deep "$APP_BUNDLE_STAGE"; then
      error "Installation abgebrochen: finale codesign-Signatur ungültig; bestehende Installation bleibt erhalten."
    fi
    info "codesign-Signatur gültig."
  fi

  # Erst nach erfolgreicher Prüfung werden Support-Verzeichnis und Wrapper
  # ersetzt. Bis hierhin wurde die bestehende Installation nicht verändert.
  if [ "$RELEASE_MODE" = "1" ]; then
    rm -rf "$INSTALL_DIR"
    mv "$RELEASE_INSTALL_STAGE" "$INSTALL_DIR"
    RELEASE_INSTALL_STAGE=""
  fi
  rm -rf "$APP_BUNDLE"
  mv "$APP_BUNDLE_STAGE" "$APP_BUNDLE"
  APP_BUNDLE_STAGE=""
  APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
fi

# ------------------------------------------------------------------
# PATH-Symlink
# ------------------------------------------------------------------
mkdir -p "$HOME/.local/bin"
SYMLINK="$HOME/.local/bin/streaming-hub"
if [ -L "$SYMLINK" ] && [ "$(readlink "$SYMLINK")" != "$INSTALL_DIR/start.sh" ]; then
  rm "$SYMLINK"
fi
ln -sf "$INSTALL_DIR/start.sh" "$SYMLINK"

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "$HOME/.local/bin ist nicht im PATH."
  warn '  Für die aktuelle Sitzung: export PATH="$HOME/.local/bin:$PATH"'
  if [ "$OS" = "Darwin" ]; then
    warn '  Für dauerhafte Einrichtung: echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.zshrc'
  else
    warn '  Für dauerhafte Einrichtung: echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.bashrc'
  fi
fi

# ------------------------------------------------------------------
# Fertig
# ------------------------------------------------------------------
echo ""
header "Installation abgeschlossen!"
echo ""
info "Streaming Hub ist installiert in:  $INSTALL_DIR"
info "Starten mit:                      streaming-hub"
if [ "$OS" = "Darwin" ]; then
  info "Oder über:                        $HOME/Applications/Streaming Hub.app"
else
  info "Oder über das Anwendungsmenü:     Streaming Hub"
fi
echo ""
