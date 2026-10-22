param(
  [int]$StartHour = -1,
  [int]$StaleLockMinutes = 30
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = if ($env:HULA_DATA_DIR) { [IO.Path]::GetFullPath($env:HULA_DATA_DIR) } else { Join-Path $Root 'data' }
$LogDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$cfgFile = Join-Path $Root 'config\config.json'
if (-not (Test-Path $cfgFile)) { $cfgFile = Join-Path $Root 'config\config.example.json' }
$cfg = $null
try { $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
if ($StartHour -lt 0) {
  $StartHour = if ($cfg -and $cfg.startHour) { [int]$cfg.startHour } else { 9 }
}

$marker = Join-Path $DataDir 'last_run.txt'
$lock = Join-Path $DataDir 'run.lock'
$log = Join-Path $LogDir 'catchup.log'

function Say($msg) {
  $line = "[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}

$now = Get-Date
Say ("logon check: now=" + $now.ToString('yyyy-MM-dd HH:mm') + " startHour=" + $StartHour)

if ($now.Hour -lt $StartHour) {
  Say 'before start hour, leaving it to the daily task'
  exit 0
}

$today = $now.ToString('yyyy-MM-dd')
if (Test-Path $marker) {
  $last = (Get-Content $marker -Raw).Trim()
  if ($last -eq $today) {
    Say ("already ran today (" + $last + ")")
    exit 0
  }
}

if (Test-Path $lock) {
  $age = ($now - (Get-Item $lock).LastWriteTime).TotalMinutes
  if ($age -gt $StaleLockMinutes) {
    Say ("removing stale lock (" + [math]::Round($age, 0) + " min old)")
    Remove-Item $lock -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Say 'another run is in progress, skipping'
    exit 0
  }
}

$bat = Join-Path $Root 'daily.bat'
Say 'running daily.bat'
& cmd.exe /c "`"$bat`"" 2>&1 | ForEach-Object {
  Add-Content -Path $log -Value $_ -Encoding UTF8
}
$code = $LASTEXITCODE
Say ("daily.bat exit=" + $code)

if ($code -eq 0) {
  Set-Content -Path $marker -Value $today -Encoding ASCII
  Say 'marker written, done for today'
} else {
  Say 'daily.bat failed - will retry later'
}
exit $code
