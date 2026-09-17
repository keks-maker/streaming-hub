#!/bin/bash
# v0.3.7.
#
# Streaming Hub Installer
# =======================
# Installiert Streaming Hub (Castlabs Electron + Widevine) auf Linux (x86_64).
#
# Aufruf:
#   curl -fsSL http://192.168.4.105:3000/kekskarlo/Streaming-Hub/raw/branch/master/install.sh | bash
#
# Optional: Installationsverzeichnis via INSTALL_DIR=/pfad setzen

set -euo pipefail

REPO_URL="${STREAMING_HUB_REPO_URL:-http://192.168.4.105:3000/kekskarlo/Streaming-Hub.git}"
RAW_BASE="${STREAMING_HUB_RAW_BASE:-http://192.168.4.105:3000/kekskarlo/Streaming-Hub/raw/branch/master}"
MIN_NODE_MAJOR=22

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
if [ "$(uname)" != "Linux" ]; then
  error "Nur Linux wird unterstützt."
fi
if [ "$(uname -m)" != "x86_64" ]; then
  error "Nur x86_64 wird unterstützt (Architektur: $(uname -m))."
fi

# ------------------------------------------------------------------
# Paketmanager erkennen
# ------------------------------------------------------------------
PKG_MANAGER=""
INSTALL_CMD=""
UPDATE_CMD=""

if command -v apt &>/dev/null; then
  PKG_MANAGER="apt"
  UPDATE_CMD="$SUDO_CMD apt update -y"
  INSTALL_CMD="$SUDO_CMD apt install -y"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
  UPDATE_CMD="$SUDO_CMD dnf check-update -y || true"
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

# ------------------------------------------------------------------
# curl installieren (für NodeSource-Setup)
# ------------------------------------------------------------------
if ! command -v curl &>/dev/null; then
  info "Installiere curl …"
  $UPDATE_CMD
  $INSTALL_CMD curl
fi

# ------------------------------------------------------------------
# ca-certificates installieren (für HTTPS-Curls auf Minimal-Systemen)
# ------------------------------------------------------------------
# Prüfe ob HTTPS-curl funktioniert – nur bei Bedarf nachinstallieren
if ! curl -fsSL --connect-timeout 5 "https://github.com" >/dev/null 2>&1; then
  info "Installiere ca-certificates für HTTPS …"
  case $PKG_MANAGER in
    apt|dnf) $INSTALL_CMD ca-certificates ;;
    # pacman/zypper haben ca-certificates in der Basisinstallation
  esac
fi

# ------------------------------------------------------------------
# git installieren
# ------------------------------------------------------------------
if ! command -v git &>/dev/null; then
  info "Installiere git …"
  $UPDATE_CMD
  $INSTALL_CMD git
fi

# ------------------------------------------------------------------
# unzip installieren (wird für Electron-Binary-Extraktion benötigt)
# ------------------------------------------------------------------
if ! command -v unzip &>/dev/null; then
  info "Installiere unzip …"
  $UPDATE_CMD
  $INSTALL_CMD unzip
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
  esac
}

if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    warn "Node.js $(node -v) ist zu alt (>= $MIN_NODE_MAJOR benötigt). Führe Update durch …"
    install_nodejs
  else
    info "Node.js $(node -v) OK"
  fi
else
  info "Installiere Node.js $MIN_NODE_MAJOR.x …"
  $UPDATE_CMD
  install_nodejs
fi

# npm prüfen
if ! command -v npm &>/dev/null; then
  warn "npm nicht gefunden – installiere nach …"
  case $PKG_MANAGER in
    apt|dnf) $INSTALL_CMD npm ;;
    pacman)  $INSTALL_CMD npm ;;
    zypper)  $INSTALL_CMD nodejs22-npm ;;
  esac
fi

# ------------------------------------------------------------------
# Installationsverzeichnis
# ------------------------------------------------------------------
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/streaming-hub}"

if [ -d "$INSTALL_DIR/.git" ]; then
  # Bereits installiert – pull
  info "Aktualisiere vorhandene Installation in $INSTALL_DIR …"
  cd "$INSTALL_DIR"
  git fetch --tags --force origin 2>/dev/null || git fetch --tags origin
  LATEST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)
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
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ------------------------------------------------------------------
# npm-Abhängigkeiten
# ------------------------------------------------------------------
info "Installiere npm-Abhängigkeiten …"
cd "$INSTALL_DIR"

# --ignore-scripts: Das postinstall-Skript (install.js) nutzt extract-zip@2.0.1,
# welches mit Node.js >= 26 hängt (stream.pipeline + yauzl.openReadStream).
# Daher wird das Electron-Binary manuell via unzip extrahiert.
npm install --ignore-scripts

# Castlabs Electron-Binary manuell laden und extrahieren (Workaround)
ELECTRON_DIR="node_modules/electron"
DIST_DIR="$ELECTRON_DIR/dist"
PATH_FILE="$ELECTRON_DIR/path.txt"

if [ ! -f "$DIST_DIR/electron" ] && [ ! -f "$DIST_DIR/electron.exe" ] && [ ! -d "$DIST_DIR/Electron.app" ]; then
  info "Lade Electron-Binary (Castlabs) …"

  # @electron/get ist durch npm install bereits vorhanden
  echo "[install] Starte Download von Castlabs Electron …"
  ZIP_PATH=$(node -e "
    const { downloadArtifact } = require('@electron/get');
    downloadArtifact({
      version: require('./$ELECTRON_DIR/package').version,
      artifactName: 'electron',
      mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/' },
      platform: 'linux',
      arch: 'x64'
    }).then(p => console.log(p));
  ") || true

  if [ -n "$ZIP_PATH" ] && [ -f "$ZIP_PATH" ]; then
    info "Extrahiere Electron-Binary …"
    unzip -qo "$ZIP_PATH" -d "$DIST_DIR"
    printf "electron" > "$PATH_FILE"
    chmod +x "$DIST_DIR/electron" 2>/dev/null || true
    info "Electron-Binary bereit ($ZIP_PATH)"
  else
    error "Electron-Binary konnte nicht geladen werden.
  Siehe Fehlerausgabe oben. Mögliche Ursachen:
  - Keine Internetverbindung
  - Castlabs-Mirror nicht erreichbar (https://github.com/castlabs/electron-releases)
  - ca-certificates fehlen (wurden oben installiert, ggf. neue Session starten)"
  fi
fi

# ------------------------------------------------------------------
# Desktop-Eintrag
# ------------------------------------------------------------------
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

# Aktualisiere Desktop-Datenbank (falls vorhanden)
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "$HOME/.local/share/applications/" &>/dev/null || true
fi
info "Desktop-Eintrag: $DESKTOP_FILE"

# ------------------------------------------------------------------
# PATH-Symlink
# ------------------------------------------------------------------
mkdir -p "$HOME/.local/bin"
SYMLINK="$HOME/.local/bin/streaming-hub"
if [ -L "$SYMLINK" ] && [ "$(readlink "$SYMLINK")" != "$INSTALL_DIR/start.sh" ]; then
  rm "$SYMLINK"
fi
ln -sf "$INSTALL_DIR/start.sh" "$SYMLINK"

# Prüfen ob ~/.local/bin im PATH ist
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "$HOME/.local/bin ist nicht im PATH."
  warn '  Für die aktuelle Sitzung: export PATH="$HOME/.local/bin:$PATH"'
  warn '  Für dauerhafte Einrichtung: echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.bashrc'
fi

# ------------------------------------------------------------------
# Fertig
# ------------------------------------------------------------------
echo ""
header "Installation abgeschlossen!"
echo ""
info "Streaming Hub ist installiert in:  $INSTALL_DIR"
info "Starten mit:                      streaming-hub"
info "Oder über das Anwendungsmenü:     Streaming Hub"
echo ""
