; Højreklik › Ny i Stifinder (16/11, ADR-0071): »Tekst i Gode Tekster« laver en tom .md i mappen.
; Stifinder læser `.md\ShellNew` og viser filtypens navn, som Tauri skriver ud fra
; `fileAssociations.description` i tauri.conf.json. Den står kun på ét sprog, så navnet skrives her
; igen efter installerens sprog (1030 = dansk). Stifinder kalder filen »Ny <navn>.md«.
; SHChangeNotify får Stifinder til at læse filtyperne igen, så punktet kommer uden genstart.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\.md\ShellNew" "NullFile" ""
  ${If} $LANGUAGE = 1030
    WriteRegStr SHCTX "Software\Classes\Markdown" "" "Tekst i Gode Tekster"
  ${Else}
    WriteRegStr SHCTX "Software\Classes\Markdown" "" "Gode Tekster document"
  ${EndIf}
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend

; Afinstallation (delbar udgave 3/10): »Start med Windows« må ikke blive liggende som en død
; nøgle i registreringsdatabasen, når programmet er væk. Brugerens tekster røres aldrig.
; En opdatering kører også afinstallationen (med /UPDATE, Tauris skabelon sætter $UpdateMode).
; Dér skal opgaven blive, ellers starter programmet ikke længere med Windows efter opdateringen.
; nsExec::Exec kører schtasks uden et konsolvindue, der blinker.
; Ny-punktet fjernes også, men kun hvis .md stadig peger på vores filtype: Tauris afinstallation
; sletter kun filtypen og lader `.md` stå, og har et andet program taget .md, er punktet dets.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::Exec 'schtasks /Delete /TN "Gode Tekster" /F'
    Pop $0
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Gode Tekster"
    ReadRegStr $0 SHCTX "Software\Classes\.md" ""
    ${If} $0 == "Markdown"
      DeleteRegKey SHCTX "Software\Classes\.md\ShellNew"
    ${EndIf}
  ${EndIf}
!macroend
