[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$TaskName = '94media Hermes API Supervisor',
  [string]$RepoRoot = '',
  [string]$HermesHome = $(if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }),
  [string]$HermesExe = $(Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\hermes.exe'),
  [int]$Port = 8645
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$supervisor = Join-Path $RepoRoot 'ops\hermes\hermes-proxy-supervisor.ps1'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Scheduled Task dihapus: $TaskName"
  exit 0
}

if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
  throw "Supervisor tidak ditemukan: $supervisor"
}
if (-not (Test-Path -LiteralPath $HermesExe -PathType Leaf)) {
  throw "Hermes executable tidak ditemukan: $HermesExe"
}

$userId = "$env:USERDOMAIN\$env:USERNAME"
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -HermesHome "{1}" -HermesExe "{2}" -Port {3}' -f $supervisor, $HermesHome, $HermesExe, $Port

$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType InteractiveToken -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Menjaga Hermes OpenAI-compatible API pada port 8645 tetap berjalan untuk Cloudflare Tunnel.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Scheduled Task aktif: $TaskName"
Write-Output "Target lokal: http://127.0.0.1:$Port/v1"
