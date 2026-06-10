# Hackintosh Setup – MSI B450M + Ryzen 5 3600 + RX 5700/5600 XT

> **Zweck:** macOS-Entwicklungsumgebung für Xcode + iOS/tvOS Development
> **Stand:** Juni 2026 (macOS Tahoe 26.x, Xcode 26.x)
> **Zielsystem:** StreamingHub iOS/tvOS App (iOS 18+, Swift 6.0)

---

## Hardware-Übersicht

| Komponente | Modell | Status |
|---|---|---|
| CPU | AMD Ryzen 5 3600 (Zen 2, 6 Kerne) | ✅ AMD Vanilla Patches |
| Mainboard | MSI B450M PRO-VDH MAX | ✅ Gut unterstützt |
| GPU | AMD Radeon RX 5700/5600 XT (Navi 10) | ✅ **Nativ** seit Catalina 10.15.1 |
| RAM | 16 GB DDR4 | ⚠️ Auf 32 GB aufrüsten empfohlen |
| Ethernet | Realtek RTL8111 | ✅ `RealtekRTL8111.kext` |
| Audio | AMD Starship/Matisse HD Audio | ✅ `AppleALC.kext` |
| NVMe | Kingston A2000 | ✅ |
| WLAN/BT | ❌ Nicht vorhanden | ❌ Fenvi FV-T919 oder BCM94360NG nötig |

---

## Benötigte Hardware-Upgrades

### 1. WiFi / Bluetooth – Pflicht (ca. 25–35 €)

**Warum:** Für iMessage, AirDrop, Handoff, Apple-ID-Anmeldung in Xcode.

| Option | Anschluss | Preis | AirDrop | iMessage |
|---|---|---|---|---|
| **Fenvi FV-T919** (BCM94360CD) | PCIe x1 | ~35 € | ✅ | ✅ |
| **BCM94360NG** (M.2 Key E) | M.2 Wifi-Slot | ~25 € | ✅ | ✅ |

Das Mainboard B450M PRO-VDH MAX hat einen **M.2 Key E Wifi-Slot** – die BCM94360NG könnte direkt passen.

### 2. RAM (empfohlen, ca. 30 €)

Ein weiterer 16 GB DDR4-Riegel (gleicher Takt wie vorhanden) → 32 GB Gesamt.
Xcode + iOS-Simulator belegen schnell 12–16 GB.

### 3. Separater Datenträger für macOS (optional, ca. 20 €)

Günstige 240 GB SATA-SSD für macOS. Schützt die Windows-Installation vor versehentlichem Überschreiben während der OpenCore-Installation.

---

## BIOS-Einstellungen (MSI B450M PRO-VDH MAX)

Beim Start **Entf** drücken → ins BIOS.

### Deaktivieren:
- **Fast Boot** → Disabled
- **Secure Boot** → Disabled
- **CSM (Compatibility Support Module)** → Disabled
- **IOMMU** → Disabled
- **Serial/COM Port** → Disabled
- **Parallel Port** → Disabled

### Aktivieren:
- **Above 4G Decoding** → Enabled
- **EHCI/XHCI Hand-off** → Enabled
- **SATA Mode** → AHCI
- **OS Type** → Windows 8.1/10 UEFI Mode (oder "Other OS")

---

## Anleitungen & Links

### 1. OpenCore Install Guide (offizielle Doku)

**Die Bibel für jeden Hackintosh.**

| Schritt | Link |
|---|---|
| **Start hier** | https://dortania.github.io/OpenCore-Install-Guide/ |
| **USB-Stick erstellen (unter Windows)** | https://dortania.github.io/OpenCore-Install-Guide/installer-guide/windows-install.html |
| **USB-Stick erstellen (unter Linux)** | https://dortania.github.io/OpenCore-Install-Guide/installer-guide/linux-install.html |
| **OpenCore Basis-Dateien** | https://dortania.github.io/OpenCore-Install-Guide/installer-guide/opencore-efi.html |
| **ACPI starten** | https://dortania.github.io/OpenCore-Install-Guide/amd/zen.html#acpi |
| **Kernel-Patches (AMD Vanilla)** | https://github.com/AMD-OSX/AMD_Vanilla |
| **config.plist Komplettguide AMD** | https://dortania.github.io/OpenCore-Install-Guide/AMD/zen.html |
| **BIOS-Einstellungen AMD** | https://dortania.github.io/OpenCore-Install-Guide/AMD/zen.html#amd-bios-settings |

### 2. GPUs – Kompatibilitätsliste

https://dortania.github.io/GPU-Buyers-Guide/

Deine RX 5700/5600 XT ist **Navi 10** – voll nativ unterstützt.

### 3. Kexts (Treiber) – AMD

| Kext | Wofür | Bezug |
|---|---|---|
| **Lilu.kext** | Grundlage für alle Patches | https://github.com/acidanthera/Lilu |
| **WhateverGreen.kext** | GPU-Fixes | https://github.com/acidanthera/WhateverGreen |
| **AppleALC.kext** | Onboard-Audio | https://github.com/acidanthera/AppleALC |
| **RealtekRTL8111.kext** | Ethernet | https://github.com/Mieze/RTL8111_driver_for_OS_X |
| **AMDRyzenCPUPowerManagement.kext** | CPU-Energiespar | https://github.com/trulyspinach/SMCAMDProcessor |
| **SMCAMDProcessor.kext** | Sensor-Monitoring | https://github.com/trulyspinach/SMCAMDProcessor |

### 4. Tools für die Einrichtung

| Tool | Wofür | Link |
|---|---|---|
| **ProperTree** | config.plist Editor | https://github.com/corpnewt/ProperTree |
| **GenSMBIOS** | Mac-Seriennummern generieren | https://github.com/corpnewt/GenSMBIOS |
| **OpenCore Configurator** | ❌ Nicht verwenden! | Führt zu fehlerhaften config.plists |
| **SSDTTime** | ACPI-Tabellen erstellen | https://github.com/corpnewt/SSDTTime |
| **USBToolbox** | USB-Map erstellen | https://github.com/USBToolBox/tool |

### 5. macOS-Image besorgen

**Echter Mac (oder Freund mit Mac):**
- macOS aus dem App Store laden
- Mit `createinstallmedia` auf USB schreiben

**Ohne Mac – gibberish (Linux):**
```bash
# macOS Image aus Apple-Softwareupdate-Katalog laden
https://github.com/acidanthera/OpenCorePkg/releases
```

### 6. SMBIOS (Mac-Modell wählen)

Empfohlen für AMD Ryzen:

| SMBIOS | Geeignet für |
|---|---|
| **MacPro7,1** | Polaris oder neuere GPUs ⭐ empfohlen |
| **iMacPro1,1** | NVIDIA oder alternative GPU |

SMBIOS-Daten mit GenSMBIOS generieren und in config.plist eintragen:
- `SystemProductName` → MacPro7,1
- `SystemSerialNumber` → (generiert, ungültig = Coverage-Check muss fehlschlagen)
- `MLB` → (generiert)
- `SystemUUID` → (generiert)

---

## Installations-Ablauf (Kurzfassung)

```
1. BIOS einstellen (siehe oben)
2. macOS-Installer-USB erstellen (Windows oder Linux)
3. OpenCore EFI-Ordner vorbereiten (mit ProperTree)
   ├── AMD Kernel-Patches einfügen (algrey Patches)
   ├── Core Count anpassen (6 Kerne → B8 06 00 00 00 00)
   ├── Kexts in EFI/OC/Kexts/
   ├── config.plist anpassen
   └── SMBIOS eintragen (MacPro7,1)
4. USB booten, macOS installieren
5. Nach der Installation: EFI auf interne SSD kopieren
6. Post-Install (WiFi, Audio, USB-Map)
7. Xcode installieren & iOS-Projekt bauen
```

### Core Count (für AMD Patches)

Ryzen 5 3600 = **6 Kerne** → 0x06

In den 4 algrey-Patches `cpuid_cores_per_package` ersetzen:
```
B8 06 00 00 00 00
BA 06 00 00 00 00
BA 06 00 00 00 90
BA 06 00 00 00
```

### Kext-Reihenfolge (wichtig!)

In `config.plist → Kernel → Add` in dieser Reihenfolge:
```
1. Lilu.kext
2. SMCAMDProcessor.kext
3. WhateverGreen.kext
4. AppleALC.kext
5. RealtekRTL8111.kext
6. AMDRyzenCPUPowerManagement.kext
```

---

## Nach der Installation (Post-Install)

| Aufgabe | Tool / Kext |
|---|---|
| **Audio testen** | AppleALC + Layout-ID ermitteln |
| **USB-Map erstellen** | USBToolbox |
| **WiFi aktivieren** | Fenvi FV-T919 = nativ, kein Kext nötig |
| **Energiespar-Optionen** | AMDRyzenCPUPowerManagement |
| **System-Updates** | Nur nach Bestätigung der Community updaten |
| **macOS Tahoe (26.x) Support** | https://dortania.github.io/OpenCore-Install-Guide/ |

---

## Xcode + iOS Entwicklung auf AMD Hackintosh

| Funktioniert | Ja/Nein | Hinweis |
|---|---|---|
| Xcode installieren | ✅ | Aus dem App Store |
| iOS/tvOS Simulator | ✅ | Läuft nativ |
| SwiftUI Previews | ✅ | Auf RX 5700 kein Problem |
| iPhone/iPad via USB debuggen | ✅ | |
| Apple TV via Netzwerk debuggen | ✅ | |
| App Archive + Organizer | ✅ | |
| App Store Connect Upload | ✅ | Xcode → Organizer → Distribute |
| TestFlight | ✅ | |
| Metal Performance | ✅ | RX 5700 ist nativ unterstützt |

### Wichtige Einschränkungen

- **Major-Updates (macOS 26→27):** 2–8 Wochen warten bis AMD-Patches aktualisiert sind
- **iMessage/FaceTime:** Braucht gültige SMBIOS-Seriennummer + kompatible WLAN-Karte
- **Xcode Beta-Versionen:** Können neuere macOS-Features voraussetzen → Vorsicht

---

## GitHub / Repositories (zum Lesezeichen)

- https://github.com/AMD-OSX/AMD_Vanilla – AMD Vanilla Patches
- https://github.com/acidanthera/OpenCorePkg – OpenCore Bootloader
- https://github.com/corpnewt/ProperTree – config.plist Editor
- https://github.com/trulyspinach/SMCAMDProcessor – AMD CPU + Sensor Kexts
- https://github.com/Mieze/RTL8111_driver_for_OS_X – Realtek Ethernet
- https://forum.amd-osx.com/ – AMD OS X Forum
- [/r/hackintosh](https://www.reddit.com/r/hackintosh/) – Reddit Community
