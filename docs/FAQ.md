# 常见问题

## token 相关

### `token missing for hula (run harvest.bat)`

还没抓过 token。登录微信，打开目标小程序一次，然后：

```bat
harvest.bat --account default
```

### `no candidate accepted`

扫描到了候选，但服务端一个都不认。常见原因：

1. 微信没有登录，或者登录的不是配置对应的账号；
2. 目标小程序没有打开过，容器里没有新 token；
3. token 已过期，微信没有重新 `appLogin`；
4. 小程序版本/接口变了。

处理：打开小程序一次，重新 `harvest.bat`。仍然失败就检查微信版本和 `config/apps.json` 的 `version` / `pkgVersion`。

### `failed to open ...` / 自动刷新失败

`refresh_token_auto.ps1` 会在 token 失效时自动打开小程序。失败常见原因：

- 微信停在扫码登录页，需要手机扫码；
- 电脑锁屏/休眠，UI 自动化点不到；
- 微信被最小化到托盘；
- 微信/小程序 UI 改版，自动点击位置失效；
- 微信 3.x 的数据目录与 4.x 不同，自动打开可能无法确认结果。

处理：解锁电脑，确认微信已登录，手动打开目标小程序一次，然后：

```bat
harvest.bat --account default
daily.bat
```

### `no process WeChatAppEx`

微信没运行，或者小程序容器没启动。登录微信并打开小程序一次。

### `this script must run in 64-bit PowerShell`

`WeChatAppEx.exe` 是 64 位进程，必须用 64 位 PowerShell 读取。`harvest.bat` 默认调用系统 PowerShell；如果系统默认是 32 位，请手动打开 64 位 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan_tokens.ps1 -OutFile data\tmp\tokens.txt
node tools\save_tokens.js --account default
```

## 微信相关

### `WeChat not found`

在 `config/config.json` 里设置：

```json
"wechatPath": "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"
```

注意 JSON 里反斜杠要写两个。

### 微信窗口被拉起 / 停在登录页

token 失效时，`refresh_token_auto.ps1` 会启动微信。如果微信需要扫码，脚本无法自动完成，会打印 `登录态未就绪`。手动扫码登录后再运行 `daily.bat`。

如果微信被最小化到托盘，自动刷新可能误判登录态；先把微信主窗口打开，再运行 `daily.bat` 或 `harvest.bat`。

### 会不会影响微信聊天

不会接管聊天流量，也不安装证书。只读取 `WeChatAppEx.exe` 的内存。部分杀毒软件可能会拦截 `ReadProcessMemory`，需要自行放行或关闭实时防护后重试。

## 多账号

### 第二个账号的 token 总是失败

微信 PC 同一时间只能登录一个账号。只有当前登录账号能刷新自己的 token。切到第二个账号，打开小程序一次，把 `config/config.json` 的 `currentAccount` 改成 `second`，然后运行：

```bat
harvest.bat --account second
```

跑完后再把 `currentAccount` 改回你实际在用的账号。否则自动刷新会拒绝为非当前账号抓 token，避免把两个账号的 token 串在一起。

### 每天跑所有账号会不会串号

不会。每个账号的 token/状态/日志都在 `data/accounts/<id>/`，按目录隔离。

## 定时任务

### 9:00 没跑

- 电脑必须开着；关机时任务不会执行。
- `WeChatMiniCatchup` 每 30 分钟检查一次，开机后会补跑。
- 检查任务计划程序里 `WeChatMiniCheckin` / `WeChatMiniCatchup` 是否存在并启用。
- 创建任务可能需要管理员权限。

### 想改时间

任务计划程序 → `WeChatMiniCheckin` → 触发器 → 修改时间。或者删除任务后重新运行 `install_task.bat`。

## 通知

### 没有弹 toast

- Windows 设置 → 系统 → 通知，确认“Windows PowerShell”没有被关闭。
- 检查 `data/logs/notify.log` 是否有 `toast failed`。
- 可以用 `powershell -File tools\notify.ps1 -Title test -Message test` 单独测试。

### 手机没有收到推送

- 检查 `config/config.json` 的 `notify.webhook` 是否填了 `type` 和 `url`。
- 检查 `data/logs/notify.log` 是否有 `pushed via` 或 `push failed`。
- ntfy 在某些网络环境可能不可达；可以换 Server酱/PushPlus/飞书。
