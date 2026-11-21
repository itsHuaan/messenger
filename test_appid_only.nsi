Unicode true
!include "MUI2.nsh"
!addincludedir "C:\Users\Admins\AppData\Local\tauri\NSIS\Include"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "src-tauri\target\release\nsis\x64\utils.nsh"

!define BUNDLEID "com.itshuaan.messenger"

OutFile "test_appid_only.exe"
SilentInstall silent

Section
  SetOutPath "$TEMP"
  CreateShortcut "$TEMP\appid_test.lnk" "$WINDIR\notepad.exe"
  !insertmacro SetLnkAppUserModelId "$TEMP\appid_test.lnk"
SectionEnd
