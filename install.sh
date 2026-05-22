#!/bin/bash
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

REPO_URL="http://192.168.4.105:3000/kekskarlo/Streaming-Hub.git"
RAW_BASE="http://192.168.4.105:3000/kekskarlo/Streaming-Hub/raw/branch/master"
MIN_NODE_MAJOR=22

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}→${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }
header(){ echo -e "${CYAN}==${NC} $* ${CYAN}==${NC}"; }

# ------------------------------------------------------------------
# Root-Check: nur im Home-Verzeichnis installieren
# ------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  error "Bitte nicht als root ausführen. Installation erfolgt im Benutzerverzeichnis."
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
  UPDATE_CMD="apt update -y"
  INSTALL_CMD="apt install -y"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
  UPDATE_CMD="dnf check-update -y || true"
  INSTALL_CMD="dnf install -y"
elif command -v pacman &>/dev/null; then
  PKG_MANAGER="pacman"
  UPDATE_CMD="pacman -Sy --noconfirm"
  INSTALL_CMD="pacman -S --noconfirm"
elif command -v zypper &>/dev/null; then
  PKG_MANAGER="zypper"
  UPDATE_CMD="zypper refresh"
  INSTALL_CMD="zypper install -y"
else
  error "Kein unterstützter Paketmanager gefunden (apt, dnf, pacman, zypper)."
fi

info "Paketmanager: $PKG_MANAGER"

# ------------------------------------------------------------------
# git installieren
# ------------------------------------------------------------------
if ! command -v git &>/dev/null; then
  info "Installiere git …"
  $UPDATE_CMD
  $INSTALL_CMD git
fi

# ------------------------------------------------------------------
# Node.js prüfen / installieren
# ------------------------------------------------------------------
install_nodejs() {
  case $PKG_MANAGER in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt install -y nodejs
      ;;
    dnf)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
      dnf install -y nodejs
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
  git fetch --tags origin
  LATEST_TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)
  if [ -n "$LATEST_TAG" ]; then
    git checkout "$LATEST_TAG" 2>/dev/null || git pull
  else
    git pull
  fi
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
npm install

# Castlabs Electron-Binary nachladen
npx electron --version &>/dev/null || true

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
