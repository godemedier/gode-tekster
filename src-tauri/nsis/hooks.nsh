; Afinstallation (delbar udgave 3/10): »Start med Windows« må ikke blive liggende som en død
; nøgle i registreringsdatabasen, når programmet er væk. Brugerens tekster røres aldrig.
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait 'schtasks /Delete /TN "Gode Tekster" /F'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Gode Tekster"
!macroend
