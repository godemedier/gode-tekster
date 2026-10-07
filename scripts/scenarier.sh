#!/usr/bin/env bash
# Testprotokollens scenarier mod release-bygget. Kun kopier i tests/private/proeve/scen/.
set -u
cd "$(dirname "$0")/.."
P=tests/private/proeve
D=$P/scen
L="$LOCALAPPDATA/dk.godemedier.godetekster/log/gode-tekster.log"
EXE=./src-tauri/target/release/gode-tekster.exe

if tasklist //FI "IMAGENAME eq gode-tekster.exe" | grep -qi gode-tekster; then
  echo "AFBRUDT: Gode Tekster kører allerede."; exit 2
fi
rm -rf "$D"; mkdir -p "$D"

N=0
start() { # fil scenarie
  N=$(wc -l < "$L")
  GT_TEST=1 GT_SCENARIE="$2" "$EXE" "$(cygpath -w "$PWD/$1")" >/dev/null 2>&1 &
}
waitlog() { # mønster [sekunder]
  for i in $(seq 1 $(( ${2:-30} * 4 ))); do sleep 0.25; tail -n +$((N+1)) "$L" | grep -q "$1" && return 0; done
  echo "  (ventede forgæves på »$1«)"; return 1
}
mypid() { powershell -NoProfile -Command "(Get-Process gode-tekster -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1).Id"; }
kill9() { local p; p=$(mypid); [ -n "$p" ] && taskkill //PID "$p" //T //F >/dev/null 2>&1; sleep 1; }
closewin() { local p; p=$(mypid); [ -n "$p" ] && taskkill //PID "$p" >/dev/null 2>&1; sleep 2.5; kill9; }
log() { tail -n +$((N+1)) "$L" | grep "scenarie:" | sed 's/^[0-9]* //'; }
has() { grep -q "$2" "$1" && echo ja || echo NEJ; }

echo "== 1a. Dræbt 0,3 s efter et tastetryk"
cp "$P/ARTIKEL-kopi.md" "$D/drab.md"; start "$D/drab.md" skriv; waitlog "skrevet"; sleep 0.3; kill9
echo "  på disken: $(has "$D/drab.md" SCENARIE-SKREVET)"
ls -t "$LOCALAPPDATA/dk.godemedier.godetekster/backup" 2>/dev/null | head -2 | sed 's/^/  backup: /'

echo "== 1b. Dræbt 2,5 s efter et tastetryk"
cp "$P/ARTIKEL-kopi.md" "$D/drab2.md"; start "$D/drab2.md" skriv; waitlog "skrevet"; sleep 2.5; kill9
echo "  på disken: $(has "$D/drab2.md" SCENARIE-SKREVET)"

echo "== 2. Lukket med X 0,2 s efter et tastetryk"
cp "$P/ARTIKEL-kopi.md" "$D/luk.md"; start "$D/luk.md" skriv; waitlog "skrevet"; sleep 0.2; closewin
echo "  på disken: $(has "$D/luk.md" SCENARIE-SKREVET)"

echo "== 3. Ændret udefra, mens der skrives"
cp "$P/ARTIKEL-kopi.md" "$D/ekstern.md"; start "$D/ekstern.md" skriv-ekstern; waitlog "skriver"; sleep 1
python - "$D/ekstern.md" <<'PY' 2>/dev/null || node -e 'const f=process.argv[1];const fs=require("fs");const t=fs.readFileSync(f,"utf8");fs.writeFileSync(f,t.replace("Statsministeren","EKSTERN-ÆNDRING Statsministeren"))' "$D/ekstern.md"
import sys
f=sys.argv[1]; t=open(f,encoding="utf-8").read(); open(f,"w",encoding="utf-8").write(t.replace("Statsministeren","EKSTERN-ÆNDRING Statsministeren"))
PY
waitlog "efter:" 20; log | grep "efter:"; sleep 2; closewin
echo "  på disken: lokal $(has "$D/ekstern.md" LOKAL-ÆNDRING), ekstern $(has "$D/ekstern.md" EKSTERN-ÆNDRING)"

echo "== 4. Skrivebeskyttet fil"
cp "$P/ARTIKEL-kopi.md" "$D/laast.md"; attrib +R "$(cygpath -w "$D/laast.md")"; start "$D/laast.md" skrivebeskyttet; waitlog "færdig" 20; log | grep "besked"; kill9
attrib -R "$(cygpath -w "$D/laast.md")"
echo "  på disken: $(has "$D/laast.md" SKAL-IKKE)"

echo "== 5. Omdøbt udefra, mens den er åben"
cp "$P/ARTIKEL-kopi.md" "$D/foer.md"; start "$D/foer.md" omdoeb; waitlog "klar til omdøbning"; mv "$D/foer.md" "$D/efter.md"; waitlog "færdig" 20; log | grep "besked"; closewin
for f in "$D"/foer.md "$D"/efter.md; do [ -f "$f" ] && echo "  $(basename "$f"): findes, tekst $(has "$f" EFTER-OMDØBNING)" || echo "  $(basename "$f"): findes ikke"; done

echo "== 6. Windows-1252 med æøå"
printf 'Grøn æble på åen og et søskende-ord.\r\n\r\nAndet afsnit.\r\n' | iconv -f UTF-8 -t CP1252 > "$D/ansi.md"; start "$D/ansi.md" tegnsaet; waitlog "færdig" 20; log | grep "linje\|efter gem"; closewin
echo "  bytes for æ i filen nu: $(od -An -tx1 "$D/ansi.md" | tr -d '\n' | grep -o 'c3 a6\| e6' | head -1)  (c3 a6 = UTF-8, e6 = Windows-1252)"
head -c 120 "$D/ansi.md" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 && echo "  gyldig UTF-8: ja" || echo "  gyldig UTF-8: NEJ"

echo "== 7. 160.000 ord: ret i starten, gem, sammenlign slutningen"
for i in 1 2; do cat "$P/STOR.md"; done | head -c 1000000 > "$D/stor.md"; printf '\nSLUTNINGEN-ER-HER\n' >> "$D/stor.md"; ORIG=$(wc -c < "$D/stor.md")
start "$D/stor.md" stor; waitlog "færdig" 40; log | grep "gemt"; closewin
echo "  bytes før $ORIG, efter $(wc -c < "$D/stor.md") (forventet +13), slutning: $(tail -c 20 "$D/stor.md" | tr -d '\n')"

echo "== 8. Fortryd i ti trin, hen over et gem"
cp "$P/MAALING.md" "$D/fortryd.md"; start "$D/fortryd.md" fortryd; waitlog "færdig" 30; log | grep "fortryd 10"; kill9

echo "== 9. Spring fra dispositionen i en lang tekst"
cp "$P/STOR.md" "$D/spring.md"; start "$D/spring.md" spring; waitlog "færdig" 40; log | grep "spring:"; kill9

echo "== 10. Sti med æøå og mellemrum"
mkdir -p "$D/mappe med æøå"; cp "$P/ARTIKEL-kopi.md" "$D/mappe med æøå/Tekst med mellemrum.md"; start "$D/mappe med æøå/Tekst med mellemrum.md" skriv; waitlog "skrevet"; sleep 3; closewin
echo "  på disken: $(has "$D/mappe med æøå/Tekst med mellemrum.md" SCENARIE-SKREVET)"

echo "== 11. Anslag og ord"
cp "$P/ARTIKEL-kopi.md" "$D/anslag.md"; start "$D/anslag.md" anslag; waitlog "færdig" 20; log | grep "tælling"; kill9
echo "FÆRDIG"
