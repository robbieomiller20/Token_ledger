Option Explicit

Const DEFAULT_DELAY_MS = 30000

Dim appRoot, appName, delayMs, fileSystem, electronPath, shell, command

If WScript.Arguments.Count < 1 Then
  MsgBox "Missing application folder.", vbCritical, "Startup launcher"
  WScript.Quit 1
End If

appRoot = WScript.Arguments(0)
appName = "Electron app"
If WScript.Arguments.Count >= 2 Then
  appName = WScript.Arguments(1)
End If

delayMs = DEFAULT_DELAY_MS
If WScript.Arguments.Count >= 3 Then
  On Error Resume Next
  delayMs = CLng(WScript.Arguments(2))
  If Err.Number <> 0 Then
    delayMs = DEFAULT_DELAY_MS
    Err.Clear
  End If
  On Error GoTo 0
End If

If delayMs > 0 Then
  WScript.Sleep delayMs
End If

Set fileSystem = CreateObject("Scripting.FileSystemObject")
electronPath = fileSystem.BuildPath(appRoot, "node_modules\electron\dist\electron.exe")

If Not fileSystem.FileExists(electronPath) Then
  MsgBox "Electron was not found. Run npm install in:" & vbCrLf & appRoot, _
    vbCritical, appName
  WScript.Quit 1
End If

If IsAppRunning(appRoot) Then
  WScript.Quit 0
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = appRoot
command = """" & electronPath & """ ."
shell.Run command, 1, False

Function IsAppRunning(rootPath)
  Dim service, processes, process, commandLine, executablePath

  IsAppRunning = False
  On Error Resume Next
  Set service = GetObject("winmgmts:\\.\root\cimv2")
  Set processes = service.ExecQuery("SELECT CommandLine, ExecutablePath FROM Win32_Process WHERE Name = 'electron.exe'")
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  On Error GoTo 0

  For Each process In processes
    commandLine = ""
    executablePath = ""
    On Error Resume Next
    commandLine = process.CommandLine
    executablePath = process.ExecutablePath
    On Error GoTo 0

    If InStr(1, commandLine, rootPath, vbTextCompare) > 0 _
        Or InStr(1, executablePath, rootPath, vbTextCompare) > 0 Then
      IsAppRunning = True
      Exit Function
    End If
  Next
End Function
