[CmdletBinding()]
param(
  [string]$PublicBaseUrl = '',
  [int]$HermesPort = 8645,
  [int]$CloudflaredReadyPort = 20241
)

$ErrorActionPreference = 'Continue'
$checks = @()

function Add-Check {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  $script:checks += [pscustomobject]@{ Check = $Name; Status = $(if ($Ok) { 'OK' } else { 'FAIL' }); Detail = $Detail }
}

try {
  $local = Invoke-WebRequest -Uri "http://127.0.0.1:$HermesPort/v1/models" -Headers @{ Authorization = 'Bearer healthcheck' } -UseBasicParsing -TimeoutSec 10
  Add-Check 'Hermes local API' ($local.StatusCode -ge 200 -and $local.StatusCode -lt 300) "HTTP $($local.StatusCode)"
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401 -or $status -eq 403) {
    Add-Check 'Hermes local API' $true "HTTP $status (server hidup; token healthcheck ditolak)"
  } else {
    Add-Check 'Hermes local API' $false $_.Exception.Message
  }
}

try {
  $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$CloudflaredReadyPort/ready" -TimeoutSec 10
  $readyConnections = [int]$ready.readyConnections
  Add-Check 'Cloudflared ready' ($ready.status -eq 200 -and $readyConnections -gt 0) "readyConnections=$readyConnections"
} catch {
  Add-Check 'Cloudflared ready' $false $_.Exception.Message
}

if ($PublicBaseUrl) {
  $publicBase = $PublicBaseUrl.TrimEnd('/')
  try {
    $hostname = ([Uri]$publicBase).DnsSafeHost
    $dns = @(Resolve-DnsName -Name $hostname -Type A_AAAA -ErrorAction Stop)
    $addresses = @($dns | Where-Object IPAddress | Select-Object -ExpandProperty IPAddress -Unique)
    Add-Check 'Public DNS' ($addresses.Count -gt 0) ($addresses -join ', ')

    $publicUri = "$publicBase/v1/models"
    try {
      $public = Invoke-WebRequest -Uri $publicUri -Headers @{ Authorization = 'Bearer healthcheck' } -UseBasicParsing -TimeoutSec 20
      Add-Check 'Cloudflare public route' ($public.StatusCode -ge 200 -and $public.StatusCode -lt 300) "HTTP $($public.StatusCode)"
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 401 -or $status -eq 403) {
        Add-Check 'Cloudflare public route' $true "HTTP $status (route hidup; token healthcheck ditolak)"
      } else {
        Add-Check 'Cloudflare public route' $false $_.Exception.Message
      }
    }
  } catch {
    Add-Check 'Public DNS' $false "DNS_NOT_CONFIGURED: hostname '$hostname' tidak memiliki record A/AAAA yang dapat di-resolve"
    Add-Check 'Cloudflare public route' $false 'SKIPPED: perbaiki DNS terlebih dahulu'
  }
}

$checks | Format-Table -AutoSize
if ($checks.Status -contains 'FAIL') { exit 1 }
