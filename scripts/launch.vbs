Option Explicit

Dim fileSystem, projectRoot, electronPath, shell

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

Set shell = CreateObject("Shell.Application")
shell.ShellExecute electronPath, ".", projectRoot, "open", 1
