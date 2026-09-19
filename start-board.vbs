' =============================================================
'  Claude Session Board launcher
' -------------------------------------------------------------
'  If the admin task (ClaudeSessionBoard) is registered, start it
'  through the task so it runs elevated (no UAC prompt).
'  Otherwise start node directly with normal privileges.
'  Either way, open the browser at the end. A second instance is
'  rejected by the server itself.
'
'  To run elevated, run install-admin-task.ps1 once as administrator.
'
'  *** ASCII ONLY - DO NOT PUT JAPANESE IN THIS FILE ***
'  WSH reads .vbs using the system code page (CP932 here). This file
'  used to hold Japanese comments saved as UTF-8 without a BOM, so
'  WSH mis-decoded them and the launch line below never ran -- while
'  the script still exited with code 0, so nothing looked wrong.
'  That is why the board silently stopped opening (2026-08-20).
'  Put any Japanese in a .ps1 saved with a BOM instead.
' =============================================================
Option Explicit
Dim sh, fso, url, rc, taskRc, started, here, nodeExe, serverJs, portFile, port
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Paths come from this file's own folder. Never write an absolute path
' containing a user name: it breaks on other PCs and this repo is public.
here     = fso.GetParentFolderName(WScript.ScriptFullName)
serverJs = fso.BuildPath(here, "server.js")

' Node: bundled first, then the usual install location, then PATH.
' Hardcoding "C:\Program Files\nodejs\node.exe" fails on machines with
' no Node installed even though we ship our own copy.
nodeExe = fso.BuildPath(here, "node\node.exe")
If Not fso.FileExists(nodeExe) Then
    nodeExe = fso.BuildPath(sh.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
End If
If Not fso.FileExists(nodeExe) Then
    nodeExe = "node"
End If

' The server writes the port it actually listened on. It moves to a free
' neighbour when 4788 is taken, so do not hardcode the number here.
port = "4788"
portFile = fso.BuildPath(here, "port.txt")
If fso.FileExists(portFile) Then
    Dim ts, v
    On Error Resume Next
    Set ts = fso.OpenTextFile(portFile, 1)
    v = Trim(ts.ReadAll)
    ts.Close
    On Error Goto 0
    If IsNumeric(v) Then port = v
End If

url = "http://127.0.0.1:" & port & "/"
started = False

' --- If the admin task exists, start it that way ---
' schtasks /query returns 0 when the task exists
taskRc = sh.Run("schtasks /query /tn ""ClaudeSessionBoard""", 0, True)
If taskRc = 0 Then
    ' /run fails if it is already running, but then the server is up anyway
    sh.Run "schtasks /run /tn ""ClaudeSessionBoard""", 0, True
    started = True
End If

' --- No task: start it directly with normal privileges ---
If Not started Then
    sh.Environment("PROCESS")("NO_BROWSER") = "1"
    sh.CurrentDirectory = here
    sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False
End If

' --- Give the server a moment, then open the browser ---
WScript.Sleep 1200
sh.Run url, 1, False
