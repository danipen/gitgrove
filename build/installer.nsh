; NSIS additions for the Windows installer (included via electron-builder.yml
; `nsis.include`). Adds the Explorer folder context menu — right-click a folder
; (or a folder window's background) → "Open in GitGrove", which launches
; `GitGrove.exe --repo "<folder>"`; the single-instance lock routes that into a
; running instance, which focuses or opens the repo in a window.
;
; Registered under HKCU to match the per-user install (`nsis.perMachine: false`)
; — no elevation needed, and the uninstaller can always remove what it wrote.
; `%V` is Explorer's verbatim selected-folder placeholder (works for both the
; selected folder and the window background, unlike %1).

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\GitGrove" "" "Open in GitGrove"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GitGrove" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GitGrove\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --repo "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GitGrove" "" "Open in GitGrove"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GitGrove" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GitGrove\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --repo "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GitGrove"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GitGrove"
!macroend
