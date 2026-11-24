# 前端 Agent 事件接入

## 订阅入口

服务端通过 `createManager(store, life)` 创建管理器，再用 `manager.bindListener(sessionId, listener)` 绑定会话的实时事件。每个会话只能绑定一个 listener，重复绑定会抛错并保留原绑定。前端先建立会话订阅，再提交用户输入。绑定持续到调用返回的解绑函数，连接断开时应调用它。历史记录由业务服务通过 `HistoryStore.load_history_from_store(sessionId)` 提供。

```ts
import type { SessionManager } from "@centlu/agent-core"

function bindSessionStream(manager: SessionManager, sessionId: string, send: (json: string) => Promise<void>) {
    return manager.bindListener(sessionId, {
        async onEvent(event) {
            await send(JSON.stringify(event))
        },
    })
}
```

示例中的 `send` 由业务服务实现。多 Pod 部署时，监听器应绑定在实际运行会话的 Pod，或由该 Pod 通过业务服务转发事件。每条 SSE 数据或 WebSocket 文本消息对应一个 JSON 对象。以下示例使用 SSE 默认的 `message` 事件，订阅地址由业务服务提供。实时和历史的 TypeScript 类型见 [src/event.ts](src/event.ts)。

```ts
import type { AgentEventDelivery } from "@centlu/agent-core"

function subscribe(url: string, onEvent: (event: AgentEventDelivery) => void) {
    const stream = new EventSource(url)
    stream.onmessage = ({data}: MessageEvent<string>) => onEvent(JSON.parse(data))
    return () => stream.close()
}
```

## 公共字段

| 字段 | 类型 | 用法 |
| --- | --- | --- |
| `type` | 字符串 | 据此分发事件并读取对应的 `payload`。 |
| `id` | 字符串 | 事件 ID，可用于去重。每个实时文本分片有独立 ID。 |
| `sessionId` | 字符串 | 会话 ID，用于路由到对应的聊天面板。一个会话可包含多次运行。 |
| `runId` | 字符串，可缺省 | 一次 Agent 运行的 ID。通常一次用户提交开启一次运行，运行可包含多个 turn。空闲时的上下文压缩可以没有 `runId`。 |
| `turnId` | 字符串，可缺省 | 一次模型轮次的 ID。能关联到轮次的消息和工具事件携带它。`turn.started` 和 `turn.ended` 的 `payload.turnId` 是同一个值。 |
| `seq` | 数字 | 实时流按实际发送顺序编号。历史流按适配器生成顺序编号，两者各自计数。 |
| `timestamp` | 数字 | 原始事件转换时的 Unix 毫秒时间。多个文本分片可共享原始时间，实时渲染以接收顺序为准。 |
| `payload` | 对象或 `null` | 事件数据，形状由 `type` 决定。 |

## 事件与渲染规则

| `type` | 实时 `payload` | 前端处理 |
| --- | --- | --- |
| `run.started` / `run.resumed` | `null` | 将对应运行标记为进行中。恢复沿用原 `runId`。 |
| `run.paused` | `{ yielded, awaiting }` | 将运行标记为暂停。`awaiting` 为 `true` 时表示在等待外部工作。 |
| `run.ended` | `{ status, error? }` | 结束对应运行。 |
| `turn.started` / `turn.ended` | `{ turnId }` / `{ turnId, status }` | 按 `turnId` 更新轮次状态。一个 turn 结束后，运行可以继续。 |
| `message.started` / `message.ended` | `{ messageId, role }` | 创建消息占位或标记完成。`role` 为 `user`、`assistant` 或 `system`。用户输入可在提交时直接显示。 |
| `message.delta` | `{ messageId, partIndex, kind, delta }` | 按 `messageId` 和 `partIndex` 追加 `delta`。`kind` 为 `text` 或 `thinking_summary`，分别渲染正文和思考摘要。 |
| `tool.call.ready` | `{ toolCallId, messageId, toolName, args? }` | 创建或更新工具卡片，并关联到发起它的消息。 |
| `tool.execution.started` | `{ toolCallId, toolName }` | 将工具标记为执行中。也可以在此时创建工具卡片。 |
| `tool.execution.updated` | `{ toolCallId, snapshot }` | 用最新快照覆盖进度。 |
| `tool.execution.ended` | `{ toolCallId, status, result?, error? }` | 更新工具状态并展示最终结果。 |
| `retry.started` | `{ attempt, maxAttempts, delayMs, error }` | 展示重试次数、等待时间及原因。 |
| `retry.ended` | `{ attempt, success, error? }` | 更新重试状态。 |
| `context.compaction.started` | `{ compactionId, trigger, strategy?, reason? }` | 按 `compactionId` 展示上下文压缩。`trigger` 为 `manual` 或 `automatic`。 |
| `context.compaction.ended` | `{ compactionId, trigger, strategy?, status, willRetry?, tokensBefore?, error? }` | 更新对应压缩状态。 |

`status` 可以是 `succeeded`、`failed`、`cancelled` 或 `unknown`。压缩结束还可以是 `skipped`。`error` 的形状是 `{ message: string, code?: string }`。工具参数、快照及结果都是 JSON 值，展示时按各工具的内容格式处理。

同一消息部分的 `message.delta` 默认在 16 ms 内合并成一批，批内没有字符数限制。切换消息部分（如从思考摘要切到正文），或收到 `message.ended`、`turn.ended`、`run.ended` 时，待发文本立即进入发送队列。工具调用、进度和结果可在待发文本仍在合并时送达。前端按事件自身的 `runId`、`turnId`、`messageId` 和 `toolCallId` 更新对应对象。

## 一次运行，两轮模型交互

用户问「项目用的是什么运行时？」第一轮发起读取 `package.json` 的工具调用。第二轮读取工具结果后输出答案。两轮共用 `sessionId` 和 `runId`，各自有独立的 `turnId` 和助手 `messageId`。

下面每行代表一条实时事件。示例使用短 ID，实际接入时按不透明字符串处理。`tool.call.ready` 在第一轮的最后一个文本分片之前到达。

```jsonl
{"type":"run.started","id":"e1","sessionId":"s1","runId":"r1","seq":1,"timestamp":1780000000000,"payload":null}
{"type":"turn.started","id":"e2","sessionId":"s1","runId":"r1","turnId":"t1","seq":2,"timestamp":1780000000000,"payload":{"turnId":"t1"}}
{"type":"message.started","id":"e3","sessionId":"s1","runId":"r1","turnId":"t1","seq":3,"timestamp":1780000000000,"payload":{"messageId":"u1","role":"user"}}
{"type":"message.ended","id":"e4","sessionId":"s1","runId":"r1","turnId":"t1","seq":4,"timestamp":1780000000000,"payload":{"messageId":"u1","role":"user"}}
{"type":"message.started","id":"e5","sessionId":"s1","runId":"r1","turnId":"t1","seq":5,"timestamp":1780000000001,"payload":{"messageId":"m1","role":"assistant"}}
{"type":"message.delta","id":"e6","sessionId":"s1","runId":"r1","turnId":"t1","seq":6,"timestamp":1780000000002,"payload":{"messageId":"m1","partIndex":0,"kind":"thinking_summary","delta":"先看项目配置。"}}
{"type":"tool.call.ready","id":"e7","sessionId":"s1","runId":"r1","turnId":"t1","seq":7,"timestamp":1780000000019,"payload":{"toolCallId":"c1","messageId":"m1","toolName":"read","args":{"path":"package.json"}}}
{"type":"message.delta","id":"e8","sessionId":"s1","runId":"r1","turnId":"t1","seq":8,"timestamp":1780000000018,"payload":{"messageId":"m1","partIndex":0,"kind":"thinking_summary","delta":"确认运行时。"}}
{"type":"message.ended","id":"e9","sessionId":"s1","runId":"r1","turnId":"t1","seq":9,"timestamp":1780000000019,"payload":{"messageId":"m1","role":"assistant"}}
{"type":"tool.execution.started","id":"e10","sessionId":"s1","runId":"r1","turnId":"t1","seq":10,"timestamp":1780000000020,"payload":{"toolCallId":"c1","toolName":"read"}}
{"type":"tool.execution.ended","id":"e11","sessionId":"s1","runId":"r1","turnId":"t1","seq":11,"timestamp":1780000000021,"payload":{"toolCallId":"c1","status":"succeeded","result":{"content":[{"type":"text","text":"bun test"}]}}}
{"type":"turn.ended","id":"e12","sessionId":"s1","runId":"r1","turnId":"t1","seq":12,"timestamp":1780000000022,"payload":{"turnId":"t1","status":"succeeded"}}
{"type":"turn.started","id":"e13","sessionId":"s1","runId":"r1","turnId":"t2","seq":13,"timestamp":1780000000023,"payload":{"turnId":"t2"}}
{"type":"message.started","id":"e14","sessionId":"s1","runId":"r1","turnId":"t2","seq":14,"timestamp":1780000000080,"payload":{"messageId":"m2","role":"assistant"}}
{"type":"message.delta","id":"e15","sessionId":"s1","runId":"r1","turnId":"t2","seq":15,"timestamp":1780000000080,"payload":{"messageId":"m2","partIndex":0,"kind":"text","delta":"项目使用 Bu"}}
{"type":"message.delta","id":"e16","sessionId":"s1","runId":"r1","turnId":"t2","seq":16,"timestamp":1780000000080,"payload":{"messageId":"m2","partIndex":0,"kind":"text","delta":"n。"}}
{"type":"message.ended","id":"e17","sessionId":"s1","runId":"r1","turnId":"t2","seq":17,"timestamp":1780000000085,"payload":{"messageId":"m2","role":"assistant"}}
{"type":"turn.ended","id":"e18","sessionId":"s1","runId":"r1","turnId":"t2","seq":18,"timestamp":1780000000085,"payload":{"turnId":"t2","status":"succeeded"}}
{"type":"run.ended","id":"e19","sessionId":"s1","runId":"r1","seq":19,"timestamp":1780000000086,"payload":{"status":"succeeded"}}
```

用 `messageId` 维护两条助手消息。`m1` 的第 `0` 部分把两个摘要分片拼成「先看项目配置。确认运行时。」工具卡片 `c1` 关联 `m1`。`m2` 的第 `0` 部分是最终回复「项目使用 Bun。」收到 `turn.ended(t1)` 时只关闭 `t1`，收到 `run.ended(r1)` 时再标记本次运行结束。

## 历史与断线恢复

实时 `message.delta` 用于临时渲染，历史存储跳过这些增量。历史的 `message.ended` 含完整 `content`，其中各部分通过 `partIndex` 关联，可以是 `{ kind: "text" | "thinking_summary", text }`、`{ kind: "image", data, mimeType }` 或 `{ kind: "tool_call", toolCallId }`。工具和轮次事件也保存在历史中。

第二轮助手消息对应的历史事件如下。

```json
{
    "type": "message.ended",
    "id": "e17",
    "sessionId": "s1",
    "runId": "r1",
    "turnId": "t2",
    "seq": 15,
    "timestamp": 1780000000085,
    "payload": {
        "messageId": "m2",
        "role": "assistant",
        "content": [{"partIndex": 0, "kind": "text", "text": "项目使用 Bun。"}]
    }
}
```

重新连接时按 `sessionId` 加载历史，使用历史 `message.ended` 的 `content` 替换同一 `messageId` 的临时内容。已从历史恢复完整内容的消息可以忽略迟到的 `message.delta`。实时发送和历史写入独立推进，刚结束的消息可能稍后才出现在历史中。实时 `seq` 用于当前发送流的排序，恢复内容时按 `messageId` 或 `toolCallId` 合并。
