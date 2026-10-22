# Refresh the saved bearer tokens for one account.
#
# A token can only come from WeChat's own login, so the chain is:
#   launch Weixin.exe -> enter the saved account -> the mini-program containers
#   re-login -> the token appears in WeChatAppEx memory -> harvest it.
#
# The decision "do we need to refresh" is made by ASKING THE SERVER, not by the
# saved expires_at: that timestamp is only an estimate.
param(
  [string]$Account = 'default',
  [int]$WaitSeconds = 60,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  Write-Output 'ERROR: node.exe not found in PATH. Install Node.js 18+ first.'
  exit 1
}
$env:HULA_ACCOUNT = $Account

function Read-Json($path) {
  Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

$cfgFile = Join-Path $Root 'config\config.json'
if (-not (Test-Path $cfgFile)) { $cfgFile = Join-Path $Root 'config\config.example.json' }
$cfg = Read-Json $cfgFile
$accountCfg = @($cfg.accounts | Where-Object { $_.id -eq $Account })[0]
if (-not $accountCfg) {
  Write-Output ("ERROR: unknown account " + $Account)
  exit 1
}
$appKeys = @($accountCfg.apps)

$appsCfg = Read-Json (Join-Path $Root 'config\apps.json')
$appDefs = @{}
foreach ($a in $appsCfg.apps) { $appDefs[$a.key] = $a }

$current = if ($cfg.currentAccount) { [string]$cfg.currentAccount } else { [string]$accountCfg.id }
if ($Account -ne $current) {
  Write-Output ("ERROR: config currentAccount is " + $current + ", but -Account is " + $Account + ".")
  Write-Output 'Switch WeChat to the target account and update currentAccount in config/config.json first.'
  exit 1
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WT {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
"@

function Test-Token($appKey) {
  & $Node (Join-Path $Root 'src\hula.js') $appKey token 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Find-WeChatPath {
  if ($cfg.wechatPath -and (Test-Path $cfg.wechatPath)) { return [string]$cfg.wechatPath }
  foreach ($name in @('Weixin', 'WeChat')) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p -and $p.Path) { return $p.Path }
  }
  foreach ($name in @('Weixin.exe', 'WeChat.exe')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Tencent\Weixin\Weixin.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Tencent\WeChat\WeChat.exe') }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Tencent\Weixin\Weixin.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\WeChat\WeChat.exe')
  }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Tencent\WeChat\WeChat.exe') }
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Get-WeChatProcess {
  foreach ($name in @('Weixin', 'WeChat')) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p }
  }
  return $null
}

# Login screen is a small window (~296x388); the logged-in UI is ~900 wide.
# MainWindowHandle is unreliable while WeChat is starting or minimized, so
# enumerate top-level windows and pick the visible chat window.
function Get-WeChatMainWindow {
  $targets = @{}
  foreach ($p in @(Get-Process Weixin, WeChat -ErrorAction SilentlyContinue)) {
    $targets[[uint32]$p.Id] = $true
  }
  $script:candidates = @()
  $cb = [WT+EnumProc]{
    param($h, $l)
    $wpid = 0
    [void][WT]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($targets.ContainsKey([uint32]$wpid)) {
      $r = New-Object WT+RECT
      if ([WT]::GetWindowRect($h, [ref]$r)) {
        $w = $r.R - $r.L
        $hh = $r.B - $r.T
        if ($w -gt 600 -and $hh -gt 400 -and $w -lt 4000) {
          $script:candidates += [pscustomobject]@{
            Handle = $h; L = $r.L; T = $r.T; W = $w; H = $hh
            Visible = [WT]::IsWindowVisible($h)
          }
        }
      }
    }
    return $true
  }
  [void][WT]::EnumWindows($cb, [IntPtr]::Zero)

  $visible = @($script:candidates | Where-Object { $_.Visible })
  $main = @($visible | Where-Object { $_.W -ge 600 -and $_.W -le 1200 -and $_.H -ge 400 -and $_.H -le 900 } |
    Sort-Object W | Select-Object -First 1)
  if (-not $main -or $main.Count -eq 0) {
    $main = @($visible | Sort-Object W | Select-Object -First 1)
  }
  if ($main -and $main.Count -gt 0) { return $main[0] }
  return $null
}

function Test-WeChatLoggedIn {
  return [bool](Get-WeChatMainWindow)
}

Write-Output ("started: " + (Get-Date -Format 'HH:mm:ss'))
$status = @{}
foreach ($appKey in $appKeys) { $status[$appKey] = Test-Token $appKey }
$statusLine = ($appKeys | ForEach-Object { "$_=$($status[$_])" }) -join ' '
Write-Output ("server accepts token: " + $statusLine)
$allOk = @($status.Values | Where-Object { -not $_ }).Count -eq 0
if ($allOk -and -not $Force) {
  Write-Output 'tokens still valid, nothing to do'
  exit 0
}

# --- 1. make sure WeChat is running -----------------------------------------
$wechat = Find-WeChatPath
if (-not $wechat) {
  Write-Output 'ERROR: WeChat not found. Set "wechatPath" in config/config.json.'
  exit 1
}
if (-not (Get-WeChatProcess)) {
  Write-Output ("starting " + $wechat)
  Start-Process -FilePath $wechat -WorkingDirectory (Split-Path -Parent $wechat)
  Start-Sleep -Seconds 8
}

# --- 2. enter the saved account if the login screen is up --------------------
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$entered = Test-WeChatLoggedIn
if ($entered) { Write-Output 'WeChat already logged in' }

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (-not $entered -and (Get-Date) -lt $deadline) {
  if (Test-WeChatLoggedIn) {
    Write-Output 'WeChat logged in automatically'
    $entered = $true
    break
  }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $wxProc = Get-WeChatProcess
  if (-not $wxProc) { Start-Sleep -Seconds 2; continue }
  $procCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $wxProc.Id)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $procCond)
  foreach ($w in $wins) {
    $nameCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, '进入微信')
    $btn = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
    if ($btn) {
      try {
        $pat = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pat.Invoke()
        Write-Output 'pressed 进入微信'
        $entered = $true
      } catch {
        Write-Output ("invoke failed: " + $_.Exception.Message)
      }
      break
    }
  }
  if (-not $entered) { Start-Sleep -Seconds 2 }
}
if (-not $entered) {
  Write-Output '登录态未就绪（可能弹出扫码窗口）。请手动扫码登录微信后重试。'
  # Do not exit: the mini-program opener may still find the window once WeChat
  # finishes loading, and a locked/minimized window can be restored.
}

# --- 3. wait for the mini-program runtimes ---------------------------------
$ok = $false
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (-not $ok -and (Get-Date) -lt $deadline) {
  $procs = Get-Process WeChatAppEx -ErrorAction SilentlyContinue
  if ($procs) {
    $big = @($procs | Where-Object { $_.WorkingSet64 -gt 150MB })
    if ($big.Count -gt 0) { $ok = $true; break }
  }
  Start-Sleep -Seconds 2
}
Write-Output ("mini-program runtimes ready: " + $ok)
if (-not $ok) {
  Write-Output 'mini-program runtime not ready yet; will try to open the mini-programs.'
}
Start-Sleep -Seconds 5

# --- 3.5 open the mini-programs that need a fresh token ----------------------
# Scanning memory alone only finds the OLD token: WeChat keeps the container
# alive but does not call wx.login again until the mini-program is opened.
# Opening it is what produces a new access_token.
$toOpen = @()
if ($Force) {
  $toOpen = @($appKeys)
} else {
  foreach ($key in $appKeys) {
    if (-not $status[$key]) { $toOpen += $key }
  }
}
foreach ($key in $toOpen) {
  $def = $appDefs[$key]
  if (-not $def) {
    Write-Output ("WARNING: no app definition for " + $key)
    continue
  }
  Write-Output ("opening mini-program: " + $def.name)
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\open_miniprogram.ps1') -Name $def.name -AppId $def.appid -Force
  if ($LASTEXITCODE -ne 0) {
    Write-Output ("WARNING: failed to open " + $def.name + " - open it manually once")
  }
}
if ($toOpen.Count -gt 0) { Start-Sleep -Seconds 6 }

# --- 4. harvest -------------------------------------------------------------
$tmp = Join-Path $Root 'data\tmp\tokens.txt'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\scan_tokens.ps1') -OutFile $tmp
if ($LASTEXITCODE -ne 0) {
  Write-Output 'scan failed'
  exit 1
}
& $Node (Join-Path $Root 'tools\save_tokens.js') --account $Account
if ($LASTEXITCODE -ne 0) {
  Write-Output 'save_tokens failed'
  exit 1
}

# --- 5. verify against the server ------------------------------------------
$after = @{}
foreach ($appKey in $appKeys) { $after[$appKey] = Test-Token $appKey }
$afterLine = ($appKeys | ForEach-Object { "$_=$($after[$_])" }) -join ' '
Write-Output ("after harvest: " + $afterLine)
Write-Output ("finished: " + (Get-Date -Format 'HH:mm:ss'))
$afterOk = @($after.Values | Where-Object { -not $_ }).Count -eq 0
if (-not $afterOk) {
  Write-Output 'REFRESH FAILED'
  exit 1
}
exit 0
