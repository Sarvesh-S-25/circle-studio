' Starts Circle Studio without a console window. The desktop shortcuts point here; their arguments are passed on
' to launch.mjs (for example --widget <project id> for a project's widget, --background to start at login).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
args = ""
For Each a In WScript.Arguments
  args = args & " """ & Replace(a, """", "") & """"
Next
' 0 = hidden window, False = do not wait
sh.Run "node """ & root & "\scripts\launch.mjs""" & args, 0, False
