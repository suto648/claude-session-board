' =============================================================
'  run-hidden.vbs - start server.js with no console window
' -------------------------------------------------------------
'  Called from the scheduled task action. node.exe is a console
'  app, so launching it directly flashes a black window. Style 0
'  hides it. The browser is opened by start-board.vbs, so set
'  NO_BROWSER=1 here (otherwise the logon task would pop a browser).
'
'  *** ASCII ONLY - see the note in start-board.vbs ***
'
'  Paths are resolved from this file's own folder. Do NOT write an
'  absolute path with a user name in it: it breaks on every other
'  PC, and this repository is public.
'
'  Node: prefer the bundled node\node.exe, then "node" from PATH,
'  then the usual install location. Hardcoding
'  "C:\Program Files\nodejs\node.exe" made this fail on machines
'  that do not have Node installed - the same bug was found in
'  CbC Tools and fixed there too.
' =============================================================
Option Explicit

Dim sh, fso, here, nodeExe, serverJs

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here     = fso.GetParentFolderName(WScript.ScriptFullName)
serverJs = fso.BuildPath(here, "server.js")

nodeExe = fso.BuildPath(here, "node\node.exe")
If Not fso.FileExists(nodeExe) Then
    nodeExe = fso.BuildPath(sh.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
End If
If Not fso.FileExists(nodeExe) Then
    nodeExe = "node"
End If

If Not fso.FileExists(serverJs) Then
    WScript.Quit 1
End If

sh.Environment("PROCESS")("NO_BROWSER") = "1"
sh.CurrentDirectory = here
sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False
