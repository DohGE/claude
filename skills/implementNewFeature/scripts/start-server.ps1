param(
  [Parameter(Mandatory = $true)][string]$SessionDir,
  [switch]$Open
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $scriptDir 'server.cjs'
New-Item -ItemType Directory -Force $SessionDir | Out-Null
$serverJson = Join-Path $SessionDir 'server.json'
if (Test-Path $serverJson) { Remove-Item $serverJson -Force }

Start-Process -FilePath 'node' `
  -ArgumentList @($serverJs, '--session-dir', $SessionDir) `
  -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path $serverJson)) {
  if ((Get-Date) -gt $deadline) { Write-Error 'server did not start within 15s'; exit 1 }
  Start-Sleep -Milliseconds 200
}
$info = Get-Content $serverJson -Raw | ConvertFrom-Json
if ($Open) { Start-Process "http://127.0.0.1:$($info.port)/" }
Write-Output ('{"port":' + $info.port + '}')
