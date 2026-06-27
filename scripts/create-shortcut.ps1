# Creates one-click "Token Ledger" shortcuts on the Desktop and Start Menu.
# The shortcuts use a Windows script host launcher, so no terminal window appears.
# Re-run this script after moving the project folder to refresh the paths.

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $projectRoot 'assets\token-ledger.ico'
$launcher = Join-Path $PSScriptRoot 'launch.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path -LiteralPath $electron)) {
  Write-Error "Electron not found at:`n  $electron`nRun 'npm install' in the project folder first."
  exit 1
}

if (-not (Test-Path -LiteralPath $icon)) {
  Write-Error "App icon not found at:`n  $icon"
  exit 1
}

if (-not (Test-Path -LiteralPath $launcher)) {
  Write-Error "Launcher not found at:`n  $launcher"
  exit 1
}

$wshShell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop)) {
  $desktop = Join-Path $env:OneDrive 'Desktop'
}
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$appName = 'Token Ledger'
$targets = @(
  (Join-Path $desktop "$appName.lnk"),
  (Join-Path $startMenu "$appName.lnk")
)

foreach ($shortcutPath in $targets) {
  $shortcut = $wshShell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "`"$launcher`""
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = 'View local Claude Code token usage and estimated costs'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  Write-Host "Created: $shortcutPath"
}

Write-Host "`nDone. Launch '$appName' from your Desktop or Start Menu."
