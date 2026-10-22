param(
  [string]$OutFile = '',
  [string]$ProcName = 'WeChatAppEx',
  [int]$MinLen = 20
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $Root 'data\tmp\tokens.txt' }
$outDir = Split-Path -Parent $OutFile
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
Set-Content -Path $OutFile -Value '' -Encoding ASCII

if ([IntPtr]::Size -ne 8) {
  Write-Output 'ERROR: this script must run in 64-bit PowerShell (WeChatAppEx is a 64-bit process).'
  Write-Output 'Open "Windows PowerShell" (not x86) and try again.'
  exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MemScan2 {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [StructLayout(LayoutKind.Sequential)] public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
    public IntPtr RegionSize; public uint State; public uint Protect; public uint Type;
  }
  [DllImport("kernel32.dll")] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, IntPtr len);
}
"@

$procs = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
if (-not $procs) {
  Write-Output "no process $ProcName - open WeChat and the mini-program once, then try again"
  exit 1
}

# Bearer tokens and appLogin bodies both carry these markers.
$patterns = @(
  '"access_token"\s*:\s*"([^"]{20,})"',
  'authorization[\s:]+bearer\s+([A-Za-z0-9._\-]{20,})',
  '"token"\s*:\s*"([A-Za-z0-9._\-]{20,})"'
)

$seen = @{}

function Scan-Proc([int]$procId) {
  $PROCESS_VM_READ = 0x0010
  $PROCESS_QUERY_INFORMATION = 0x0400
  $h = [MemScan2]::OpenProcess($PROCESS_VM_READ -bor $PROCESS_QUERY_INFORMATION, $false, $procId)
  if ($h -eq [IntPtr]::Zero) { return }
  try {
    $addr = [IntPtr]::Zero
    $mbiSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][MemScan2+MEMORY_BASIC_INFORMATION])
    while ($true) {
      $mbi = New-Object MemScan2+MEMORY_BASIC_INFORMATION
      $q = [MemScan2]::VirtualQueryEx($h, $addr, [ref]$mbi, [IntPtr]$mbiSize)
      if ($q -eq 0) { break }
      $size = [int64]$mbi.RegionSize
      $prot = $mbi.Protect -band 0xFF
      $readable = ($mbi.State -eq 0x1000) -and (($mbi.Protect -band 0x100) -eq 0) -and (
        $prot -eq 0x02 -or $prot -eq 0x04 -or $prot -eq 0x08 -or
        $prot -eq 0x20 -or $prot -eq 0x40 -or $prot -eq 0x80)
      if ($readable -and $size -gt 0 -and $size -lt 200MB) {
        if ($size -gt 64MB) { $size = 64MB }
        $buf = New-Object byte[] $size
        $read = [IntPtr]::Zero
        $ok = [MemScan2]::ReadProcessMemory($h, $mbi.BaseAddress, $buf, [IntPtr]$size, [ref]$read)
        if ($ok -and $read.ToInt64() -gt 0) {
          $n = [int]$read.ToInt64()
          $text = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
          foreach ($pat in $patterns) {
            foreach ($m in [regex]::Matches($text, $pat)) {
              $tok = $m.Groups[1].Value
              if ($tok.Length -ge $MinLen -and -not $seen.ContainsKey($tok)) {
                $seen[$tok] = "pid=$procId"
                Write-Output ("HIT " + $seen[$tok] + " len=" + $tok.Length)
                Add-Content -Path $OutFile -Value $tok -Encoding ASCII
              }
            }
          }
        }
      }
      $next = $mbi.BaseAddress.ToInt64() + [int64]$mbi.RegionSize
      if ($next -le $addr.ToInt64()) { break }
      $addr = [IntPtr]$next
    }
  } finally {
    [void][MemScan2]::CloseHandle($h)
  }
}

foreach ($p in $procs) {
  Write-Output "### pid=$($p.Id) $($p.ProcessName)"
  Scan-Proc $p.Id
}
Write-Output ("total unique token candidates: " + $seen.Count)
Write-Output ("written to: " + $OutFile)
