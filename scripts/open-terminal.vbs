' Opens a visible PowerShell window that runs one engine setup command (Let's begin, "Do it for me").
' The only argument is the command, base64-encoded by Circle Studio from its fixed list (backend/lib/engines/setup.mjs);
' anything that is not plain base64 is refused, so nothing else can reach the command line.
' (A PowerShell started detached straight from Node closes at once on Windows, hence this launcher.)
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
enc = WScript.Arguments(0)
Set re = New RegExp
re.Pattern = "^[A-Za-z0-9+/=]{4,8000}$"
If Not re.Test(enc) Then WScript.Quit 1
' 1 = a normal, visible window; False = do not wait
sh.Run "powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand " & enc, 1, False
