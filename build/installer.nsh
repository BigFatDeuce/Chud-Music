; Registers Chud Music as a media player with Windows ("Default apps" / "Open with").
; Windows 10/11 never lets an installer *choose* the default player (UserChoice is protected):
; the user picks Chud Music in Settings > Apps > Default apps, where this registration makes it appear.
; Per-user install → HKCU. User data in %APPDATA%\Chud Music is never touched.

!define CHUD_CAPS "Software\Clients\Media\Chud Music\Capabilities"

!macro chudAssoc EXT
  WriteRegStr HKCU "${CHUD_CAPS}\FileAssociations" ".${EXT}" "ChudMusic.${EXT}"
!macroend

!macro customInstall
  WriteRegStr HKCU "${CHUD_CAPS}" "ApplicationName" "Chud Music"
  WriteRegStr HKCU "${CHUD_CAPS}" "ApplicationDescription" "Lecteur musical moderne et rétro"
  WriteRegStr HKCU "${CHUD_CAPS}" "ApplicationIcon" "$INSTDIR\Chud Music.exe,0"
  !insertmacro chudAssoc "mp3"
  !insertmacro chudAssoc "flac"
  !insertmacro chudAssoc "wav"
  !insertmacro chudAssoc "aac"
  !insertmacro chudAssoc "m4a"
  !insertmacro chudAssoc "ogg"
  !insertmacro chudAssoc "oga"
  !insertmacro chudAssoc "opus"
  !insertmacro chudAssoc "wma"
  !insertmacro chudAssoc "aiff"
  !insertmacro chudAssoc "aif"
  !insertmacro chudAssoc "wv"
  !insertmacro chudAssoc "ape"
  !insertmacro chudAssoc "ac3"
  !insertmacro chudAssoc "mka"
  WriteRegStr HKCU "Software\RegisteredApplications" "Chud Music" "${CHUD_CAPS}"
  ; "Open with" list for the app itself
  WriteRegStr HKCU "Software\Classes\Applications\Chud Music.exe\shell\open\command" "" '"$INSTDIR\Chud Music.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\Chud Music.exe" "FriendlyAppName" "Chud Music"
  ; tell Explorer associations changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\RegisteredApplications" "Chud Music"
  DeleteRegKey HKCU "Software\Clients\Media\Chud Music"
  DeleteRegKey HKCU "Software\Classes\Applications\Chud Music.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
