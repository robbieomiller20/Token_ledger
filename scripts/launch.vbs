Option Explicit

Dim fileSystem, projectRoot, electronPath, shell, command

Set fileSystem = CreateObject("Scripting.FileSystemObject")
projectRoot = fileSystem.GetParentFolderName( _
  fileSystem.GetParentFolderName(WScript.ScriptFullName) _
)
electronPath = fileSystem.BuildPath(projectRoot, "node_modules\electron\dist\electron.exe")

If Not fileSystem.FileExists(electronPath) Then
  MsgBox "Electron was not found. Run npm install in:" & vbCrLf & projectRoot, _
    vbCritical, "Token Ledger"
  WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectRoot
command = """" & electronPath & """ ."
shell.Run command, 1, False
