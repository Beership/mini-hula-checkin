param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$AppId,
  [switch]$Force,
  [int]$SearchWait = 3,
  [int]$ClickWait = 3,
  [int[]]$Offsets = @(144, 133, 100, 120, 160, 180, 200, 220, 250, 280, 310, 340)
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OMW {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
Add-Type -AssemblyName System.Windows.Forms

function Get-WeChatWindow {
  $targets = @{}
  foreach ($p in @(Get-Process Weixin, WeChat -ErrorAction SilentlyContinue)) {
    $targets[[uint32]$p.Id] = $true
  }
  $script:candidates = @()
  $cb = [OMW+EnumProc]{
    param($h, $l)
    $wpid = 0
    [void][OMW]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($targets.ContainsKey([uint32]$wpid)) {
      $r = New-Object OMW+RECT
      if ([OMW]::GetWindowRect($h, [ref]$r)) {
        $w = $r.R - $r.L
        $hh = $r.B - $r.T
        if ($w -gt 600 -and $hh -gt 400 -and $w -lt 4000) {
          $script:candidates += [pscustomobject]@{
            Handle = $h
            L = $r.L
            T = $r.T
            W = $w
            H = $hh
            Visible = [OMW]::IsWindowVisible($h)
          }
        }
      }
    }
    return $true
  }
  [void][OMW]::EnumWindows($cb, [IntPtr]::Zero)

  $visible = @($script:candidates | Where-Object { $_.Visible })
  $main = @($visible | Where-Object { $_.W -ge 600 -and $_.W -le 1200 -and $_.H -ge 400 -and $_.H -le 900 } |
    Sort-Object W | Select-Object -First 1)
  if (-not $main -or $main.Count -eq 0) {
    $main = @($visible | Sort-Object W | Select-Object -First 1)
  }
  if (-not $main -or $main.Count -eq 0) {
    $main = @($script:candidates | Sort-Object W | Select-Object -First 1)
  }
  if ($main -and $main.Count -gt 0) { return $main[0] }
  return $null
}

function Get-AppActivity([string]$appid) {
  $base = Join-Path $env:APPDATA 'Tencent\xwechat\radium\users'
  $latest = [datetime]::MinValue
  foreach ($d in @(Get-ChildItem $base -Directory -ErrorAction SilentlyContinue)) {
    $p = Join-Path $d.FullName ('applet\local\' + $appid)
    if (Test-Path $p) {
      $f = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($f -and $f.LastWriteTime -gt $latest) { $latest = $f.LastWriteTime }
    }
  }
  return $latest
}

function Activate-Window($win) {
  [void][OMW]::ShowWindow($win.Handle, 9)
  [void][OMW]::ShowWindow($win.Handle, 5)
  [void][OMW]::BringWindowToTop($win.Handle)
  [void][OMW]::SetForegroundWindow($win.Handle)
  Start-Sleep -Milliseconds 800
}

function Click-At([int]$x, [int]$y) {
  [void][OMW]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 120
  [OMW]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [OMW]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}

function Focus-Search($win) {
  $x = $win.L + [int]($win.W * 0.184)
  $y = $win.T + [int]($win.H * 0.0875)
  Click-At $x $y
}

function Paste-Search([string]$text) {
  [System.Windows.Forms.Clipboard]::SetText($text)
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('^v')
}

$win = Get-WeChatWindow
if (-not $win) {
  Write-Output 'no WeChat main window (log in to WeChat first)'
  exit 1
}
Write-Output ("window=" + $win.L + "," + $win.T + " " + $win.W + "x" + $win.H)

$before = Get-AppActivity $AppId
Write-Output ("activity before: " + $before)
if (-not $Force -and $before -gt (Get-Date).AddMinutes(-1)) {
  Activate-Window $win
  Write-Output ("already active: " + $Name)
  exit 0
}

foreach ($offset in @($Offsets)) {
  Activate-Window $win
  Focus-Search $win
  Start-Sleep -Milliseconds 400
  Paste-Search $Name
  Start-Sleep -Seconds $SearchWait

  $x = $win.L + [int]($win.W * 0.16)
  $y = $win.T + [int]($offset * $win.H / 640)
  Write-Output ("try offset=" + $offset + " click=" + $x + "," + $y)
  Click-At $x $y
  Start-Sleep -Seconds $ClickWait

  $after = Get-AppActivity $AppId
  if ($after -gt $before) {
    Write-Output ("opened " + $Name + " (activity " + $after + ")")
    exit 0
  }
}

Write-Output ("failed to open " + $Name)
exit 1
