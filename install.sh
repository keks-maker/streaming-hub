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
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}→${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }
header(){ echo -e "${CYAN}==${NC} $* ${CYAN}==${NC}"; }

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
    case "$MACHINE_ARCH" in
      x86_64|amd64) ELECTRON_ARCH="x64" ;;
      arm64|aarch64) ELECTRON_ARCH="arm64" ;;
      *) error "Nicht unterstützte macOS-Architektur: $MACHINE_ARCH." ;;
    esac
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
# git installieren
# ------------------------------------------------------------------
if ! command -v git &>/dev/null; then
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

if [ -d "$INSTALL_DIR/.git" ]; then
  # Bereits installiert – pull
  info "Aktualisiere vorhandene Installation in $INSTALL_DIR …"
  cd "$INSTALL_DIR"
  git fetch --tags --force origin 2>/dev/null || git fetch --tags origin
  LATEST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)
  # Tag-Nachzieh-Absicherung: Wenn nach dem Fetch immer noch kein Tag lokal
  # liegt (partieller Fetch/abweichende Refspecs), gezielt nachholen — sonst
  # fällt die Versionsanzeige auf ein altes Tag (User-Befund 01.10.).
  if [ -z "$LATEST_TAG" ]; then
    git fetch origin '+refs/tags/*:refs/tags/*' --force 2>/dev/null || true
    LATEST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)
  fi
  # Stash lokale Änderungen (history/services/tvsources), force-checkout, restore
  git stash --include-untracked 2>/dev/null || true
  if [ -n "$LATEST_TAG" ]; then
    git checkout --force "$LATEST_TAG" 2>/dev/null || { git checkout master && git pull; }
  else
    git pull
  fi
  git stash pop 2>/dev/null || true
else
  # Neuinstallation
  if [ -d "$INSTALL_DIR" ]; then
    warn "Verzeichnis $INSTALL_DIR existiert, ist aber kein Git-Repo."
    warn "Bitte entfernen oder leeren: rm -rf $INSTALL_DIR"
    exit 1
  fi
  info "Klone Repository nach $INSTALL_DIR …"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  # --no-single-branch: Der Clone braucht die vollen Historie+Tags, damit
  # git tag/describe nach Updates die richtige Version melden (ein
  # single-branch-Clone ohne Tags zeigte sonst alte Versionen an).
  git clone --no-single-branch "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ------------------------------------------------------------------
# npm-Abhängigkeiten
# ------------------------------------------------------------------
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
# ffmpeg/ffprobe (Aufnahme-Feature, Konzept §2.2 — Spike-Ergebnis 2026-09)
# ------------------------------------------------------------------
# Die Binaries werden MIT der App ausgeliefert (statische Builds, Release
# b6.1.1 = ffmpeg 7.0.2, SHA-256-gepinnt in lib/ffmpeg.js) — kein
# "bitte ffmpeg via Homebrew/apt nachinstallieren". Vorhandene, gesunde
# Binaries bleiben unangetastet (schneller Pfad); fehlende werden geladen.
info "Prüfe gebündelte ffmpeg/ffprobe-Binaries …"
node "$INSTALL_DIR/bin/ensure-ffmpeg.js" || error "ffmpeg-Bündelung fehlgeschlagen.

  Die Aufnahme-Funktion benötigt ffmpeg/ffprobe im App-Verzeichnis
  ($INSTALL_DIR/bin/). Ursache siehe Ausgabe oben (Netzwerk/Prüfsumme).
  Lösung: Installer erneut ausführen oder beschädigte Dateien in
  $INSTALL_DIR/bin/ löschen."

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
  rm -rf "$APP_BUNDLE"
  ditto "$DIST_DIR/Electron.app" "$APP_BUNDLE"
  APP_PLIST="$APP_BUNDLE/Contents/Info.plist"
  plutil -replace CFBundleName -string "Streaming Hub" "$APP_PLIST"
  plutil -replace CFBundleDisplayName -string "Streaming Hub" "$APP_PLIST"
  plutil -replace CFBundleIdentifier -string "com.streaming-hub.app" "$APP_PLIST"
  plutil -replace CFBundleVersion -string "$APP_VERSION" "$APP_PLIST"
  plutil -replace CFBundleShortVersionString -string "$APP_VERSION" "$APP_PLIST"
  plutil -replace CFBundleIconFile -string "AppIcon.icns" "$APP_PLIST"
  plutil -replace LSApplicationCategoryType -string "public.app-category.video" "$APP_PLIST"
  ln -s "$INSTALL_DIR" "$APP_RESOURCES/app"
  if [ -f "$INSTALL_DIR/assets/icon.icns" ]; then
    cp "$INSTALL_DIR/assets/icon.icns" "$APP_RESOURCES/AppIcon.icns"
  elif [ -f "$APP_RESOURCES/electron.icns" ]; then
    cp "$APP_RESOURCES/electron.icns" "$APP_RESOURCES/AppIcon.icns"
  fi

  # ------------------------------------------------------------------
  # EVS/VMP-Signierung — die castlabs-Widevine-CDM registriert sich nur
  # in Bundles mit gültiger EVS-"streaming"-Signatur. Ohne sie: Netflix
  # E100, Disney+-Fehler 83, Prime 403 (CDM init fail).
  # sign-pkg erwartet ein Verzeichnis, das die *.app enthält (glob auf
  # {dir}/*.app) — isoliertes Staging-Verzeichnis, damit keine fremde
  # App aus ~/Applications erwischt wird.
  # ------------------------------------------------------------------
  EVS_PY="${EVS_PYTHON:-$HOME/evs-venv/bin/python3}"
  if [ ! -x "$EVS_PY" ]; then
    EVS_PY="$(command -v python3 || true)"
  fi
  if [ -n "$EVS_PY" ] && "$EVS_PY" -c "import castlabs_evs" >/dev/null 2>&1; then
    info "EVS/VMP-Signierung des App-Bundles (Widevine) …"
    EVS_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/streaming-hub-evs.XXXXXX")"
    ln -sfn "$APP_BUNDLE" "$EVS_STAGE/Streaming Hub.app"
    if ! "$EVS_PY" -m castlabs_evs.vmp sign-pkg "$EVS_STAGE"; then
      rm -rf "$EVS_STAGE"
      error "EVS sign-pkg fehlgeschlagen — Widevine wird nicht funktionieren (siehe Ausgabe oben)."
    fi
    if ! "$EVS_PY" -m castlabs_evs.vmp verify-pkg "$EVS_STAGE"; then
      rm -rf "$EVS_STAGE"
      error "EVS verify-pkg fehlgeschlagen — Signatur ungültig, Widevine wird nicht funktionieren."
    fi
    rm -rf "$EVS_STAGE"
    info "EVS-Signatur gültig (verify-pkg: streaming)."
  else
    warn "castlabs-evs nicht gefunden — DRM-Dienste (Netflix/Disney+/Prime) werden NICHT funktionieren."
    warn "Einrichtung: python3 -m pip install castlabs-evs  &&  evs-account signup && evs-account confirm-signup"
  fi
  info "App-Bundle: $APP_BUNDLE"
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
