#!/usr/bin/env bash
# Trykprøve (3/10): de steder, skriveprogrammer typisk går i stykker. Kører mod release-bygget
# med GT_SCENARIE (src/measure.ts) på kopier i tests/private/proeve/tryk/. Starter ikke, hvis
# Gode Tekster allerede kører.
set -u
cd "$(dirname "$0")/.."
P=tests/private/proeve
D=$P/tryk
L="$LOCALAPPDATA/dk.godemedier.godetekster/log/gode-tekster.log"
EXE=./src-tauri/target/release/gode-tekster.exe
if tasklist //FI "IMAGENAME eq gode-tekster.exe" | grep -qi gode-tekster; then echo "AFBRUDT: Gode Tekster kører allerede."; exit 2; fi
rm -rf "$D"; mkdir -p "$D"
N=0
win() { cygpath -w "$PWD/$1"; }
start() { N=$(wc -l < "$L"); GT_TEST=1 GT_SCENARIE="$2" "$EXE" "$(win "$1")" >/dev/null 2>&1 & }
waitlog() { for i in $(seq 1 $(( ${2:-30} * 4 ))); do sleep 0.25; tail -n +$((N+1)) "$L" | grep -q "$1" && return 0; done; echo "  (ventede forgæves på »$1«)"; return 1; }
quitall() { local p; p=$(powershell -NoProfile -Command "(Get-Process gode-tekster -ErrorAction SilentlyContinue).Id -join ' '"); for x in $p; do taskkill //PID "$x" >/dev/null 2>&1; done; sleep 3; for x in $p; do taskkill //PID "$x" //T //F >/dev/null 2>&1; done; sleep 1; }
log() { tail -n +$((N+1)) "$L" | grep "scenarie:" | sed 's/^[0-9]* //'; }
count() { grep -c "$2" "$1"; }

echo "== Hurtige skift mellem tre tekster midt i skrivningen (3 runder)"
for x in a b c; do cp "$P/ARTIKEL-kopi.md" "$D/skift-$x.md"; done
start "$D/skift-a.md" "skift:$(win "$D/skift-a.md")|$(win "$D/skift-b.md")|$(win "$D/skift-c.md")"; waitlog "skift: færdig" 60; quitall
for x in a b c; do echo "  skift-$x.md: SKIFT-0 $(count "$D/skift-$x.md" SKIFT-0), SKIFT-1 $(count "$D/skift-$x.md" SKIFT-1), SKIFT-2 $(count "$D/skift-$x.md" SKIFT-2) (forventet 1 af hver)"; done

echo "== Kæmpe indsæt og en linje på 100.000 tegn"
cp "$P/MAALING.md" "$D/indsaet.md"; start "$D/indsaet.md" indsaet; waitlog "færdig" 60; log | grep "indsæt:"; quitall
echo "  på disken: $(wc -c < "$D/indsaet.md") byte"

echo "== Fraklip med tegn, der ligner skjulte blokke"
cp "$P/MAALING.md" "$D/fraklip.md"; start "$D/fraklip.md" fraklip; waitlog "færdig" 30; log | grep "fraklip:"; quitall
grep -c "midt i" "$D/fraklip.md" | sed 's/^/  forekomster af teksten i filen: /'

echo "== Slettet udefra, mens den er åben"
cp "$P/ARTIKEL-kopi.md" "$D/slettes.md"; start "$D/slettes.md" omdoeb; waitlog "klar til omdøbning"; rm "$D/slettes.md"; waitlog "færdig" 20; log | grep "besked"; quitall
[ -f "$D/slettes.md" ] && echo "  GENSKABT UDEN AT SPØRGE" || echo "  ikke genskabt uden at spørge (som forventet)"

echo "== Særlige filer: tom, kun mellemrum, BOM, Windows-linjeskift, én lang linje"
: > "$D/tom.md"; printf '   \n\n  ' > "$D/mellemrum.md"; printf '\xef\xbb\xbfMed BOM. Grøn æble.\n' > "$D/bom.md"; printf 'Linje et\r\nLinje to\r\n' > "$D/crlf.md"; head -c 200000 /dev/zero | tr '\0' 'y' > "$D/lang.md"
for f in tom mellemrum bom crlf lang; do
  cp "$D/$f.md" "$D/$f.foer"; start "$D/$f.md" skriv; waitlog "skrevet" 20; sleep 3; quitall
  ok=$(grep -c "SCENARIE-SKREVET" "$D/$f.md"); bom=$(head -c3 "$D/$f.md" | od -An -tx1 | tr -d " "); crlf=$(od -An -tx1 "$D/$f.md" | grep -o " 0d" | wc -l)
  echo "  $f.md: gemt $ok, start-bytes $bom, CR-tegn $crlf (før: $(od -An -tx1 "$D/$f.foer" | grep -o " 0d" | wc -l))"
done

echo "== Ét vindue pr. tekst: anden tekst i nyt vindue, samme tekst hentes frem, Ctrl+Q lukker alt"
cp "$P/MAALING.md" "$D/vindue-a.md"; cp "$P/ARTIKEL-kopi.md" "$D/vindue-b.md"
start "$D/vindue-a.md" "vinduer:$(win "$D/vindue-b.md")"; waitlog "afslutter" 30
for i in $(seq 1 16); do sleep 0.5; tasklist //FI "IMAGENAME eq gode-tekster.exe" | grep -qi gode-tekster || break; done
log | grep "vinduer:"; tail -n +$((N+1)) "$L" | grep -c "aabnet en fil" | sed 's/^/  tekster åbnet: /'
tasklist //FI "IMAGENAME eq gode-tekster.exe" | grep -qi gode-tekster && { echo "  STADIG KØRENDE efter Ctrl+Q"; quitall; } || echo "  lukket efter Ctrl+Q"

if [ "${1:-}" = "--claude" ]; then
  echo "== Renskriv interview hele vejen (rigtigt Claude-kald)"
  # Interviewnoterne skal lægges i tests/private/proeve/noter.md i forvejen (aldrig i git).
  cp "$P/noter.md" "$D/noter.md"
  start "$D/noter.md" renskriv; waitlog "renskriv: \(Renskrevet\|INTET\|.*kunne ikke\|.*fejl\)" 150; log | grep "renskriv:"; sleep 2; quitall
  ls "$D" | grep -i renskrevet | sed 's/^/  ny fil: /'
  f=$(ls "$D"/*renskrevet*.md 2>/dev/null | head -1); [ -n "$f" ] && grep -c "^## " "$f" | sed 's/^/  mellemrubrikker: /'
fi
echo "FÆRDIG"
