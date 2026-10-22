$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Output 'Node.js not found. Install Node.js 18+ first.'
  exit 1
}
if (-not (Test-Path (Join-Path $Root 'config\apps.json'))) {
  Write-Output 'config\apps.json missing. Run setup.bat first.'
  exit 1
}

$cfgFile = Join-Path $Root 'config\config.json'
if (-not (Test-Path $cfgFile)) { $cfgFile = Join-Path $Root 'config\config.example.json' }
$cfg = $null
try { $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
$startHour = if ($cfg -and $cfg.startHour) { [int]$cfg.startHour } else { 9 }
if ($startHour -lt 0 -or $startHour -gt 23) { $startHour = 9 }
$at = '{0:D2}:00' -f $startHour

$dailyBat = Join-Path $Root 'daily.bat'
$catchupPs1 = Join-Path $Root 'tools\catchup.ps1'

try {
  $dailyAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$dailyBat`""
  $dailyTrigger = New-ScheduledTaskTrigger -Daily -At $at
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'WeChatMiniCheckin' -Action $dailyAction -Trigger $dailyTrigger `
    -Settings $settings -Description 'Daily WeChat mini-program check-in' -Force | Out-Null
  Write-Output ("Created task: WeChatMiniCheckin (daily at " + $at + ", start when available)")
} catch {
  Write-Output ('Failed to create WeChatMiniCheckin: ' + $_.Exception.Message)
  Write-Output 'Try running this script from an elevated PowerShell (Run as administrator).'
  exit 1
}

try {
  $catchupAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$catchupPs1`""
  $catchupTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::FromDays(3650))
  Register-ScheduledTask -TaskName 'WeChatMiniCatchup' -Action $catchupAction -Trigger $catchupTrigger `
    -Settings $settings -Description 'Catch-up run if the PC was off at the scheduled time' -Force | Out-Null
  Write-Output 'Created task: WeChatMiniCatchup (every 30 minutes)'
} catch {
  Write-Output ('Failed to create WeChatMiniCatchup: ' + $_.Exception.Message)
  Write-Output 'The daily task still works; you can also run daily.bat manually.'
}

Write-Output ''
Write-Output 'Next steps:'
Write-Output '  1. Log into WeChat and open the target mini-program once.'
Write-Output '  2. Run harvest.bat to save your tokens.'
Write-Output '  3. Run doctor.bat to verify.'
Write-Output '  4. Run daily.bat once to test the full flow.'
