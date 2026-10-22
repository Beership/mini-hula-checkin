# 技术说明（学习用）

> 这些接口是第三方 SaaS（星云有客 / iyouke）小程序模板的**私有接口**，不是公开 API。仅用于学习 HTTP、Node.js、Windows 进程内存读取和自动化编排。请勿用于商业或批量滥用。

## 鉴权

- 登录接口：`POST /dtapi/appLogin`，body `{"appType":1,"principal":"<wx.login 的 code>"}`。
- 返回 `access_token`（Bearer），声明有效期 24 小时。
- 请求头需要：`authorization: bearer <token>`、`appid`、`version`、`envversion`、`xy-extra-data`。
- 没有请求签名。

`principal` 只能由微信客户端生成，所以外部程序无法自己登录；本项目的做法是从已经登录的小程序容器内存里读取 token。

## 主要接口

| 用途 | 方法/路径 |
|---|---|
| 积分信息 | `GET /dtapi/pointsSign/user/pointsInfo/query` |
| 每日签到 | `GET /dtapi/pointsSign/user/sign` |
| 任务列表 | `GET /dtapi/points/task/list` |
| 单个任务 | `GET /dtapi/points/task/{type}` |
| 领取任务 | `POST /dtapi/points/task/submit` `{taskType, bizId?}` |
| 发心愿 | `POST /dtapi/p/myWish/wish` `{wishContent, brand, category, pic}` |
| 心愿配额 | `POST /dtapi/p/wish/contentConf` |
| 直播列表 | `GET /dtapi/channel/live/list` |
| 订阅直播 | `POST /dtapi/channel/live/subscribe/{liveId}` |
| 直播详情 | `GET /dtapi/channel/live/detail/{liveId}` |
| 直播领奖 | `POST /dtapi/channel/live/grantReward/{liveId}` |

任务类型：

| type | 含义 |
|---|---|
| 2 | 查看直播预告 |
| 3 | 订阅直播预告 |
| 4 | 每日签到 |
| 22 | 发布心愿 |

## 签到

`GET /dtapi/pointsSign/user/sign` 是 GET 但会改状态，不要当探针反复调用。签到前先看 `pointsInfo` 的 `signTodayResult`；已经是 true 就跳过。

## 心愿

- 发布和领奖是两步：先发满本周期配额，再调 `POST /points/task/submit {taskType:22}`。
- 领取可能返回“任务提交中，请稍候”，这是“稍后重试”，不是“已完成”。
- 只有“任务已完成”才结束领取循环。
- 判断有没有拿到分，看余额差值，不要只看 `status`。

## 直播

- 订阅：只对 `liveStatus === 1`（预告）且 `subscribe !== true` 的场次发请求。
- 查看：打开详情页，等待几秒，再 `grantReward`，然后 `submit {taskType:2, bizId:liveId}`。
- 按场计分，已领过的场次会返回“任务已完成”，这是正常现象。

## token 生命周期

- token 明文存在 `WeChatAppEx.exe` 的托管堆里。
- `scan_tokens.ps1` 用 `ReadProcessMemory` 扫描可读内存区，匹配 bearer token 形状。
- `save_tokens.js` 逐个调 `pointsInfo` 验证，只有服务端接受的才保存。
- token 过期后，`refresh_token_auto.ps1` 启动微信、找到主窗口、自动打开目标小程序触发 `wx.login` / `appLogin`，再扫描内存保存新 token。
- 只启动微信并扫描内存是不够的：小程序容器会保留旧 token，必须让小程序重新登录（打开它）才会签发新 token。
- 本地 `expires_at` 只是估计值，最终以服务端应答为准。

## 安全边界

- 不安装根证书，不做 MITM，不接管微信聊天流量。
- 只读取 `WeChatAppEx.exe` 内存中的 token 字符串。
- token 只保存在本机 `data/`，不上传。
- 不收集账号密码。
