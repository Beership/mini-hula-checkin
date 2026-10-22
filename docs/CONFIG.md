# 配置说明

## `config/apps.json`

定义“要跑哪些小程序”。`base` 是后端域名，`apps` 是数组。

```json
{
  "base": "smp-api.iyouke.com",
  "apps": [
    {
      "key": "hula",
      "name": "呼啦圈会员中心",
      "appid": "wx89a714fb03b61b99",
      "version": "2.33.3",
      "pkgVersion": "43",
      "wish": { "cycle": "every_day", "limit": 3, "cycleValue": 3, "points": 1 },
      "signPoints": 1,
      "hasViewLiveTask": true,
      "subscribePoints": 1
    }
  ]
}
```

- `key`：内部唯一标识，不能重复。
- `appid`：小程序的 appid，请求头里用它区分租户。
- `version`：请求头 `version` 和 `xy-extra-data` 里的版本。
- `pkgVersion`：`referer` 里的包版本。
- `wish.limit`：一个周期最多发几条心愿。
- `wish.cycleValue`：一个周期最多领几次心愿奖励。
- `hasViewLiveTask`：是否有“查看直播预告”任务。

## `config/config.json`

首次运行 `setup.bat` 会从 `config.example.json` 复制。字段：

| 字段 | 说明 |
|---|---|
| `wechatPath` | 可选。微信可执行文件路径；留空自动查找 |
| `startHour` | 补跑脚本认为“今天应该跑”的起始小时，默认 9 |
| `currentAccount` | 当前微信登录的账号 id；只有它能抓取/刷新 token |
| `accounts` | 账号数组，每个账号有 `id`、`name`、`apps` |
| `notify.toast` | 是否弹 Windows 通知，默认 true |
| `notify.webhook` | 可选手机推送配置 |

账号示例：

```json
{
  "id": "default",
  "name": "我的账号",
  "apps": ["hula", "jiejie"]
}
```

- `id` 只能包含字母、数字、`-`、`_`，会作为目录名。
- 每个账号的 token/日志/状态在 `data/accounts/<id>/`。
- 一个账号对应一个微信登录。微信 PC 同一时间只能登录一个账号，所以多账号抓 token 时需要切换登录。

## `data/` 目录

```
data/
├─ accounts/
│  └─ <id>/
│     ├─ tokens/
│     │  ├─ hula.json
│     │  └─ jiejie.json
│     ├─ state/
│     │  └─ hula_subscribed.json
│     ├─ logs/
│     │  ├─ hula.log
│     │  └─ jiejie.log
│     ├─ last_result_hula.json
│     └─ last_result_jiejie.json
├─ tmp/
│  └─ tokens.txt          抓取时的临时候选，成功后自动删除
├─ logs/
│  ├─ daily.log
│  ├─ notify.log
│  ├─ refresh.log
│  └─ catchup.log
├─ last_run.txt           今天是否已成功跑完（补跑用）
├─ last_run.json          最近一次运行的机器可读结果
├─ last_status.txt        最近一次通知的人类可读摘要
└─ last_status.json
```

`data/` 全部被 `.gitignore` 忽略。**不要把 token 提交到 GitHub。**

## 通知 webhook

```json
"notify": {
  "toast": true,
  "webhook": {
    "type": "ntfy",
    "url": "https://ntfy.sh/your-random-topic",
    "token": ""
  }
}
```

- `ntfy`：`url` 是 topic 地址。
- `serverchan`：`url` 是 `https://sctapi.ftqq.com/<SendKey>.send`。
- `pushplus`：`url` 是 `https://www.pushplus.plus/send`，`token` 填 token。
- `feishu`：`url` 是群机器人 webhook。
- `generic`：POST `{title, message, kind}`。

不需要手机推送时，把 `type` 和 `url` 留空即可。
