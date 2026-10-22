param(
  [string]$Title = '签到通知',
  [string]$Message = '',
  [ValidateSet('success', 'failure', 'info')]
  [string]$Kind = 'info'
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = if ($env:HULA_DATA_DIR) { [IO.Path]::GetFullPath($env:HULA_DATA_DIR) } else { Join-Path $Root 'data' }
$LogDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$notifyLog = Join-Path $LogDir 'notify.log'

# --- local record -----------------------------------------------------------
$status = [pscustomobject]@{
  at      = (Get-Date).ToString('o')
  kind    = $Kind
  title   = $Title
  message = $Message
}
$status | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $DataDir 'last_status.json') -Encoding UTF8
("[" + $stamp + "] " + $Title + "`r`n" + $Message + "`r`n") |
  Set-Content -Path (Join-Path $DataDir 'last_status.txt') -Encoding UTF8

# --- read config ------------------------------------------------------------
$cfgFile = Join-Path $Root 'config\config.json'
if (-not (Test-Path $cfgFile)) { $cfgFile = Join-Path $Root 'config\config.example.json' }
$cfg = $null
try { $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
$toastEnabled = $true
$hook = $null
if ($cfg -and $cfg.notify) {
  if ($cfg.notify.toast -eq $false) { $toastEnabled = $false }
  $hook = $cfg.notify.webhook
}

# --- Windows toast ----------------------------------------------------------
if ($toastEnabled) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
      [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $text = $template.GetElementsByTagName('text')
    $text.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
    $text.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Add-Content -Path $notifyLog -Value ("[" + $stamp + "] toast shown: " + $Title) -Encoding UTF8
  } catch {
    Add-Content -Path $notifyLog -Value ("[" + $stamp + "] toast failed: " + $_.Exception.Message) -Encoding UTF8
  }
}

# --- optional phone push ----------------------------------------------------
if ($hook -and $hook.url) {
  try {
    $type = if ($hook.type) { [string]$hook.type } else { 'generic' }
    $url = [string]$hook.url
    $timeout = 15
    switch ($type) {
      'ntfy' {
        $headers = @{
          Title    = $Title
          Priority = if ($Kind -eq 'failure') { 'high' } else { 'default' }
          Tags     = if ($Kind -eq 'failure') { 'warning' } else { 'white_check_mark' }
        }
        Invoke-RestMethod -Uri $url -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($Message)) -Headers $headers -TimeoutSec $timeout | Out-Null
      }
      'serverchan' {
        Invoke-RestMethod -Uri $url -Method Post -Body @{ title = $Title; desp = $Message } -TimeoutSec $timeout | Out-Null
      }
      'pushplus' {
        Invoke-RestMethod -Uri $url -Method Post -Body @{
          token = [string]$hook.token; title = $Title; content = $Message; template = 'txt'
        } -TimeoutSec $timeout | Out-Null
      }
      'feishu' {
        $body = @{ msg_type = 'text'; content = @{ text = ($Title + "`n" + $Message) } } | ConvertTo-Json -Depth 4
        Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec $timeout | Out-Null
      }
      default {
        $body = @{ title = $Title; message = $Message; kind = $Kind } | ConvertTo-Json -Depth 4
        Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec $timeout | Out-Null
      }
    }
    Add-Content -Path $notifyLog -Value ("[" + $stamp + "] pushed via " + $type) -Encoding UTF8
  } catch {
    Add-Content -Path $notifyLog -Value ("[" + $stamp + "] push failed: " + $_.Exception.Message) -Encoding UTF8
  }
}
