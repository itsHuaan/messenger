; NSIS hooks for Messenger installer and updater
; Ensures robust shortcut preservation, scope handling, and uninstallation.

!macro NSIS_HOOK_PREINSTALL
  ; If INSTDIR is placeholder or default, check if there is an existing installation in HKLM or previous shortcut
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
  ${OrIf} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; 1. Check HKLM uninstall key
    ReadRegStr $0 HKLM "${UNINSTKEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${Else}
      ; 2. Check manufacturer product key in HKLM
      ReadRegStr $0 HKLM "${MANUPRODUCTKEY}" ""
      ${If} $0 != ""
        StrCpy $INSTDIR $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Always ensure Start Menu shortcut points to the installed binary with correct working dir & icon
  CreateDirectory "$SMPROGRAMS"
  SetOutPath "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\Messenger.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0 "" "" "Messenger"

  ; Clean up legacy duplicate lowercase shortcut if present
  ${If} ${FileExists} "$SMPROGRAMS\messenger.lnk"
  ${AndIf} "$SMPROGRAMS\messenger.lnk" != "$SMPROGRAMS\Messenger.lnk"
    Delete "$SMPROGRAMS\messenger.lnk"
  ${EndIf}

  ; 2. Maintain Desktop shortcut:
  ; Only update Desktop shortcut if one already exists on the user's desktop.
  ; Do NOT force a desktop shortcut during an update if the user did not have one.
  Var /GLOBAL HadDesktopLnk
  StrCpy $HadDesktopLnk 0

  ${If} ${FileExists} "$DESKTOP\Messenger.lnk"
    StrCpy $HadDesktopLnk 1
  ${ElseIf} ${FileExists} "$DESKTOP\messenger.lnk"
    StrCpy $HadDesktopLnk 1
  ${EndIf}

  ${If} $HadDesktopLnk = 1
    SetOutPath "$INSTDIR"
    CreateShortcut "$DESKTOP\Messenger.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0 "" "" "Messenger"
    ${If} ${FileExists} "$DESKTOP\messenger.lnk"
    ${AndIf} "$DESKTOP\messenger.lnk" != "$DESKTOP\Messenger.lnk"
      Delete "$DESKTOP\messenger.lnk"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Clean up application shortcuts from Start Menu and Desktop
  Delete "$SMPROGRAMS\Messenger.lnk"
  Delete "$SMPROGRAMS\messenger.lnk"
  Delete "$DESKTOP\Messenger.lnk"
  Delete "$DESKTOP\messenger.lnk"

  ; Clean up auto-start registry entry
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Messenger"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "messenger"
!macroend
