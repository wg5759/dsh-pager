# DSH 线协议笔记

这些是在 **DeepSeek Harness 0.1.1-rc.2** 上观察并实际使用的行为，写给想做 DSH 插件或客户端的人参考。**这不是官方规范**，DSH 升级后可能变化；以 dsh-pager 代码（`plugin/server.js`、`plugin/notify.js`、`plugin/fold.js`）的实际用法为准。

## 一元调用：`POST /api/<方法>`

```http
POST /api/session.list
Content-Type: application/json

{"type":"client-request","rpcId":"<uuid>","method":"session.list","payload":{}}
```

```json
{"type":"server-response","rpcId":"<uuid>","result":{"ok":true,"value":{ ... }}}
{"type":"server-response","rpcId":"<uuid>","result":{"ok":false,"error":{"code":"...","message":"..."}}}
```

- `rpcId` 由调用方生成。`session.prompt` 的 `rpcId` 会原样出现在随后那条 `user/message` 事件的 `source.rpcId` 里，客户端可以靠它把"发送中"气泡和真实消息对上。
- dsh-pager 用到的方法：
  - 读取：`workspace.list`、`session.list`、`session.history`、`session.attachment`；
  - 写入（手机白名单）：`session.create`、`session.prompt`、`session.cancel`、`session.models`、`session.selectModel`、`session.rename`、`session.search`、`session.updateQueue`、`workspace.archiveSession`。
- `session.history` 的参数是 `{sessionId, maxMessages, beforeSeq?}`，返回 `{events: [{event, view}], hasMore, projections}`。`view` 是宿主端 presenter 给工具调用和结果生成的展示数据（终端卡片、diff、搜索结果等）。

## 事件流：两条 WebSocket

| 路径 | 内容 |
|---|---|
| `/api/events.mux` | 所有会话的事件、审批、提问、队列、投影 |
| `/api/events.host` | 宿主级变化：会话运行状态、Agent 错误、会话和工作区的增删改 |

每一帧都是 `{"type":"server-request","rpcId":"…","payload":{…}}`，按 `payload.type` 区分。

**mux 帧**：

| `payload.type` | 要点 |
|---|---|
| `session/event` | `{sessionId, event, view}`。`event = {type, seq, time, data}`，类型见下表 |
| `approval/requested` | `{sessionId, approvalId, toolName, callId, reason}`；帧的 `rpcId` 就是之后应答要用的 id |
| `approval/resolved` | `{sessionId, approvalId, outcome}`：在任何一端处理后，所有连接都会收到 |
| `question/requested` | `{sessionId, questions}`；应答同样用帧的 `rpcId` |
| `question/resolved` | `{sessionId, questionRpcId, outcome}` |
| `session/queue` | 排队消息快照 `{items}`（`placement: 'context'` 的项只给模型看） |
| `session/projection` | 投影值变化，例如 `key: 'title'` |
| `stream/error` | 流错误 |

**重要**：mux 每次建立连接时，都会重发**仍在等待**的审批和提问。所以断线重连不会丢待办事项，但客户端要自己去重（dsh-pager 用 `approvalId` 和 `rpcId` 去重）。

**host 帧**：`host/session-status`（`{sessionId, running}`）、`host/agent-error`，以及 `host/session-added|removed`、`host/workspace-changed|removed|order-changed`、`host/archived-sessions-changed`。

## 会话事件类型（`session/event` 里的 `event.type`）

| 类型 | 说明 |
|---|---|
| `user/message` | 用户消息。**注意**：宿主注入的上下文（技能目录、Agent 指令、插件快照、审批策略说明）也是这个类型，只有 `data.source.kind === 'user'` 才是人写的 |
| `assistant/chunk` | 流式碎片：`data.chunk.type` 为 `text-delta`、`reasoning-delta`、`block-start`、`tool-call-delta` 等 |
| `assistant/message` | 一步的最终消息：`data.message.content` 里有 `text`、`reasoning` 块 |
| `step/start` | 新的一步开始（dsh-pager 在这里丢弃尚未收尾的流式碎片） |
| `tool/call` / `tool/result` | 工具调用和结果，靠 `callId` / `toolCallId` 关联；`view` 里有展示用数据 |
| `turn/start` / `turn/end` | 回合边界：`turn/end` 的 `data.reason.kind` 为 `completed`、`cancelled` 等 |
| `session/title`、`todo/write` | 标题、待办清单 |
| `request/header` | 每次请求模型时的请求头，包含整段系统提示词。体积大，手机端用不上 |

**体积**：
- 实测 6 个会话、每个 30 条消息，原始历史共 22.9 MB，其中 **89%** 是 `assistant/chunk`。
- 按 `fold.js` 的方式折叠后，只保留"人写的消息 / 最终回复 / 每个工具一行 / 回合结束"，一个 4 MB 级的会话降到 20–30 KB。

## 用量：会话投影

不用翻历史：`session.list` 的每一项都带 `projections.values`，其中三项就是用量（整个会话累计）：

```json
"tokenUsage":      { "uncachedInputTokens": 6333, "outputTokens": 1489, "cacheReadTokens": 174848, "cacheWriteTokens": 0 },
"sessionStats":    { "turns": 3, "steps": 9, "llmMs": 12525, "toolMs": 5035828, "ttftMs": 5967, "ttftSteps": 9, "decodeMs": 6558, "decodeTokens": 1489 },
"contextPressure": { "pressureTokens": 21838, "projectedTokens": 21898, "contextWindow": 1000000 }
```

- `ttftMs`、`decodeMs` 是各步**之和**：平均首字延迟 = `ttftMs / ttftSteps`，输出速度 = `decodeTokens / decodeMs`。
- `toolMs` 包含等人确认的时间，可能很大。
- 每一步的明细也有：`assistant/message` 事件的 `data.usage` 是 `{ inputTokens, outputTokens, cacheReadTokens, reasoningTokens }`，`data.message.source` 带 `provider` 和 `model`。
- 同一个 `values` 里还有 `title`、`todos`、`plan`、`goal`、`contextBreakdown`、`permissions` 等。
- dsh-pager 的用法见 `plugin/fold.js` 的 `foldUsage()` 和 `plugin/server.js` 的 `usage()`。

## 应答：`POST /api/respond`

```json
{"type":"client-response","rpcId":"<approval/requested 帧的 rpcId>","result":{"ok":true,"value":{
  "sessionId":"…","approvalId":"…","outcome":"allowed-once"}}}
```

- 审批：`outcome` 为 `allowed-once` 或 `rejected`。
- 提问：`value = {sessionId, answer: {answers: [{id, selected: [...], custom?}]}}`，`rpcId` 用 `question/requested` 帧的。

## 信任栅栏（`@deepseek-ai/dsh-client-connection`）

每个 `/api` 请求都要过这道检查（它防 DNS 重绑定，**不是认证**）：

1. `Host` 必须是回环地址，或者在 `trustedHosts` 里。
   - 带端口的条目精确匹配 `host:port`；不带端口的条目匹配该主机名的任意端口。
   - `:80` 和 `:443` 也算显式端口。
   - 格式不规范的条目（`user@host`、`host/path`、补零的端口……）会让加载直接失败。
2. `Sec-Fetch-Site: cross-site` 一律拒绝。
3. 如果带了 `Origin`，它的 host 必须等于 `Host`。

DSH 本体的 `trustedHosts` 可以用 `dsh --profile web --trusted-host <authority>` 追加（可重复）。
另外，一部分方法**即使在 trusted host 上也只允许回环访问**：原生对话框、设置、凭据、`llm.discoverModels`。

dsh-pager 的 `/m/api/*` 用的是同一套规则（见 `plugin/server.js` 的 `trusted()` 和 `canonicalTrustedHost()`，有单元测试）。插件行的 `trustedHosts` 与 DSH 本体的相互独立，需要分别配置。

## 插件挂载（Cordis）

```js
export const name = 'mobile'
export const inject = ['webServer']
export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/m', handler }), '…')
  // ctx.webServer.port：DSH 实际监听的端口
}
```

本地插件的装法：在 profile 的 `node_modules` 下放一个目录（或目录联接），然后在 `cordis.patch.yml` 里 `- insert: [{ id, name }]`，重启 DSH。
