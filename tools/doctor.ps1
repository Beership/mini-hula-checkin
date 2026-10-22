$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$fail = 0

function Ok($msg) { Write-Output ("[OK]   " + $msg) }
function Bad($msg) { Write-Output ("[FAIL] " + $msg); $script:fail++ }
function Warn($msg) { Write-Output ("[WARN] " + $msg) }

Write-Output '=== Hula Auto Doctor ==='
Write-Output ''

# 1. PowerShell bitness
if ([IntPtr]::Size -eq 8) { Ok '64-bit PowerShell' }
else { Bad '需要 64 位 PowerShell（当前是 32 位），否则读不到 WeChatAppEx 内存' }

# 2. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $ver = (& $node.Source -v) 2>$null
  Ok ("Node.js " + $ver + " (" + $node.Source + ")")
} else {
  Bad '未找到 Node.js，请安装 Node.js 18+（https://nodejs.org/）'
}

# 3. Config
$appsFile = Join-Path $Root 'config\apps.json'
$cfgFile = Join-Path $Root 'config\config.json'
if (-not (Test-Path $appsFile)) {
  Bad '缺少 config\apps.json'
  Write-Output ''
  Write-Output ("检查未通过：" + $fail + " 项")
  exit 1
} else {
  Ok 'config\apps.json 存在'
}
if (-not (Test-Path $cfgFile)) {
  Warn '没有 config\config.json，将使用 config.example.json（默认账号）'
  $cfgFile = Join-Path $Root 'config\config.example.json'
}
if (-not (Test-Path $cfgFile)) {
  Bad '缺少 config\config.example.json'
  Write-Output ''
  Write-Output ("检查未通过：" + $fail + " 项")
  exit 1
}

$cfg = $null
try { $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
  Bad 'config JSON 解析失败：' + $_.Exception.Message
}
if (-not $cfg) {
  Write-Output ''
  Write-Output ("检查未通过：" + $fail + " 项")
  exit 1
}
Ok ("currentAccount: " + $cfg.currentAccount)

# 4. Data dirs
$dataDir = if ($env:HULA_DATA_DIR) { [IO.Path]::GetFullPath($env:HULA_DATA_DIR) } else { Join-Path $Root 'data' }
foreach ($d in @($dataDir, (Join-Path $dataDir 'tmp'), (Join-Path $dataDir 'logs'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Ok ("data 目录: " + $dataDir)

# 5. WeChat
$wx = Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | Select-Object -First 1
if ($wx) { Ok ("微信进程: " + $wx.ProcessName + " (pid " + $wx.Id + ")") }
else { Bad '微信没有运行，请先登录微信' }
$appex = Get-Process WeChatAppEx -ErrorAction SilentlyContinue
if ($appex) {
  $big = @($appex | Where-Object { $_.WorkingSet64 -gt 150MB })
  if ($big.Count -gt 0) { Ok 'WeChatAppEx 运行中（token 检查会确认小程序是否已登录）' }
  else { Warn 'WeChatAppEx 存在但工作集较小，可能还没打开小程序' }
} else {
  Warn '没有 WeChatAppEx，请打开目标小程序一次'
}

# 6. Tokens
if ($node) {
  foreach ($account in @($cfg.accounts)) {
    $env:HULA_ACCOUNT = $account.id
    foreach ($key in @($account.apps)) {
      & $node.Source (Join-Path $Root 'src\hula.js') $key token 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Ok ("账号 " + $account.id + " / " + $key + " token 有效")
      } else {
        Bad ("账号 " + $account.id + " / " + $key + " token 无效或缺失")
        if ($account.id -eq $cfg.currentAccount) {
          Write-Output ("       打开微信里的目标小程序一次，然后运行: harvest.bat --account " + $account.id)
        } else {
          Write-Output ("       当前配置的微信账号是 " + $cfg.currentAccount + "；要刷新这个账号，请先切换微信，并把 currentAccount 改成 " + $account.id)
        }
      }
    }
  }
}

Write-Output ''
if ($fail -eq 0) {
  Write-Output '全部通过。可以运行 daily.bat，或运行 install_task.bat 设置每天 9:00 自动签到。'
  exit 0
}
Write-Output ("检查未通过：" + $fail + " 项，请按上面的提示处理。")
exit 1
