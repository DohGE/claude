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
# The old instance has to go first, or it keeps the port and the new one silently
# lands on a different one: two servers would then share this session's state file
# while the user's open tab talks to the one the orchestrator no longer polls.
$prevPort = 0
if (Test-Path $serverJson) {
  $prevPid = 0
  try {
    $prev = Get-Content $serverJson -Raw | ConvertFrom-Json
    $prevPort = $prev.port
    $prevPid = $prev.pid
  } catch { $prevPort = 0 }
  if ($prevPid -gt 0) {
    try { Stop-Process -Id $prevPid -Force -ErrorAction Stop } catch { }
    $stopBy = (Get-Date).AddSeconds(5)
    while ((Get-Process -Id $prevPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $stopBy) {
      Start-Sleep -Milliseconds 200
    }
  }
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
