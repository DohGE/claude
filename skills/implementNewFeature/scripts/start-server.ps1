param(
  [Parameter(Mandatory = $true)][string]$SessionDir,
  # The stepper lives at one fixed URL so the browser tab, and everything it
  # remembers for that origin, survives every restart. The override exists for
  # tooling that must not fight a live run for the port.
  [int]$Port = 9999,
  [switch]$Open
)
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $scriptDir 'server.cjs'
New-Item -ItemType Directory -Force $SessionDir | Out-Null
$serverJson = Join-Path $SessionDir 'server.json'
# The old instance has to go first: it holds the port, and the new one refuses to
# start anywhere else. Two servers would otherwise share this session's state file
# while the user's open tab talks to the one the orchestrator no longer polls.
if (Test-Path $serverJson) {
  $prevPid = 0
  try {
    $prev = Get-Content $serverJson -Raw | ConvertFrom-Json
    $prevPid = $prev.pid
  } catch { $prevPid = 0 }
  # Only ever stop a process we can PROVE is this server. A clean shutdown removes
  # server.json, but a crash does not, and a pid Windows has since handed to something
  # else looks exactly like a live server from here - stopping it blind takes down
  # whatever inherited it. When the check cannot confirm, nothing is stopped: a server
  # that really died is not holding the port anyway, and one that is holding it makes
  # the new instance exit with the line that says so.
  if ($prevPid -gt 0) {
    $prevCmd = ''
    try { $prevCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$prevPid" -ErrorAction Stop).CommandLine } catch { $prevCmd = '' }
    if ($prevCmd -and $prevCmd -like '*server.cjs*') {
      try { Stop-Process -Id $prevPid -Force -ErrorAction Stop } catch { }
      $stopBy = (Get-Date).AddSeconds(5)
      while ((Get-Process -Id $prevPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $stopBy) {
        Start-Sleep -Milliseconds 200
      }
    } elseif (Get-Process -Id $prevPid -ErrorAction SilentlyContinue) {
      Write-Warning "server.json names pid $prevPid, which is not this server - leaving it alone"
    }
  }
  Remove-Item $serverJson -Force
}
$nodeArgs = @($serverJs, '--session-dir', $SessionDir, '--port', "$Port")
$log = Join-Path $SessionDir 'server.log'
$outLog = Join-Path $SessionDir 'server.out.log'

$proc = Start-Process -FilePath 'node' `
  -ArgumentList $nodeArgs `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $log

# A taken port makes the server exit instead of moving, so waiting out the full
# timeout would hide the one line that says what is on it.
$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path $serverJson)) {
  if ($proc.HasExited) {
    $why = ''
    if (Test-Path $log) { $why = (Get-Content $log -Raw).Trim() }
    Write-Error ('server exited before it was listening. ' + $why)
    exit 1
  }
  if ((Get-Date) -gt $deadline) { Write-Error 'server did not start within 15s'; exit 1 }
  Start-Sleep -Milliseconds 200
}
$info = Get-Content $serverJson -Raw | ConvertFrom-Json
if ($Open) { Start-Process "http://127.0.0.1:$($info.port)/" }
Write-Output ('{"port":' + $info.port + '}')
