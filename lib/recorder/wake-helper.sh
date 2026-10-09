PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077
set -f
UID_=$1; APP_PID=$2; TOKEN=$3; PMSET=$4; BASE=$5
case "$UID_" in ''|*[!0-9]*) exit 2;; esac
case "$APP_PID" in ''|*[!0-9]*) exit 2;; esac
case "$TOKEN" in ????????????????????????????????) ;; *) exit 2;; esac
case "$TOKEN" in *[!0-9a-f]*) exit 2;; esac
case "$BASE" in /*) ;; *) exit 2;; esac
[ -x "$PMSET" ] || exit 2
PREFIX=$BASE/streaminghub-wake-$UID_-
DIR=$PREFIX$TOKEN
# verwaiste Verzeichnisse früherer Läufe (Helfer tot) aufräumen
set +f
for old in "$PREFIX"*; do
  [ "$old" = "$DIR" ] && continue
  [ -d "$old" ] && [ ! -L "$old" ] || continue
  opid=$(cat "$old/pid" 2>/dev/null)
  case "$opid" in ''|*[!0-9]*) opid=;; esac
  if [ -z "$opid" ] || ! kill -0 "$opid" 2>/dev/null; then
    rm -f "$old/cmd" "$old/pid"
    rmdir "$old" 2>/dev/null
  fi
done
set -f
mkdir -m 0711 "$DIR" || exit 3
[ -d "$DIR" ] && [ ! -L "$DIR" ] || exit 3
echo $$ > "$DIR/pid"
mkfifo "$DIR/cmd" || { rm -f "$DIR/pid"; rmdir "$DIR"; exit 3; }
chown "$UID_" "$DIR/cmd" && chmod 0600 "$DIR/cmd" || { rm -f "$DIR/cmd" "$DIR/pid"; rmdir "$DIR"; exit 3; }
MAIN=$$
cleanup() {
  rm -f "$DIR/cmd" "$DIR/pid"
  rmdir "$DIR" 2>/dev/null
}
trap 'cleanup; exit 0' TERM INT HUP
exec 3<>"$DIR/cmd"
# Wächter: App weg -> aufräumen und Helfer beenden
(
  while kill -0 "$APP_PID" 2>/dev/null; do sleep 2; done
  cleanup
  kill -9 "$MAIN" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
valid_date() {
  case "$1" in
    [01][0-9]/[0-3][0-9]/[0-9][0-9]\ [0-2][0-9]:[0-5][0-9]:[0-5][0-9]) ;;
    *) return 1;;
  esac
  v_mm=${1%%/*}; v_r=${1#*/}; v_dd=${v_r%%/*}; v_r=${v_r#*/}; v_hh=${v_r#* }; v_hh=${v_hh%%:*}
  case "$v_mm" in 0[1-9]|1[0-2]) ;; *) return 1;; esac
  case "$v_dd" in 0[1-9]|[12][0-9]|3[01]) ;; *) return 1;; esac
  case "$v_hh" in [01][0-9]|2[0-3]) ;; *) return 1;; esac
  return 0
}
while IFS= read -r line <&3; do
  [ "${#line}" -le 40 ] || continue
  case "$line" in
    quit) cleanup; exit 0;;
    "wake "*)
      d=${line#wake }
      valid_date "$d" && "$PMSET" schedule wake "$d" StreamingHub >/dev/null 2>&1;;
    "cancel "*)
      d=${line#cancel }
      valid_date "$d" && "$PMSET" schedule cancel wake "$d" StreamingHub >/dev/null 2>&1;;
  esac
done
cleanup
