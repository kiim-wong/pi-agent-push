# pi-agent-push 设计文档

日期：2026-07-26 · 状态：已实现并通过端到端验证

## 1. 目标与非目标

**目标**：pi 主 agent 停止工作时，通过用户配置的渠道推送一条精简的纯文本消息，
让人不必守着终端。三类状态：空闲等待输入 / 意外中断 / 需要用户回答。

**非目标（明确不做）**：
- 不做重试。provider 层面的自动重试会把"失败时机"变成隐式行为；这里保持单次尝试
  语义，失败只记日志。
- 不推送对话内容。默认只发状态和原因，代码与回复正文不出本机。
- 不做通知聚合 / 免打扰时段 / 已读回执。

## 2. 事件映射及依据

| pi 事件 | 本插件动作 |
|---|---|
| `agent_start` | 记录 `startedAt`，重置本轮状态 |
| `agent_end` | 缓存最后一条 assistant 消息的 `stopReason` / `errorMessage` |
| `agent_settled` | **唯一发送点**，按 `stopReason` 分派 idle / interrupted |
| `tool_call` | `toolName ∈ needInputTools` → needInput |
| `session_shutdown` | `reason === "quit"` → exit，并 flush 在途请求 |

**为什么发送点选 `agent_settled` 而不是 `agent_end`**

`agent_end` 是"一次底层 agent run 结束"，pi 之后仍可能自动重试、自动压缩后重跑、
或继续处理排队消息，用它会重复推送。`agent_settled` 由
`dist/core/agent-session.js` 的 `_runAgentPrompt` 在 `finally` 中经
`_emitAgentSettled()` 发出，具备两个关键性质：

1. 在重试 / 压缩 / 排队全部结束之后才触发；
2. 位于 `finally`，所以正常结束、Esc 取消、异常报错三条路径都会走到。

**怎么区分三种终态**

`@earendil-works/pi-ai` 的 `AssistantMessage.stopReason` 取值为
`"stop" | "length" | "toolUse" | "error" | "aborted"`，并带 `errorMessage`。
于是 `aborted → 本轮被取消`、`error → 运行出错`、其余 `→ 输出结束`。
这是从类型定义读出来的既有语义，不是猜的。

## 3. 三个必须踩对的坑

1. **中断通知不能用 `ctx.signal`。** 取消路径上该 signal 已经 abort，用它发请求等于
   自己取消自己。所有请求一律使用独立的 `AbortSignal.timeout(timeoutMs)`
   （`http.ts` 文件头写明了这条约束）。
2. **`session_shutdown` 必须自己兜超时。** pi 的 `AgentSessionRuntime.dispose()`
   会 `await` 扩展的 shutdown handler，且**不设超时**；handler 卡住就是 pi 退不出去。
   因此退出路径用 `fireBlocking(..., shutdownTimeoutMs)` 硬封顶。
3. **正文只取终态消息。** pi 的 `message_update` 是累积快照而非增量，任何"拼接
   update"的做法都会得到重复文本。摘要类信息只从 `agent_end` 的终态消息取。

## 4. 模块边界

```
index.ts     只回答"什么时候该推"        —— 事件接线 + 状态机 + /push 命令
notifier.ts  只回答"怎么发、发给谁"      —— 组装、去重、并发、超时、日志、in-flight 追踪
channels/*   只回答"这个平台的报文长啥样" —— 每个平台一个文件，注册表一行接入
config.ts    只回答"用户想要什么"        —— 解析、校验、默认值、环境变量、mtime 热读
render.ts    纯函数：占位符、时长、错误摘要
http.ts      纯函数：带超时的 fetch + 业务码判定
```

新增渠道 = 加一个 `channels/xxx.ts` + 注册表一行，不碰其它任何文件。

## 5. 可靠性策略

- **并发且互不影响**：`Promise.all` + 每渠道 try/catch，一个 webhook 挂掉不影响其它。
- **永不抛出**：任何异常都被吞进结果对象，绝不冒泡进 pi 的事件循环。
- **不阻塞 TUI**：`idle` / `needInput` 走 fire-and-forget，因为 `agent_settled` 的
  扩展 handler 是被 pi await 的，阻塞会拖慢 UI 收尾。在途请求登记在 in-flight 集合里，
  退出时统一 flush，print 模式下也不会丢消息（已端到端验证）。
- **业务码即失败**：群机器人常在 HTTP 200 里返回 `errcode != 0`（签名错、缺关键词、
  限流），统一折算成失败并记录。
- **去重**：相同 `event + 正文` 在 `dedupeMs` 内只发一次。
- **降噪**：`minDurationSec` 只作用于 `idle`；中断永远推送。
- **模式隔离**：默认只在 `tui` 推送，避免 subagent（`pi --mode json -p`）刷屏。

## 6. 安全

- key 存在 `config.json`，也可写成 `"$VAR"` / `"${VAR}"` 从环境变量取，不落盘。
- 默认文案只含状态和原因，不含代码、路径、对话内容（`{{cwd}}` 等占位符需用户显式启用）。
- 日志只记渠道名、状态码和错误摘要，不记完整报文。

## 7. 验证

- `test/run.ts`：本地 HTTP 服务假扮 5 个渠道，47 项断言，覆盖签名（与 Python 独立
  计算的官方算法向量对拍）、报文结构、去重、超时、模式隔离、JSON 转义、渠道级开关
  覆盖、坏配置容错、命令行为。
- 变异测试：故意把飞书签名的 key/message 互换、把默认 mode 改错，断言从 47 通过掉到
  23 失败，确认用例有约束力。
- jiti 加载测试：用 pi 相同的 jiti 配置加载 `index.ts`，确认 6 个事件与命令注册成功。
- 真实 pi 端到端：
  - 错误路径 → `pi 已中断 · 运行出错：401 authentication_error: invalid x-api-key`
  - 正常路径 → `pi 已就绪 · 输出结束，等待输入`
  - 退出 → `pi 已退出 · 会话结束`（进程退出前送达）

## 8. 已知限制

- SIGKILL / 断电收不到：不会触发 `session_shutdown`。
- pi 自身 uncaughtException 收不到：pi 用 `prependListener` 抢先注册并同步
  `process.exit(1)`，异步请求发不出去。若将来要覆盖，可行方案是"启动时检测上次会话
  的运行标记文件"做补偿推送——当前按 YAGNI 未实现。
- 只能感知工具形式的提问，拦不到其它扩展直接弹出的确认框。
