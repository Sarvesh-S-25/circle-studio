' Shows a message box: the launcher runs without a window, so when Circle Studio cannot start this is how you hear of it.
' Arguments: the message, then the title.
title = "Circle Studio"
If WScript.Arguments.Count > 1 Then title = WScript.Arguments(1)
If WScript.Arguments.Count > 0 Then MsgBox WScript.Arguments(0), 48, title
