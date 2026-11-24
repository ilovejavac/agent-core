
import type {AgentSessionEvent} from "@oh-my-pi/pi-coding-agent/session/agent-session-events"
import type {AgentEvent, AgentEventData, JsonValue, MessagePart, Outcome} from "../../event.ts"

type Message = Extract<AgentSessionEvent, {type: "message_end"}>["message"]
type AssistantMessage = Extract<Message, {role: "assistant"}>
type ToolCall = Extract<AssistantMessage["content"][number], {type: "toolCall"}>
type CompactionTrigger = "automatic" | "manual"
type Run = {
    id: string
    paused: boolean
    turnId?: string
    lastAssistant?: AssistantMessage
    messages: Map<string, string>
    toolCalls: Map<string, {turnId?: string; ready: boolean}>
}

function jsonValue(value: unknown): JsonValue | undefined {
    try {
        const serialized = JSON.stringify(value)
        if (serialized !== undefined) return JSON.parse(serialized)
    } catch {
        return undefined
    }
}

function assistantOutcome(message?: AssistantMessage): Outcome {
    switch (message?.stopReason) {
        case "error": return "failed"
        case "aborted": return "cancelled"
        case "stop":
        case "length":
        case "toolUse": return "succeeded"
        default: return "unknown"
    }
}

function messageContent(message: Extract<Message, {role: "user" | "developer" | "assistant"}>): MessagePart[] {
    if (typeof message.content === "string") return [{partIndex: 0, kind: "text", text: message.content}]
    return message.content.flatMap((part, partIndex): MessagePart[] => {
        switch (part.type) {
            case "text": return [{partIndex, kind: "text", text: part.text}]
            case "image": return [{partIndex, kind: "image", data: part.data, mimeType: part.mimeType}]
            case "toolCall": return [{partIndex, kind: "tool_call", toolCallId: part.id}]
            case "thinking":
                if (part.narration) return [{partIndex, kind: "text", text: part.thinking}]
                if (part.summary) return [{partIndex, kind: "thinking_summary", text: part.thinking}]
                return []
            default: return []
        }
    })
}

export function toEvents(sessionId: string) {
    let seq = 0
    let run: Run | undefined
    const compactions = new Map<CompactionTrigger, {id: string; runId?: string; strategy?: string}>()

    function emit(data: AgentEventData, turnId?: string): AgentEvent {
        return {
            ...data, id: crypto.randomUUID(), sessionId, seq: ++seq, timestamp: Date.now(),
            ...(turnId ? {turnId} : {}),
        }
    }

    function toolCallReady(current: Run, toolCall: ToolCall, messageId: string): AgentEvent[] {
        if (current.toolCalls.get(toolCall.id)?.ready) return []
        current.toolCalls.set(toolCall.id, {turnId: current.turnId, ready: true})
        const args = jsonValue(toolCall.arguments)
        return [emit({
            type: "tool.call.ready", runId: current.id,
            payload: {toolCallId: toolCall.id, messageId, toolName: toolCall.name, ...(args !== undefined ? {args} : {})},
        }, current.turnId)]
    }

    function dispose(): AgentEvent[] {
        const runId = run?.id
        run = undefined
        compactions.clear()
        if (runId === undefined) return []
        return [emit({type: "run.ended", runId, payload: {status: "cancelled"}})]
    }

    function convert(event: AgentSessionEvent): AgentEvent[] {
        switch (event.type) {
            case "agent_start": {
                if (!run) {
                    run = {id: crypto.randomUUID(), paused: false, messages: new Map(), toolCalls: new Map()}
                    return [emit({type: "run.started", runId: run.id, payload: null})]
                }
                if (!run.paused) return []
                run.paused = false
                run.lastAssistant = undefined
                return [emit({type: "run.resumed", runId: run.id, payload: null})]
            }
            case "auto_compaction_start":
            case "manual_compaction_start": {
                const trigger = event.type === "auto_compaction_start" ? "automatic" : "manual"
                const strategy = event.type === "auto_compaction_start" ? event.action : event.mode
                const compactionId = crypto.randomUUID()
                compactions.set(trigger, {id: compactionId, runId: run?.id, strategy})
                return [emit({
                    type: "context.compaction.started", ...(run ? {runId: run.id} : {}),
                    payload: {
                        compactionId, trigger, ...(strategy !== undefined ? {strategy} : {}),
                        ...(event.type === "auto_compaction_start" ? {reason: event.reason} : {}),
                    },
                })]
            }
            case "auto_compaction_end":
            case "manual_compaction_end": {
                const trigger = event.type === "auto_compaction_end" ? "automatic" : "manual"
                const compaction = compactions.get(trigger)
                compactions.delete(trigger)
                const runId = compaction ? compaction.runId : run?.id
                const strategy = event.type === "auto_compaction_end" ? event.action : compaction?.strategy
                const status = event.aborted ? "cancelled" : event.skipped ? "skipped" : event.result ? "succeeded" : "failed"
                return [emit({
                    type: "context.compaction.ended", ...(runId ? {runId} : {}),
                    payload: {
                        compactionId: compaction?.id ?? crypto.randomUUID(), trigger, status,
                        ...(strategy !== undefined ? {strategy} : {}),
                        ...(event.type === "auto_compaction_end" ? {willRetry: event.willRetry} : {}),
                        ...(event.result ? {tokensBefore: event.result.tokensBefore} : {}),
                        ...(event.errorMessage ? {error: {message: event.errorMessage}} : {}),
                    },
                })]
            }
        }

        if (!run) return []
        const runId = run.id
        switch (event.type) {
            case "agent_pause":
                if (run.paused) return []
                run.paused = true
                run.turnId = undefined
                return [emit({type: "run.paused", runId, payload: {yielded: event.yielded, awaiting: event.awaiting}})]
            case "agent_end": {
                const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant") ?? run.lastAssistant
                run = undefined
                return [emit({type: "run.ended", runId, payload: {
                    status: assistantOutcome(last),
                    ...(last?.errorMessage ? {error: {message: last.errorMessage}} : {}),
                }})]
            }
            case "turn_start": {
                const turnId = run.turnId = crypto.randomUUID()
                run.lastAssistant = undefined
                return [emit({type: "turn.started", runId, payload: {turnId}}, turnId)]
            }
            case "turn_end": {
                const turnId = run.turnId
                run.turnId = undefined
                if (event.message.role === "assistant") run.lastAssistant = event.message
                if (!turnId) return []
                const status = assistantOutcome(event.message.role === "assistant" ? event.message : undefined)
                return [emit({type: "turn.ended", runId, payload: {turnId, status}}, turnId)]
            }
            case "message_start":
            case "message_end": {
                const message = event.message
                if (message.role !== "user" && message.role !== "assistant" && message.role !== "developer") return []
                const role = message.role === "developer" ? "system" : message.role
                const messageId = run.messages.get(message.role) ?? crypto.randomUUID()
                if (event.type === "message_start") {
                    run.messages.set(message.role, messageId)
                    return [emit({type: "message.started", runId, payload: {messageId, role}}, run.turnId)]
                }
                run.messages.delete(message.role)
                const events: AgentEvent[] = []
                if (message.role === "assistant") {
                    run.lastAssistant = message
                    if (assistantOutcome(message) === "succeeded") {
                        for (const part of message.content) {
                            if (part.type === "toolCall") events.push(...toolCallReady(run, part, messageId))
                        }
                    }
                }
                events.push(emit({
                    type: "message.ended", runId, payload: {messageId, role, content: messageContent(message)},
                }, run.turnId))
                return events
            }
            case "message_update": {
                const update = event.assistantMessageEvent
                if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_end") return []
                const messageId = run.messages.get("assistant") ?? crypto.randomUUID()
                run.messages.set("assistant", messageId)
                if (update.type === "toolcall_end") return toolCallReady(run, update.toolCall, messageId)
                let kind: "text" | "thinking_summary" = "text"
                if (update.type === "thinking_delta") {
                    const part = update.partial.content[update.contentIndex]
                    if (part?.type !== "thinking" || (!part.narration && !part.summary)) return []
                    if (!part.narration) kind = "thinking_summary"
                }
                return [emit({type: "message.delta", runId, payload: {
                    messageId, partIndex: update.contentIndex, kind, delta: update.delta,
                }}, run.turnId)]
            }
            case "tool_execution_start": {
                const {toolCallId, toolName} = event
                if (!run.toolCalls.has(toolCallId)) run.toolCalls.set(toolCallId, {turnId: run.turnId, ready: false})
                return [emit({type: "tool.execution.started", runId, payload: {toolCallId, toolName}}, run.toolCalls.get(toolCallId)?.turnId)]
            }
            case "tool_execution_update": {
                const snapshot = jsonValue(event.partialResult)
                if (snapshot === undefined) return []
                const {toolCallId} = event
                return [emit({type: "tool.execution.updated", runId, payload: {toolCallId, snapshot}}, run.toolCalls.get(toolCallId)?.turnId)]
            }
            case "tool_execution_end": {
                const {toolCallId} = event
                const result = jsonValue(event.result)
                return [emit({type: "tool.execution.ended", runId, payload: {
                    toolCallId, status: event.isError ? "failed" : "succeeded",
                    ...(result !== undefined ? {result} : {}),
                }}, run.toolCalls.get(toolCallId)?.turnId)]
            }
            case "auto_retry_start":
                return [emit({type: "retry.started", runId, payload: {
                    attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs,
                    error: {message: event.errorMessage},
                }})]
            case "auto_retry_end":
                return [emit({type: "retry.ended", runId, payload: {
                    attempt: event.attempt, success: event.success,
                    ...(event.finalError ? {error: {message: event.finalError}} : {}),
                }})]
            default: return []
        }
    }

    return {convert, dispose}
}
