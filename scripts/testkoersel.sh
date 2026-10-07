#!/usr/bin/env bash
# Kør Gode Tekster i testtilstand på en KOPI og vent på en linje i loggen. Starter ikke, hvis
# brugerens eget program kører (enkeltinstans ville sende filen derover), og lukker kun sin egen proces.
# Brug: gt-run.sh <fil-i-tests/private/proeve> <log-mønster> [ekstra miljø, fx GT_MEASURE=1]
set -u
cd "$(dirname "$0")/.."
FILE="$1"; PATTERN="$2"; shift 2
if tasklist //FI "IMAGENAME eq gode-tekster.exe" | grep -qi gode-tekster; then
  echo "AFBRUDT: Gode Tekster kører allerede (brugerens eget vindue). Ingen test."
  exit 2
fi
ORIG="tests/private/proeve/$FILE"
BACKUP="$TEMP/gt-before-$FILE"
cp "$ORIG" "$BACKUP"
L="$LOCALAPPDATA/dk.godemedier.godetekster/log/gode-tekster.log"
n=$(wc -l < "$L")
EXE="${GT_EXE:-./src-tauri/target/release/gode-tekster.exe}"
env GT_TEST=1 "$@" "$EXE" "$(cygpath -w "$PWD/$ORIG")" &
PID=$!
# GT_VENT: sekunder, testen må vente (standard 90; et faktatjek med websøgning tager længere).
for i in $(seq 1 "${GT_VENT:-90}"); do sleep 1; tail -n +$((n+1)) "$L" | grep -q "$PATTERN" && break; done
sleep 1
# Kun testkopien (byggetræet), startet inden for testens egen ventetid. Før: fast 3 minutter, så en
# test med GT_VENT=360 efterlod sin kopi kørende og spærrede for næste test (4/10). GT_EXE: en kopi
# uden for byggetræet (den flytbare udgave, 5/10), skal ligge i en mappe ved navn gt-portabel.
WINPID=$(powershell -NoProfile -Command "(Get-Process gode-tekster | Where-Object { \$_.StartTime -gt (Get-Date).AddSeconds(-$(( ${GT_VENT:-90} + 120 ))) -and (\$_.Path -like '*target*' -or \$_.Path -like '*gt-portabel*') } | Select-Object -First 1).Id")
[ -n "$WINPID" ] && taskkill //PID "$WINPID" //T //F >/dev/null 2>&1
tail -n +$((n+1)) "$L"
if cmp -s "$ORIG" "$BACKUP"; then echo "testfilen uændret"; else echo "TESTFILEN ÆNDRET af testen: lægger kopien tilbage"; cp "$BACKUP" "$ORIG"; fi
