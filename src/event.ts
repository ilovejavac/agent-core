import type {Usage} from "@oh-my-pi/pi-ai"

export type JsonValue =
    | null | boolean | number | string
    | JsonValue[]
    | { [key: string]: JsonValue }

export type Outcome = "succeeded" | "failed" | "cancelled" | "unknown"
type EventError = { code?: string; message: string }

type MessageHeader = {
    messageId: string
    role: "user" | "assistant" | "system"
}

type MessageCompletion = MessageHeader & { usage?: Usage }

export type MessagePart = { partIndex: number } & (
    | { kind: "text" | "thinking_summary"; text: string }
    | { kind: "image"; data: string; mimeType: string }
    | { kind: "tool_call"; toolCallId: string }
)

type Compaction = { compactionId: string; trigger: "automatic" | "manual"; strategy?: string }

type EventPayloads = {
    "run.started": null
    "run.paused": { yielded: boolean; awaiting: boolean }
    "run.resumed": null
    "run.ended": { status: Outcome; error?: EventError }
    "turn.started": { turnId: string }
    "turn.ended": { turnId: string; status: Outcome }
    "message.started": MessageHeader
    "message.delta": {
        messageId: string
        partIndex: number
        kind: "text" | "thinking_summary"
        delta: string
    }
    "message.ended": MessageCompletion & { content: MessagePart[] }
    "tool.call.ready": { toolCallId: string; messageId: string; toolName: string; args?: JsonValue }
    "tool.execution.started": { toolCallId: string; toolName: string }
    "tool.execution.updated": { toolCallId: string; snapshot: JsonValue }
    "tool.execution.ended": {
        toolCallId: string
        status: Outcome
        result?: JsonValue
        error?: EventError
    }
    "retry.started": { attempt: number; maxAttempts: number; delayMs: number; error: EventError }
    "retry.ended": { attempt: number; success: boolean; error?: EventError }
    "context.compaction.started": Compaction & { reason?: string }
    "context.compaction.ended": Compaction & {
        status: Outcome | "skipped"
        willRetry?: boolean
        tokensBefore?: number
        error?: EventError
    }
}

type EventType = keyof EventPayloads

type EventData<Types extends EventType> = {
    [Type in Types]: { type: Type; payload: EventPayloads[Type] } & (
        Type extends "context.compaction.started" | "context.compaction.ended"
            ? { runId?: string }
            : { runId: string }
    )
}[Types]

type EventEnvelope = {
    id: string
    sessionId: string
    turnId?: string
    seq: number
    timestamp: number
}

export type AgentEventData = EventData<EventType>
export type AgentEvent = EventEnvelope & AgentEventData

export type AgentEventDelivery = EventEnvelope & (
    | EventData<Exclude<EventType, "message.ended">>
    | {type: "message.ended"; runId: string; payload: MessageCompletion}
)
