!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$SMPROGRAMS\TypeRelay TUI.lnk" "$INSTDIR\typerelay-tui.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\typerelay-panel.exe" --uninstall'
  Delete "$SMPROGRAMS\TypeRelay TUI.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TypeRelay"
!macroend
