#!/bin/bash
# vm-install-test.sh — Install- und Update-Test von Streaming Hub in einer frischen macOS-VM (tart).
#
# Aufruf: scripts/vm-install-test.sh [--base nonode|node24|both] [--scenario install|update|updatenew|archcheck|both|all]
#                                    [--from-version X.Y.Z]      (Default: both / both / 0.9.0)
# Voraussetzung: ~/.local/bin/sh-vm (tart-Helfer), Basis-VMs base-nonode, base-node24, Netz in der VM.
# Es läuft NUR in einem Klon (immer per trap gelöscht); die lokale Installation wird nie berührt.
# Exit: 0 = alles PASS/SKIP, 1 = mindestens ein FAIL, 2 = Aufruf-/Umgebungsfehler.
#
# Install: install.sh aus dem aktuellen Repo-Stand wird per scp hochgeladen und ausgeführt (neuestes
#   echtes GitHub-Release). Prüft Exit-Code, ~/Applications/Streaming Hub.app, codesign --verify --deep,
#   Symlink Resources/app -> Installationsverzeichnis, package.json/main.js, Version (package.json ==
#   Info.plist == neuestes Release) und App-Start-Smoke (Binary direkt, 8 s, Prozess lebt, kein neuer
#   Crash-Report in ~/Library/Logs/DiagnosticReports).
#   Base nonode (kein Node, kein brew): install.sh darf ohne Rückfrage mit klarer Node-Meldung abbrechen
#   und nichts installieren (= PASS, Befund "kein Node-Auto-Install ohne Homebrew").
#
# Update: (1) alte Version --from-version per install.sh installieren (Release-Auswahl über
#   STREAMING_HUB_RELEASES_API_URL; eine auf diese Version gefilterte API-Antwort wird in der VM per
#   nc auf 127.0.0.1:8123 ausgeliefert). (2) Echter Update-Pfad der App: der INSTALLIERTE (alte) updater.js
#   wird per node geladen (require.main-Guard) und wie im 'apply'-Handler benutzt: Release über die echte
#   API wählen, Asset laden, unzip, findAppBundle, verifyMacBundle, installMacBundle(bundle, Support-Dir).
#   (3) gleiche Prüfungen wie Install + Version == neuestes Release. Nicht abgedeckt: Fork-/IPC-Schicht
#   der App (Renderer-Dialog, process.send), EVS-Signatur (kein castlabs_evs), Neustart nach Update,
#   GUI/Gatekeeper-Dialoge, Widevine-Wiedergabe. Base nonode: SKIP (ohne Node kein Update-Pfad).
#
# Archcheck (nur mit --scenario archcheck|all): siehe scenario_archcheck (Intel-Fehlermeldung des Installers).
#   install.sh laeuft in der VM mit der lib/github-releases.js des Repo-Stands (STREAMING_HUB_RAW_BASE=file://).
#
# Updatenew (nur mit --scenario updatenew|all): wie Update, aber der Updater-Code des REPO-STANDS (updater.js,
#   logger.js, lib/) wird per tar nach /tmp/newupd hochgeladen und anstelle des installierten updater.js
#   benutzt (belegt die Fixes in 0.9.4: otool-Fallback ohne CLT, ad-hoc Re-Sign nach Resources/app-Symlink).
#   Start-Version per --from-version (Default in diesem Szenario: 0.9.3). GRENZE: Ziel ist das neueste ECHTE
#   Release; ist das gleich der Startversion (z. B. 0.9.3 -> 0.9.3), ist es eine Neuinstallation derselben
#   Version, kein Versionssprung. Eine 0.9.4-Variante lässt sich nicht lokal erzeugen (Release-ZIP ist
#   signiert; Umversionieren bräche das Siegel). Die Fixes werden am Installationsvorgang (installMacBundle +
#   codesign/Start-Smoke) belegt, nicht an einem echten Versionssprung. Weitere Grenzen wie bei Update.
set -u
cd "$(dirname "$0")/.." || exit 2
SHVM="$HOME/.local/bin/sh-vm"
BASE=both; SCEN=both; FROM=0.9.0; FROM_SET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2;;
    --scenario) SCEN="${2:-}"; shift 2;;
    --from-version) FROM="${2:-}"; FROM_SET=1; shift 2;;
    *) echo "Unbekannte Option: $1" >&2; exit 2;;
  esac
done
case "$BASE" in nonode|node24|both) ;; *) echo "--base: nonode|node24|both" >&2; exit 2;; esac
case "$SCEN" in install|update|updatenew|archcheck|both|all) ;; *) echo "--scenario: install|update|updatenew|archcheck|both|all" >&2; exit 2;; esac
[[ "$FROM" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--from-version muss X.Y.Z sein" >&2; exit 2; }
[ -x "$SHVM" ] || { echo "sh-vm fehlt: $SHVM" >&2; exit 2; }
command -v node >/dev/null || { echo "node (Host) fehlt" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sh-vm-test.XXXXXX")"
VM=""
cleanup() { stop_vm; rm -rf "$WORK"; }
trap cleanup EXIT
trap 'echo "Abbruch" >&2; exit 130' INT TERM

# Release-Liste vom Host: neueste Version + auf FROM gefilterte API-Antwort
curl -fsSL 'https://api.github.com/repos/keks-maker/streaming-hub/releases?per_page=100' -o "$WORK/releases.json" || { echo "GitHub-API nicht erreichbar" >&2; exit 2; }
LATEST="$(node -e '
const {findReleaseCandidates}=require("./lib/github-releases.js");
const c=findReleaseCandidates(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));
process.stdout.write(c.at(-1)?.version||"")' "$WORK/releases.json")"
[ -n "$LATEST" ] || { echo "Kein gültiges Release gefunden" >&2; exit 2; }
make_from() { # $1 = Version -> $WORK/from.json (auf diese Version gefilterte API-Antwort)
node -e '
const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).filter(x=>x.tag_name==="v"+process.argv[2]);
fs.writeFileSync(process.argv[3],JSON.stringify(r));' "$WORK/releases.json" "$1" "$WORK/from.json"
[ "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).length' "$WORK/from.json")" = 1 ] || { echo "Release v$1 nicht gefunden" >&2; return 2; }
}
# Optional (nur Update/Updatenew): lokales, noch unveröffentlichtes Release-ZIP als Ziel (VMT_LOCAL_ZIP=Pfad,
# VMT_LOCAL_VERSION=X.Y.Z). Der Updater lädt es per file://; install.sh erzwingt https und nutzt es nicht.
if [ -n "${VMT_LOCAL_ZIP:-}" ]; then
  [ -f "$VMT_LOCAL_ZIP" ] && [[ "${VMT_LOCAL_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VMT_LOCAL_ZIP/VMT_LOCAL_VERSION ungültig" >&2; exit 2; }
  LATEST="$VMT_LOCAL_VERSION"
fi
make_from "$FROM" || exit 2
echo "Neuestes Release: v$LATEST, Update-Start: v$FROM"

RESULTS=(); FAILS=0
record() { RESULTS+=("$1|$2|$3|$4"); [ "$2" = FAIL ] && FAILS=$((FAILS+1)); echo "  => $1: $2 — $3"; }
R() { "$SHVM" ssh "$VM" "bash -s" 2>&1; }          # Skript aus stdin in der VM ausführen
PRE='export PATH=/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin;'

start_vm() { VM="tsh-$(date +%H%M%S)-$1"; "$SHVM" up "base-$1" "$VM" >"$WORK/up.log" 2>&1 || { cat "$WORK/up.log" >&2; "$SHVM" down "$VM" >/dev/null 2>&1; VM=""; return 1; }; }
stop_vm() { [ -n "$VM" ] && { "$SHVM" down "$VM" >/dev/null 2>&1 || { sleep 3; "$SHVM" down "$VM" >/dev/null 2>&1; }; }; VM=""; }

# Prüfungen am installierten Stand; $1 = erwartete Version. Letzte Zeile = Fehlertext (leer = ok).
verify_install() {
  R <<EOF | grep -a '^RESULT:' | tail -n 1 | sed 's/^RESULT://'
$PRE
APP="\$HOME/Applications/Streaming Hub.app"; DIR="\$HOME/Library/Application Support/Streaming Hub"; err=""
[ -d "\$APP" ] || { echo "RESULT:Bundle fehlt"; exit 0; }
codesign --verify --deep "\$APP" >/dev/null 2>&1 || err="\$err codesign-verify;"
LINK="\$(readlink "\$APP/Contents/Resources/app")"; [ "\$LINK" = "\$DIR" ] || err="\$err symlink(\$LINK);"
for f in package.json main.js; do [ -f "\$DIR/\$f" ] || err="\$err \$f-fehlt;"; done
PV="\$(node -p 'require(process.argv[1]).version' "\$DIR/package.json" 2>/dev/null)"
BV="\$(plutil -extract CFBundleShortVersionString raw -o - "\$APP/Contents/Info.plist" 2>/dev/null)"
[ "\$PV" = "$1" ] || err="\$err package.json=\$PV(erwartet $1);"
[ "\$BV" = "$1" ] || err="\$err plist=\$BV(erwartet $1);"
CR="\$HOME/Library/Logs/DiagnosticReports"; mkdir -p "\$CR"; before="\$(ls "\$CR" | wc -l)"
( nohup "\$APP/Contents/MacOS/Streaming Hub" >/tmp/sh-smoke.log 2>&1 & echo \$! >/tmp/sh-smoke.pid ) 2>/dev/null
PID="\$(cat /tmp/sh-smoke.pid)"; sleep 8
if kill -0 \$PID 2>/dev/null; then kill \$PID 2>/dev/null; sleep 2; kill -9 \$PID 2>/dev/null; else err="\$err app-beendet(\$(tail -n 3 /tmp/sh-smoke.log | tr '\n' ' '));"; fi
after="\$(ls "\$CR" | wc -l)"; [ "\$after" -le "\$before" ] || err="\$err crash-report(\$(ls -t "\$CR" | head -1));"
echo "RESULT:\$err"
EOF
}

run_install_sh() { # $1 = Log, $2 = Vorspann (Env/Server) in der VM
  "$SHVM" scp "$VM" install.sh /tmp/install.sh >/dev/null 2>&1 || { echo 99; return; }
  # install.sh laedt lib/github-releases.js sonst von main; der Repo-Stand muss mit der passenden lib laufen.
  "$SHVM" scp "$VM" lib/github-releases.js /tmp/github-releases.js >/dev/null 2>&1 || { echo 99; return; }
  R <<EOF >"$1"
$PRE
mkdir -p /tmp/rawbase/lib && cp /tmp/github-releases.js /tmp/rawbase/lib/github-releases.js
export STREAMING_HUB_RAW_BASE=file:///tmp/rawbase
$2
bash /tmp/install.sh </dev/null; echo "INSTALL_EXIT=\$?"
EOF
  grep -o 'INSTALL_EXIT=[0-9]*' "$1" | tail -1 | cut -d= -f2
}
tail_log() { grep -v '^INSTALL_EXIT' "$1" | grep -iE '✗|error|fehl|⚠|warn|benötigt' | tail -3 | tr '\n' ' '; }

scenario_install() { # $1 = base
  local b=$1 log="$WORK/inst-$1.log" ec err
  echo "[install/$b] install.sh (Repo-Stand) in VM …"
  ec="$(run_install_sh "$log" "")"
  if [ "$b" = nonode ]; then
    if [ "$ec" != 0 ] && grep -q 'Node.js >= .* wird benötigt' "$log" && ! R <<<'test -e "$HOME/Applications/Streaming Hub.app"' >/dev/null 2>&1; then
      record install PASS "klarer Abbruch ohne Node/brew (Exit $ec), nichts installiert, keine Rückfrage" "$b"
    else
      record install FAIL "Exit ${ec:-?}, erwartet klarer Node-Abbruch: $(tail_log "$log")" "$b"
    fi
    return
  fi
  [ "$ec" = 0 ] || { record install FAIL "install.sh Exit ${ec:-?}: $(tail_log "$log")" "$b"; tail -n 8 "$log"; return; }
  err="$(verify_install "$LATEST")"
  if [ -z "${err// /}" ]; then record install PASS "v$LATEST installiert, codesign/Symlink/Version/Start-Smoke ok" "$b"; else record install FAIL "$err" "$b"; fi
}

run_update() { # $1 = Vorspann (z. B. otool-Stub)
  R <<EOF
$PRE
$1
DIR="\$HOME/Library/Application Support/Streaming Hub"
cd "\${UPD_DIR:-\$DIR}" && STREAMING_HUB_UPDATER_LOG=/tmp/updater.log node -e '
const fs=require("fs"),os=require("os"),path=require("path"),cp=require("child_process");
const u=require(path.join(process.cwd(),"updater.js"));
const {fetchReleaseCandidates}=require(path.join(process.cwd(),"lib/github-releases.js"));
(async()=>{
  const rel=process.env.LOCAL_ZIP?{version:process.argv[1],asset:{name:"local.zip",browserDownloadUrl:"file://"+process.env.LOCAL_ZIP}}:(await fetchReleaseCandidates()).find(c=>c.version===process.argv[1]);
  if(!rel) throw new Error("Release nicht gefunden");
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"sh-upd-")),zip=path.join(tmp,rel.asset.name),ex=path.join(tmp,"extract");
  fs.mkdirSync(ex);
  cp.execFileSync("curl",["-fsSL","--retry","3",rel.asset.browserDownloadUrl,"-o",zip]);
  cp.execFileSync("unzip",["-q",zip,"-d",ex]);
  const bundle=u.findAppBundle(ex); if(!bundle) throw new Error("kein .app im Asset");
  u.verifyMacBundle(bundle,ex);
  u.installMacBundle(bundle,process.env.HOME+"/Library/Application Support/Streaming Hub");
  fs.rmSync(tmp,{recursive:true,force:true}); console.log("UPDATE_OK");
})().catch(e=>{console.error("UPDATE_FEHLER: "+(e.stack||e.message));process.exit(1)})' "$LATEST"
echo "UPDATE_EXIT=\$?"; tail -n 5 /tmp/updater.log 2>/dev/null
EOF
}

# nc liefert die auf die Startversion gefilterte Release-Liste (Schleife, da install.sh/Node je 1 Request sendet)
SERVE_FROM='( while true; do { printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n" "$(wc -c </tmp/from.json | tr -d " ")"; cat /tmp/from.json; } | nc -l 127.0.0.1 8123 >/dev/null 2>&1; done ) >/dev/null 2>&1 &
sleep 1
export STREAMING_HUB_RELEASES_API_URL=http://127.0.0.1:8123/releases'

# Archcheck: arm64-Installer mit gefaelschter x64-Arch (STREAMING_HUB_ARCH) und einer Liste OHNE x64-Release
# (nur das arm64-Release v$FROM) muss klar abbrechen, ohne das arm64-Asset zu installieren.
scenario_archcheck() { # $1 = base
  local b=$1 log="$WORK/arch-$1.log" ec
  if [ "$b" = nonode ]; then record archcheck SKIP "ohne Node kein Release-Pfad" "$b"; return; fi
  make_from "$FROM" || { record archcheck FAIL "Release v$FROM nicht gefunden" "$b"; return; }
  "$SHVM" scp "$VM" "$WORK/from.json" /tmp/from.json >/dev/null 2>&1
  echo "[archcheck/$b] install.sh mit STREAMING_HUB_ARCH=x64, Liste ohne x64-Release …"
  ec="$(run_install_sh "$log" "$SERVE_FROM
export STREAMING_HUB_ARCH=x64")"
  R <<<'pkill -f "nc -l 127.0.0.1 8123"; true' >/dev/null
  if [ "$ec" != 0 ] && grep -q 'Für Intel-Macs (x64) gibt es noch kein Release' "$log" && ! grep -q 'Installiere GitHub-Release' "$log" \
     && ! R <<<'test -e "$HOME/Applications/Streaming Hub.app"' >/dev/null 2>&1; then
    record archcheck PASS "klare Intel-Meldung (Exit $ec), kein arm64-Fallback, nichts installiert" "$b"
  else
    record archcheck FAIL "Exit ${ec:-?}, erwartet Intel-Abbruch ohne Installation: $(tail_log "$log")" "$b"
  fi
}

scenario_updatenew() { MODE=new scenario_update "$1"; }
scenario_update() { # $1 = base; MODE=new -> Updater des Repo-Stands statt des installierten
  local b=$1 log="$WORK/upd-$1.log" ec err out sc=update upre="" FROM=$FROM
  if [ "${MODE:-old}" = new ]; then
    sc=updatenew
    [ "$FROM_SET" = 1 ] || FROM=0.9.3
    make_from "$FROM" || { record $sc FAIL "Release v$FROM nicht gefunden" "$b"; return; }
  fi
  if [ "$b" = nonode ]; then record $sc SKIP "ohne Node kein Install/Update-Pfad" "$b"; return; fi
  echo "[update/$b] v$FROM installieren (API-Override) …"
  "$SHVM" scp "$VM" "$WORK/from.json" /tmp/from.json >/dev/null 2>&1
  ec="$(run_install_sh "$log" "$SERVE_FROM")"
  R <<<'pkill -f "nc -l 127.0.0.1 8123"; true' >/dev/null
  [ -n "${VMT_KEEP_LOG:-}" ] && cp "$log" "$VMT_KEEP_LOG"
  [ "$ec" = 0 ] || { record $sc FAIL "Start-Install v$FROM: Exit ${ec:-?}: $(tail_log "$log")" "$b"; return; }
  err="$(verify_install "$FROM")"
  if [ -n "${err// /}" ]; then record $sc FAIL "Vorbedingung v$FROM kaputt: $err" "$b"; return; fi
  if [ "$sc" = updatenew ]; then
    tar -cf "$WORK/newupd.tar" updater.js logger.js lib || { record $sc FAIL "tar des Repo-Updaters fehlgeschlagen" "$b"; return; }
    "$SHVM" scp "$VM" "$WORK/newupd.tar" /tmp/newupd.tar >/dev/null 2>&1
    R <<<'rm -rf /tmp/newupd && mkdir /tmp/newupd && tar -xf /tmp/newupd.tar -C /tmp/newupd' >/dev/null
    upre='UPD_DIR=/tmp/newupd'
    echo "[update/$b] Updater des Repo-Stands (neu): v$FROM -> v$LATEST …"
  else
    echo "[update/$b] echter Update-Pfad (updater.js aus v$FROM): v$FROM -> v$LATEST …"
  fi
  if [ -n "${VMT_LOCAL_ZIP:-}" ]; then
    "$SHVM" scp "$VM" "$VMT_LOCAL_ZIP" /tmp/local.zip >/dev/null 2>&1 || { record $sc FAIL "lokales ZIP nicht in die VM kopierbar" "$b"; return; }
    upre="$upre
export LOCAL_ZIP=/tmp/local.zip"
  fi
  local note=""
  out="$(run_update "$upre")"
  if ! { echo "$out" | grep -q 'UPDATE_OK' && echo "$out" | grep -q 'UPDATE_EXIT=0'; }; then
    local why; why="$(echo "$out" | grep -E 'UPDATE_FEHLER|rror' | head -2 | tr '\n' ' ' | cut -c1-110)"
    if [ "$sc" = update ] && echo "$out" | grep -q 'otool' && ! R <<<'xcode-select -p' >/dev/null 2>&1; then
      # Befund: updater.js prüft mit otool -L; ohne Command Line Tools ist otool nur ein Shim, das scheitert.
      out="$(run_update "$upre"'mkdir -p /tmp/stub && printf "#!/bin/sh\nexit 0\n" >/tmp/stub/otool && chmod +x /tmp/stub/otool; export PATH=/tmp/stub:$PATH;')"
      if echo "$out" | grep -q 'UPDATE_OK' && echo "$out" | grep -q 'UPDATE_EXIT=0'; then
        note=" [BEFUND: Updater scheitert ohne Xcode-CLT an otool; mit otool-Stub läuft der Rest]"
      fi
    fi
    if [ -z "$note" ]; then record $sc FAIL "Update-Pfad: $why" "$b"; return; fi
    err="$(verify_install "$LATEST")"
    record $sc FAIL "otool ohne CLT: $why$note; Folgeprüfung: ${err:-ok}" "$b"; return
  fi
  err="$(verify_install "$LATEST")"
  if [ -z "${err// /}" ]; then record $sc PASS "v$FROM -> v$LATEST (installMacBundle), codesign/Symlink/Version/Start-Smoke ok" "$b"; else record $sc FAIL "nach Update: $err" "$b"; fi
}

BASES=(); case "$BASE" in both) BASES=(nonode node24);; *) BASES=("$BASE");; esac
for b in "${BASES[@]}"; do
  for s in install update updatenew archcheck; do
    case "$SCEN" in all) ;; both) [ "$s" != updatenew ] && [ "$s" != archcheck ] || continue;; *) [ "$SCEN" = "$s" ] || continue;; esac
    echo "== $s / $b: VM starten =="
    start_vm "$b" || { record "$s" FAIL "VM-Start fehlgeschlagen" "$b"; continue; }
    "scenario_$s" "$b"
    stop_vm
  done
done

echo; echo "Szenario  Base    Ergebnis  Grund"
for r in "${RESULTS[@]}"; do IFS='|' read -r s res why b <<<"$r"; printf '%-9s %-7s %-9s %s\n' "$s" "$b" "$res" "$why"; done
[ "$FAILS" = 0 ] || { echo "FAIL: $FAILS"; exit 1; }
echo "Alles PASS/SKIP"; exit 0
