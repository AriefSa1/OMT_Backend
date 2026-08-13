[CmdletBinding()]
param(
  [string]$HermesHome = $(if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }),
  [string]$HermesExe = $(Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\hermes.exe'),
  [string]$BindHost = '127.0.0.1',
  [int]$Port = 8645,
  [ValidateSet('nous', 'xai')]
  [string]$Provider = 'nous',
  [int]$PollSeconds = 10,
  [int]$RestartDelaySeconds = 5,
  [string]$LogPath = $(Join-Path $env:LOCALAPPDATA 'hermes\logs\proxy-supervisor.log')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $HermesExe -PathType Leaf)) {
  throw "Hermes executable tidak ditemukan: $HermesExe"
}

$logDirectory = Split-Path -Parent $LogPath
if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory)) {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

$env:HERMES_HOME = $HermesHome
$env:PYTHONIOENCODING = 'utf-8'

function Write-ProxyLog {
  param([string]$Message)

  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Test-ProxyListener {
  try {
    return @(
      Get-NetTCPConnection -LocalAddress $BindHost -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    ).Count -gt 0
  } catch {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $client.Connect($BindHost, $Port)
      return $true
    } catch {
      return $false
    } finally {
      $client.Dispose()
    }
  }
}

$proxyProcess = $null
Write-ProxyLog "Supervisor mulai; target=${BindHost}:${Port}; provider=${Provider}"

try {
  while ($true) {
    if (Test-ProxyListener) {
      if ($null -ne $proxyProcess) {
        Write-ProxyLog "Hermes API siap pada ${BindHost}:${Port} (pid=$($proxyProcess.Id))"
        $proxyProcess = $null
      }
    } elseif ($null -eq $proxyProcess -or $proxyProcess.HasExited) {
      if ($null -ne $proxyProcess) {
        Write-ProxyLog "Proses Hermes berhenti (exit=$($proxyProcess.ExitCode)); akan dijalankan ulang"
      } else {
        Write-ProxyLog 'Hermes API belum listen; memulai proses'
      }

      Start-Sleep -Seconds $RestartDelaySeconds
      $proxyProcess = Start-Process `
        -FilePath $HermesExe `
        -ArgumentList @('proxy', 'start', '--provider', $Provider, '--host', $BindHost, '--port', $Port) `
        -WorkingDirectory $HermesHome `
        -WindowStyle Hidden `
        -PassThru
      Write-ProxyLog "Perintah Hermes dijalankan (pid=$($proxyProcess.Id))"
    }

    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  Write-ProxyLog 'Supervisor berhenti'
}
