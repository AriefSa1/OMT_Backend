[CmdletBinding()]
param(
  [string]$ServiceName = 'Cloudflared'
)

$ErrorActionPreference = 'Stop'

$service = sc.exe query $ServiceName 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Windows Service '$ServiceName' tidak ditemukan. Output: $service"
}

sc.exe config $ServiceName start= delayed-auto | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw 'Gagal mengatur delayed-auto. Jalankan PowerShell sebagai Administrator.'
}

sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/300000/restart/600000 | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw 'Gagal mengatur Windows Service Recovery. Jalankan PowerShell sebagai Administrator.'
}

Write-Output "Konfigurasi recovery '$ServiceName':"
sc.exe qc $ServiceName | Out-Host
sc.exe qfailure $ServiceName | Out-Host
