' DeepSeek Harness beautify launcher: starts launcher.js without any console window.
' Shortcuts point at: wscript.exe //B "D:\DeepSeek\beautify\launch.vbs" [original start arguments]
Option Explicit
Dim sh, fso, dir, node, extra, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "D:\DeepSeek\deep\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
If Not fso.FileExists(node) Then node = "node"
extra = ""
For i = 0 To WScript.Arguments.Count - 1
  extra = extra & " """ & WScript.Arguments(i) & """"
Next
sh.CurrentDirectory = dir
sh.Run """" & node & """ """ & dir & "\launcher.js""" & extra, 0, False
