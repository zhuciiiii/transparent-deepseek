' Hidden runner for "shortcuts.js repair" (used by the logon scheduled task / startup entry).
Option Explicit
Dim sh, fso, dir, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "D:\DeepSeek\deep\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = dir
sh.Run """" & node & """ """ & dir & "\shortcuts.js"" repair", 0, False
