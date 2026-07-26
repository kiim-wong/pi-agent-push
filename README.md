# pi-push

pi 主 agent 停下来的时候，把消息推到你手机 / 群里。

支持：Bark、飞书、企业微信、钉钉、**ntfy**、通用 Webhook。全部发**纯文本**。

## 安装

```bash
pi install npm:pi-agent-push
# 或
pi install git:github.com/kiim-wong/pi-push
```

然后复制示例配置（若包未自动带出可写路径）：

```bash
# 全局扩展目录下编辑配置，或用命令配置：
# /push set ntfy topic=your-topic enabled=true
# /push test ntfy
```

配置文件默认：`~/.pi/agent/extensions/` 由 pi 包管理器安装后的扩展数据目录；也可用环境变量 `PI_PUSH_CONFIG` 指向自定义 `config.json`。仓库内的 `config.example.json` 是模板，**不要**提交真实 key。

---
## 快速开始

1. 打开 `config.json`，把要用的渠道填上 key，并把该渠道的 `"enabled"` 改成 `true`
2. 重启 pi，或在会话里执行 `/reload`
3. `/push test` —— 会逐个渠道打出 HTTP 结果

```
/push                         状态
/push list                    列出渠道
/push get <渠道>              查看配置（密钥脱敏）
/push enable|disable <渠道>   开关渠道（写 config.json）
/push set <渠道> k=v [k=v…]   设置 topic/token/deviceKey/url…
/push test [渠道]             测试（可只测一个）
/push events [k=on|off…]      全局事件开关
/push on|off                  当前会话总开关（不写盘）
/push help
```

渠道选择器：`ntfy` / 名称 / `ntfy#1` / 序号。

```
/push set ntfy topic=my-topic token=tk_xxx enabled=true
/push enable ntfy
/push test ntfy
```

## 什么时候会推送

| 事件 | 触发时机 | 默认 | 文案 |
|---|---|---|---|
| `idle` | 模型回答完、自动重试和自动压缩都结束，pi 真正在等你 | 开 | `pi 已就绪 · 输出结束，等待输入` |
| `interrupted` | 本轮被 Esc 取消 | 开 | `pi 已中断 · 本轮被取消` |
| `interrupted` | 本轮报错（重试用尽后） | 开 | `pi 已中断 · 运行出错：401 authentication_error: invalid x-api-key` |
| `needInput` | 调用了 `ask_user_question` 之类的提问工具 | 开 | `pi 需要确认 · pi 正在等你回答问题` |
| `exit` | 会话退出（Ctrl+C / Ctrl+D / `/quit`） | **关** | `pi 已退出 · 会话结束` |

`idle` 和 `interrupted` 都在 pi 的 `agent_settled` 事件里判定，所以**自动重试不会重复推送**——一次用户可感知的"pi 停下来了"只对应一条消息。

## 渠道配置

`config.json` 的 `channels` 是数组，可以配多个（含同类型多个）。每个渠道都支持
`name`（日志显示名）、`enabled`、`timeoutMs`、`events`（覆盖全局开关）。

### Bark（iOS）

```json
{ "type": "bark", "enabled": true, "deviceKey": "$BARK_KEY",
  "server": "https://api.day.app", "sound": "bell", "group": "pi", "level": "active" }
```

`deviceKey` 是 App 里那串 key。自建 bark-server 改 `server` 即可（用的是
`POST /:device_key`，V1/V2 服务端都兼容）。

### 飞书群机器人

```json
{ "type": "feishu", "enabled": true,
  "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx", "secret": "" }
```

只有开启了「签名校验」才需要 `secret`。用「自定义关键词」的话，把关键词写进
`template` 里。

### 企业微信群机器人

```json
{ "type": "wecom", "enabled": true,
  "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx" }
```

### 钉钉群机器人

```json
{ "type": "dingtalk", "enabled": true,
  "url": "https://oapi.dingtalk.com/robot/send?access_token=xxxx", "secret": "SECxxxx" }
```

加签模式填 `secret`；关键词模式请把关键词写进 `template`，否则钉钉会返回
`errcode=310000`（插件会把它当作失败记进日志）。

### ntfy

```json
{ "type": "ntfy", "enabled": true, "topic": "$NTFY_TOPIC",
  "server": "https://ntfy.sh", "token": "$NTFY_TOKEN",
  "priority": "default", "tags": "pi,computer" }
```

`topic` 在公共服务器上相当于密码，请用难猜的名字。自建 ntfy 改 `server`。
需要 access token 时填 `token`（自动加 `Authorization: Bearer`）。
`priority` 支持 `1`-`5` 或 `min|low|default|high|max`。

### 通用 Webhook

```json
{ "type": "webhook", "name": "my-hook", "enabled": true,
  "url": "https://example.com/push",
  "method": "POST",
  "headers": { "Authorization": "Bearer ${MY_TOKEN}" },
  "body": { "text": "{{text}}", "meta": { "event": "{{event}}", "project": "{{project}}" } },
  "events": { "idle": false, "interrupted": true } }
```

**`body` 建议写成 JSON 对象**：占位符先替换进结构、再整体序列化，错误信息里的引号和
换行永远不会破坏 JSON。写成字符串模板也支持，会按 `contentType` 自动转义。
`url` 里的占位符会做 URL 编码。

## 全部配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `modes` | `["tui"]` | 允许推送的 pi 运行模式，见下方说明 |
| `timeoutMs` | `5000` | 单次请求超时 |
| `shutdownTimeoutMs` | `2000` | 退出时最多阻塞多久发消息 |
| `dedupeMs` | `3000` | 相同内容在此窗口内只发一次 |
| `minDurationSec` | `0` | 本轮短于该秒数时不发 `idle`（中断不受影响） |
| `maxTextChars` | `500` | 正文截断长度 |
| `titleTemplate` | `pi {{status}}` | 标题模板（Bark 用） |
| `template` | `pi {{status}} · {{reason}}` | 正文模板 |
| `events` | 见上表 | 全局事件开关 |
| `needInputTools` | `["ask_user_question"]` | 哪些工具算"在问你" |
| `debug` | `false` | 成功也记日志 |

占位符：`{{status}} {{reason}} {{text}} {{title}} {{event}} {{cwd}} {{project}}
{{duration}} {{session}} {{model}} {{host}} {{time}} {{date}}`

值写成 `"$VAR"` 会整体取环境变量，写成 `"Bearer ${VAR}"` 可嵌入替换——key 不必落盘。

配置文件按 mtime 热读，改完**不需要** `/reload`（改插件代码才需要）。

### 为什么 `modes` 默认只有 `tui`

pi 的 subagent 是用 `pi --mode json -p` 拉子进程跑的，全局扩展在子进程里同样会加载。
如果放开 `json`/`print`，每个 subagent 跑完都会推一条，纯噪音。确实想给批处理任务
推送时，再把 `print` 加进去。

## 排错

- `/push test` 会直接显示每个渠道的 HTTP 状态或错误原因
- 失败会记到 `push.log`（和 `config.json` 同目录）；`"debug": true` 时成功也记
- 群机器人 HTTP 200 但业务失败（签名错、缺关键词、限流）会被判定为**失败**并记录
  错误码，不会假装成功

## 已知限制

- **SIGKILL / 断电 / 终端被强杀**收不到通知：这类情况 pi 不会触发 `session_shutdown`，
  进程内无从发出请求
- **pi 自身崩溃**（uncaughtException）同样收不到：pi 的崩溃处理器先注册、且同步
  `process.exit(1)`，异步请求来不及发出
- 只能感知**工具形式**的提问（`needInputTools`）；其它扩展直接弹的确认框拦不到

## 自测

```bash
cd ~/.pi/agent/extensions/pi-push && node test/run.ts   # 需要 Node >= 23
```

会起一个本地 HTTP 服务假扮各渠道，跑自测断言：签名算法（对拍官方算法的固定
向量）、各渠道报文结构、去重、超时、模式隔离、JSON 转义、渠道级开关覆盖、命令行为等。
