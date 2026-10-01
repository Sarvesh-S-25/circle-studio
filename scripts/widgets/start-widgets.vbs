' Starts the Circle Studio desktop widgets (desktop-widgets.ps1) with no console window.
' Arguments: <port> <data folder>. Started by the server (lib/deskhost.mjs) and by launch.mjs --widgets.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
port = WScript.Arguments(0)
data = WScript.Arguments(1)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & here & "\desktop-widgets.ps1"" -Port " & port & " -DataDir """ & data & """"
' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
