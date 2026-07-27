# pi-agent-push

Push a message to your phone or group chat when the pi main agent settles: Bark, Feishu, WeCom, DingTalk, ntfy, or a generic Webhook. All payloads are **plain text**.

## Install

```bash
pi install npm:pi-agent-push
# or from GitHub:
pi install git:github.com/kiim-wong/pi-agent-push
```

Restart pi or run `/reload` after install.

## Config

Pick one:

1. **CLI (recommended)**
   ```text
   /push set ntfy topic=your-topic enabled=true
   /push test ntfy
   ```
2. **Config file**  
   Create `config.json` in the extension directory (see package `config.example.json`).  
   Or point env `PI_AGENT_PUSH_CONFIG` at a custom path.

> The repo / npm package does **not** ship real keys; keep your local `config.json` private.

---

## Quick start

1. Open `config.json`, fill in keys for the channels you want, set that channel's `"enabled"` to `true`
2. Restart pi, or run `/reload` in the session
3. `/push test` — prints HTTP results per channel

```
/push                         status
/push list                    list channels
/push get <channel>           view config (secrets redacted)
/push enable|disable <channel> toggle channel (writes config.json)
/push set <channel> k=v [k=v…] set topic/token/deviceKey/url…
/push test [channel]          test (optionally one channel)
/push events [k=on|off…]      global event toggles
/push on|off                  session master switch (not persisted)
/push help
```

Channel selector: `ntfy` / name / `ntfy#1` / index.

```
/push set ntfy topic=my-topic token=tk_xxx enabled=true
/push enable ntfy
/push test ntfy
```

## When it pushes

| Event | Trigger | Default | Message |
|---|---|---|---|
| `idle` | Model finished, auto-retry and auto-compaction done, pi is truly waiting for you | on | `pi ready · output finished, waiting for input` |
| `interrupted` | Turn cancelled with Esc | on | `pi interrupted · turn cancelled` |
| `interrupted` | Turn errored (after retries exhausted) | on | `pi interrupted · runtime error: 401 authentication_error: invalid x-api-key` |
| `needInput` | A question tool like `ask_user_question` was called | on | `pi needs input · pi is waiting for your answer` |
| `exit` | Session exit (Ctrl+C / Ctrl+D / `/quit`) | **off** | `pi exited · session ended` |

Both `idle` and `interrupted` are decided inside pi's `agent_settled` event, so **auto-retries do not spam** — one user-visible "pi settled" maps to one message.

## Channel config

`config.json` `channels` is an array; you can configure many (including multiple of the same type). Every channel supports `name` (log display name), `enabled`, `timeoutMs`, and `events` (overrides global toggles).

### Bark (iOS)

```json
{ "type": "bark", "enabled": true, "deviceKey": "$BARK_KEY",
  "server": "https://api.day.app", "sound": "bell", "group": "pi", "level": "active" }
```

`deviceKey` is the key shown in the app. For a self-hosted bark-server, change `server` (uses `POST /:device_key`, compatible with V1/V2 servers).

### Feishu group bot

```json
{ "type": "feishu", "enabled": true,
  "url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx", "secret": "" }
```

`secret` is only needed when signature verification is enabled. With custom keywords, put the keyword in `template`.

### WeCom group bot

```json
{ "type": "wecom", "enabled": true,
  "url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx" }
```

### DingTalk group bot

```json
{ "type": "dingtalk", "enabled": true,
  "url": "https://oapi.dingtalk.com/robot/send?access_token=xxxx", "secret": "SECxxxx" }
```

For sign mode, set `secret`; for keyword mode, put the keyword in `template`, otherwise DingTalk returns `errcode=310000` (the plugin logs this as a failure).

### ntfy

```json
{ "type": "ntfy", "enabled": true, "topic": "$NTFY_TOPIC",
  "server": "https://ntfy.sh", "token": "$NTFY_TOKEN",
  "priority": "default", "tags": "pi,computer" }
```

On the public server, `topic` is effectively a password — use a hard-to-guess name. For self-hosted ntfy, change `server`. Set `token` when you need an access token (adds `Authorization: Bearer` automatically). `priority` accepts `1`-`5` or `min|low|default|high|max`.

### Generic Webhook

```json
{ "type": "webhook", "name": "my-hook", "enabled": true,
  "url": "https://example.com/push",
  "method": "POST",
  "headers": { "Authorization": "Bearer ${MY_TOKEN}" },
  "body": { "text": "{{text}}", "meta": { "event": "{{event}}", "project": "{{project}}" } },
  "events": { "idle": false, "interrupted": true } }
```

**Prefer writing `body` as a JSON object**: placeholders are substituted into the structure, then the whole thing is serialized, so quotes and newlines in error text never break JSON. String templates are also supported and auto-escaped by `contentType`. Placeholders in `url` are URL-encoded.

## All options

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `modes` | `["tui"]` | pi run modes allowed to push; see below |
| `timeoutMs` | `5000` | Per-request timeout |
| `shutdownTimeoutMs` | `2000` | Max block time to send on exit |
| `dedupeMs` | `3000` | Same content only sent once within this window |
| `minDurationSec` | `0` | Skip `idle` when turn is shorter than this (interrupts still fire) |
| `maxTextChars` | `500` | Body truncation length |
| `titleTemplate` | `pi {{status}}` | Title template (Bark) |
| `template` | `pi {{status}} · {{reason}}` | Body template |
| `events` | see table above | Global event toggles |
| `needInputTools` | `["ask_user_question"]` | Which tools count as "asking you" |
| `debug` | `false` | Log successes too |

Placeholders: `{{status}} {{reason}} {{text}} {{title}} {{event}} {{cwd}} {{project}} {{duration}} {{session}} {{model}} {{host}} {{time}} {{date}}`

Values written as `"$VAR"` are replaced entirely from the environment; `"Bearer ${VAR}"` does in-string substitution — keys need not live on disk.

The config file is hot-read by mtime; edits do **not** need `/reload` (only plugin code changes do).

### Why `modes` defaults to only `tui`

pi subagents run as `pi --mode json -p` child processes, and global extensions load there too. If you allow `json`/`print`, every finished subagent would push — pure noise. Add `print` only when you really want batch-job notifications.

## Troubleshooting

- `/push test` shows each channel's HTTP status or error reason directly
- Failures are written to `push.log` (same directory as `config.json`); with `"debug": true`, successes are logged too
- Group bots that return HTTP 200 but business failure (bad signature, missing keyword, rate limit) are treated as **failures** and logged with the error code — never pretended as success

## Known limits

- **SIGKILL / power loss / hard-killed terminal** get no notification: pi does not fire `session_shutdown`, so nothing in-process can send
- **pi itself crashing** (uncaughtException) also gets none: pi's crash handler registers first and calls `process.exit(1)` synchronously, so async requests cannot leave
- Only **tool-shaped** questions (`needInputTools`) are detected; confirm dialogs from other extensions are not

## Self-test

```bash
cd ~/.pi/agent/extensions/pi-agent-push && node test/run.ts   # needs Node >= 23
```

Spins up a local HTTP server that pretends to be each channel and runs assertions: signature algorithms (fixed vectors matching official algorithms), per-channel payload shapes, dedupe, timeout, mode isolation, JSON escaping, per-channel event overrides, command behavior, etc.

---

# 中文

pi 主 agent 停下来时，把消息推到手机 / 群：Bark、飞书、企业微信、钉钉、ntfy、通用 Webhook。全部**纯文本**。

## 安装

```bash
pi install npm:pi-agent-push
# 或从 GitHub：
pi install git:github.com/kiim-wong/pi-agent-push
```

安装后重启 pi 或执行 `/reload`。

## 配置

任选其一：

1. **命令行（推荐）**
   ```text
   /push set ntfy topic=your-topic enabled=true
   /push test ntfy
   ```
2. **配置文件**  
   在扩展目录创建 `config.json`（可参考包内 `config.example.json`）。  
   也可用环境变量 `PI_AGENT_PUSH_CONFIG` 指向自定义路径。

> 仓库 / npm 包**不包含**真实 key；本地 `config.json` 请自行保管。

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
cd ~/.pi/agent/extensions/pi-agent-push && node test/run.ts   # 需要 Node >= 23
```

会起一个本地 HTTP 服务假扮各渠道，跑自测断言：签名算法（对拍官方算法的固定
向量）、各渠道报文结构、去重、超时、模式隔离、JSON 转义、渠道级开关覆盖、命令行为等。
