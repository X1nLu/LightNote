LangString markdownDocument ${LANG_ENGLISH} "Markdown Document"
LangString markdownDocument ${LANG_SIMPCHINESE} "Markdown 文档"
LangString markdownFile ${LANG_ENGLISH} "Markdown file"
LangString markdownFile ${LANG_SIMPCHINESE} "Markdown 文件"
LangString textDocument ${LANG_ENGLISH} "Text Document"
LangString textDocument ${LANG_SIMPCHINESE} "文本文件"
LangString textFile ${LANG_ENGLISH} "Text file"
LangString textFile ${LANG_SIMPCHINESE} "文本文件"
LangString openWithLightNote ${LANG_ENGLISH} "Open with LightNote"
LangString openWithLightNote ${LANG_SIMPCHINESE} "使用 LightNote 打开"

!include nsDialogs.nsh

Var LightNoteContextMenuCheckbox
Var LightNoteContextMenuEnabled

Function LightNoteContextMenuPage
  ${If} ${Silent}
    Abort
  ${EndIf}

  StrCpy $LightNoteContextMenuEnabled 1
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}

  ${NSD_CreateLabel} 0 0 100% 24u "Choose whether to add LightNote to the context menu for .md, .markdown and .txt files."
  Pop $1

  ${NSD_CreateCheckbox} 0 32u 100% 12u "Add LightNote to file context menu"
  Pop $LightNoteContextMenuCheckbox
  ${NSD_Check} $LightNoteContextMenuCheckbox

  nsDialogs::Show
FunctionEnd

Function LightNoteContextMenuPageLeave
  ${NSD_GetState} $LightNoteContextMenuCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $LightNoteContextMenuEnabled 1
  ${Else}
    StrCpy $LightNoteContextMenuEnabled 0
  ${EndIf}
FunctionEnd

!macro RegisterLightNoteContextMenu
  ClearErrors

  ; Make LightNote discoverable in the "Open with" app list.
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".txt" ""

  ; Add per-extension context menu entries.
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\LightNote" "" "$(openWithLightNote)"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\LightNote" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\LightNote" "MultiSelectModel" "Single"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.md\shell\LightNote\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\LightNote" "" "$(openWithLightNote)"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\LightNote" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\LightNote" "MultiSelectModel" "Single"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\LightNote\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.txt\shell\LightNote" "" "$(openWithLightNote)"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.txt\shell\LightNote" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.txt\shell\LightNote" "MultiSelectModel" "Single"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.txt\shell\LightNote\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  IfErrors 0 +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "LightNote context-menu registration failed. Installation will continue."
!macroend

!macro UnregisterLightNoteContextMenu
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.md\shell\LightNote"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.markdown\shell\LightNote"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.txt\shell\LightNote"

  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $LightNoteContextMenuEnabled != 0
    !insertmacro RegisterLightNoteContextMenu
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro UnregisterLightNoteContextMenu
!macroend
