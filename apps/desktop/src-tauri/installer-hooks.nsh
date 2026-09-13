!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\typerelay-panel.exe" --uninstall'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TypeRelay"
!macroend
