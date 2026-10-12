; Afinstallation (delbar udgave 3/10): »Start med Windows« må ikke blive liggende som en død
; nøgle i registreringsdatabasen, når programmet er væk. Brugerens tekster røres aldrig.
; En opdatering kører også afinstallationen (med /UPDATE, Tauris skabelon sætter $UpdateMode).
; Dér skal opgaven blive, ellers starter programmet ikke længere med Windows efter opdateringen.
; nsExec::Exec kører schtasks uden et konsolvindue, der blinker.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::Exec 'schtasks /Delete /TN "Gode Tekster" /F'
    Pop $0
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Gode Tekster"
  ${EndIf}
!macroend
