#!/bin/bash
# Baut, signiert und notarisiert StreamingHubSync.app (Mac-Hilfs-App für den iCloud-Abgleich, D10).
#   scripts/build-sync-helper.sh [--sign-only] [--no-notarize]
# Ergebnis: native/StreamingHubSync/dist/StreamingHubSync-<version>.zip (Release-Asset, gestapelt).
# Voraussetzungen: Developer-ID-Application-Zertifikat (Team LXXDCD6K7Z) im Schlüsselbund, Provisioning-Profil unter
# native/StreamingHubSync/Resources/StreamingHubSync.provisionprofile (erzeugt: node scripts/provision-sync-helper.js),
# notarytool-Profil `streaminghub-notary`. --sign-only/--no-notarize überspringen Notarisierung und Stapeln.
set -euo pipefail

TEAM="LXXDCD6K7Z"
IDENTITY="Developer ID Application: Norman Stubenrauch ($TEAM)"
NOTARY_PROFILE="streaminghub-notary"
CORE_MIN_REV="3ff3c0c"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/native/StreamingHubSync"
DIST="$PKG/dist"
APP="$DIST/StreamingHubSync.app"
PROFILE="${SYNC_PROFILE:-$PKG/Resources/StreamingHubSync.provisionprofile}"
CORE="$(cd "$ROOT/../StreamingHub-tvOS" && pwd)"
NOTARIZE=1
for a in "$@"; do case "$a" in --sign-only|--no-notarize) NOTARIZE=0 ;; *) echo "Unbekannte Option $a" >&2; exit 64 ;; esac; done

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PKG/Resources/Info.plist")"
grep -q "helperVersion = \"$VERSION\"" "$PKG/Sources/SyncProtocol/HelperServer.swift" \
  || { echo "Info.plist-Version $VERSION passt nicht zu HelperServer.helperVersion" >&2; exit 1; }
[ -f "$PROFILE" ] || { echo "Profil fehlt: $PROFILE (node scripts/provision-sync-helper.js)" >&2; exit 1; }
git -C "$CORE" merge-base --is-ancestor "$CORE_MIN_REV" HEAD 2>/dev/null \
  || { echo "Core ($CORE) enthält $CORE_MIN_REV nicht" >&2; exit 1; }
CORE_REV="$(git -C "$CORE" rev-parse --short HEAD)"
[ -z "$(git -C "$CORE" status --porcelain -- Sources)" ] || echo "Warnung: Core hat uncommittete Änderungen in Sources" >&2

echo "== Build (universal, Core $CORE_REV)"
( cd "$PKG" && swift build -c release --arch arm64 --arch x86_64 )
BIN="$(cd "$PKG" && swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

echo "== Bundle"
rm -rf "$DIST"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/StreamingHubSync" "$APP/Contents/MacOS/StreamingHubSync"
cp "$PKG/Resources/Info.plist" "$APP/Contents/Info.plist"
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
for b in "$BIN"/*.bundle; do [ -e "$b" ] && cp -R "$b" "$APP/Contents/Resources/"; done
true

echo "== Signieren (Developer ID, Hardened Runtime)"
find "$APP/Contents/Resources" -name '*.bundle' -maxdepth 1 -exec codesign --force --timestamp --sign "$IDENTITY" {} \;
codesign --force --timestamp --options runtime --entitlements "$PKG/Resources/StreamingHubSync.entitlements" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q "iCloud.tv.streaminghub" || { echo "Entitlement fehlt" >&2; exit 1; }

ZIP="$DIST/StreamingHubSync-$VERSION.zip"
if [ "$NOTARIZE" = 1 ]; then
  echo "== Notarisieren"
  ditto -c -k --keepParent "$APP" "$DIST/notarize.zip"
  xcrun notarytool submit "$DIST/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
  rm -f "$DIST/notarize.zip"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl -a -vv -t exec "$APP"
fi
ditto -c -k --keepParent "$APP" "$ZIP"
echo "== Ergebnis: $ZIP (Core $CORE_REV, notarisiert: $NOTARIZE)"
shasum -a 256 "$ZIP"
