# Streaming Hub

Zentrale Streaming-Anwendung mit Widevine-DRM-Unterstützung über Castlabs Electron. Bündelt beliebte Streaming-Dienste in einer einheitlichen Oberfläche mit benutzerdefiniertem Titel- und Navigationsleiste.

## Leistungsumfang

### Unterstützte Dienste

| Dienst | URL |
|---|---|
| Netflix | https://www.netflix.com |
| YouTube | https://www.youtube.com |
| Disney+ | https://www.disneyplus.com |
| Prime Video | https://www.primevideo.com |
| Twitch | https://www.twitch.tv |
| Spotify | https://open.spotify.com |

### Funktionen

- **Dienst-Navigation** – Icon-Leiste zum schnellen Wechseln zwischen Streaming-Anbietern
- **Browser-Navigation** – Zurück, Vorwärts und Neu-laden für jeden Dienst
- **Vollbildmodus** – Kompakte Leiste, ein-/ausblendbar per Klick oder `Escape`
- **Draggable Titlebar** – Fenster per Titelleiste verschiebbar (`-webkit-app-region: drag`)
- **Widevine DRM** – Castlabs Electron mit VMP-Support für geschützte Inhalte (Netflix, Disney+, Prime Video)
- **Chrome Widevine Fallback** – Nutzt systemweites Widevine CDM aus `/opt/google/chrome/WidevineCdm/` falls vorhanden
- **Service-Worker-Bereinigung** – Automatisches Löschen korrupter Service-Worker-Caches beim Start
- **Sandbox-Deaktivierung** – `ELECTRON_DISABLE_SANDBOX=1` für stabile Ausführung unter Linux
- **GPU-Optimierung** – Deaktivierte GPU-Beschleunigung für bessere Kompatibilität
- **Custom User-Agent** – Chrome-identischer User-Agent für maximale Seitenkompatibilität
- **Session-Persistenz** – Persistente Session-Partition (`persist:streaming`) pro Dienst
- **Permission-Handling** – Automatische Freigabe für Medien- und DRM-Anfragen
- **Willkommensbildschirm** – Übersichtlicher Startbildschirm mit Dienstauswahl
- **Dark-UI** – Dunkles Design mit Glasmorphismus-Effekten und anbieter-spezifischen Akzentfarben

## Abhängigkeiten

### Systemvoraussetzungen

| Abhängigkeit | Mindestversion | Zweck |
|---|---|---|
| **Node.js** | >= 18 | Laufzeitumgebung für Electron |
| **npm** | (kommt mit Node.js) | Paketmanager |

### NPM-Abhängigkeiten

| Paket | Version | Zweck |
|---|---|---|
| `electron` (castlabs) | `v42.0.0+wvcus` | DRM-fähiger Electron-Build von Castlabs mit Widevine CDM und VMP-Support |

### Optionale Abhängigkeiten

| Abhängigkeit | Zweck |
|---|---|
| **Google Chrome** (`/opt/google/chrome/WidevineCdm/`) | Systemweites Widevine CDM als Fallback für DRM-Inhalte |
| **@castlabs/evs** | Enterprise Verification Service für signierte Produktions-Builds |

## Installation

### 1. Node.js und npm installieren

**Arch Linux:**
```bash
sudo pacman -S nodejs npm
```

**Debian/Ubuntu:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Fedora:**
```bash
sudo dnf install -y nodejs npm
```

### 2. Projekt-Abhängigkeiten installieren

```bash
cd /home/keks/Dokumente/opencode/Streaming
npm install
```

### 3. Widevine CDM (optional, für Netflix/Disney+/Prime Video)

```bash
# Arch Linux
sudo pacman -S google-chrome

# Debian/Ubuntu
sudo apt-get install -y google-chrome-stable
```

### 4. Anwendung starten

```bash
./start.sh
# oder
npm start
```

## Projektstruktur

```
Streaming/
├── main.js              # Electron-Hauptprozess (Fenster, IPC, DRM-Konfiguration)
├── preload.js           # Preload-Skript für Hauptfenster (IPC-Brücke)
├── preload-content.js   # Preload-Skript für BrowserView-Inhalte
├── renderer.js          # Renderer-Prozess (UI-Logik, Event-Handler)
├── index.html           # Haupt-UI (Navigationsleiste, Toolbar, Willkommensbildschirm)
├── app.html             # Alternativer Willkommensbildschirm
├── styles.css           # Styling (Dark-UI, Glasmorphismus, Animationen)
├── setup-castlabs.js    # Castlabs-Einrichtungshilfsskript
├── start.sh             # Startskript mit Sandbox-Deaktivierung und SW-Bereinigung
├── package.json         # Projekt-Konfiguration und Abhängigkeiten
└── assets/
    └── icons/           # Dienst-Icons (netflix, youtube, disney, prime, twitch, spotify)
```

## Konfiguration

### Electron-Command-Line-Switches

| Switch | Zweck |
|---|---|
| `--no-sandbox` | Sandbox deaktivieren (Linux-Kompatibilität) |
| `--no-zygote` | Zygote-Prozess deaktivieren |
| `--disable-gpu` | GPU-Beschleunigung deaktivieren |
| `--disable-gpu-compositing` | GPU-Compositing deaktivieren |
| `--disable-software-rasterizer` | Software-Rasterizer deaktivieren |
| `--disable-service-worker-autostart` | Service Worker nicht automatisch starten |
| `--enable-features=PlatformEncryptedDolbyVision` | Dolby Vision Unterstützung |
| `--disable-features=HardwareMediaKeyHandling,MediaRouterProvider` | Medien-Tastenkonflikte vermeiden |

## EVS (Enterprise Verification Service)

Für Produktions-Builds mit vollem Netflix-Support:

1. Registrieren bei [castlabs.com/account/register](https://castlabs.com/account/register)
2. EVS installieren: `npm install -g @castlabs/evs`
3. Einrichten: `evs setup`
4. App bauen und signieren

## Lizenz

MIT
