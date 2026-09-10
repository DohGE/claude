param(
  [Parameter(Mandatory = $true)][string]$SessionDir,
  [switch]$Open
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $scriptDir 'server.cjs'
New-Item -ItemType Directory -Force $SessionDir | Out-Null
$serverJson = Join-Path $SessionDir 'server.json'
# Reuse the previous port when restarting, so a browser tab the user still has
# open keeps working; the server falls back to any free port if it is taken.
$prevPort = 0
if (Test-Path $serverJson) {
  try { $prevPort = (Get-Content $serverJson -Raw | ConvertFrom-Json).port } catch { $prevPort = 0 }
  Remove-Item $serverJson -Force
}
$nodeArgs = @($serverJs, '--session-dir', $SessionDir)
if ($prevPort -gt 0) { $nodeArgs += @('--port', "$prevPort") }

Start-Process -FilePath 'node' `
  -ArgumentList $nodeArgs `
  -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path $serverJson)) {
  if ((Get-Date) -gt $deadline) { Write-Error 'server did not start within 15s'; exit 1 }
  Start-Sleep -Milliseconds 200
}
$info = Get-Content $serverJson -Raw | ConvertFrom-Json
if ($Open) { Start-Process "http://127.0.0.1:$($info.port)/" }
Write-Output ('{"port":' + $info.port + '}')
