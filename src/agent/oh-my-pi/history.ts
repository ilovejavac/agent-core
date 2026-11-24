import type {AssistantMessage, ImageContent, TextContent, ToolResultMessage} from "@oh-my-pi/pi-ai"
import type {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager"
import type {AgentEvent, JsonValue, Outcome} from "../../event.ts"

type ToolResultEvent = Extract<AgentEvent, {type: "tool.execution.ended"}>
type ToolReady = Extract<AgentEvent, {type: "tool.call.ready"}>["payload"]

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return value != null && typeof value === "object" && !Array.isArray(value)
}

function toolKey(event: AgentEvent, toolCallId: string): string {
    return JSON.stringify([event.runId, event.turnId, toolCallId])
}

function restoreToolResult(
    toolCallId: string, toolName: string, timestamp: number, event?: ToolResultEvent,
): ToolResultMessage {
    const result = event?.payload.result
    const content: (TextContent | ImageContent)[] = []
    if (isObject(result) && Array.isArray(result.content)) {
        for (const part of result.content) {
            if (!isObject(part)) continue
            if (part.type === "text" && typeof part.text === "string") {
                content.push({type: "text", text: part.text})
            } else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
                content.push({type: "image", data: part.data, mimeType: part.mimeType})
            }
        }
    } else if (result !== undefined) {
        content.push({type: "text", text: typeof result === "string" ? result : JSON.stringify(result)})
    }
    if (content.length === 0) {
        const text = event?.payload.error?.message ?? (event ? "" : "No result was recorded for this tool call.")
        content.push({type: "text", text})
    }
    return {
        role: "toolResult", toolCallId, toolName, content,
        isError: event?.payload.status !== "succeeded",
        timestamp: event?.timestamp ?? timestamp,
    }
}

export function restoreHistory(sessionManager: SessionManager, history: readonly AgentEvent[]): void {
    const calls = new Map<string, Map<string, ToolReady>>()
    const results = new Map<string, ToolResultEvent>()
    const turns = new Map<string, Outcome>()
    for (const event of history) {
        switch (event.type) {
            case "tool.call.ready": {
                const {messageId, toolCallId} = event.payload
                const messageCalls = calls.get(messageId) ?? new Map<string, ToolReady>()
                messageCalls.set(toolCallId, event.payload)
                calls.set(messageId, messageCalls)
                break
            }
            case "tool.execution.ended":
                results.set(toolKey(event, event.payload.toolCallId), event)
                break
            case "turn.ended":
                turns.set(event.payload.turnId, event.payload.status)
                break
        }
    }

    for (const event of history) {
        if (event.type !== "message.ended") continue
        const {role, messageId} = event.payload
        const content: AssistantMessage["content"] = []
        const toolResults: ToolResultMessage[] = []
        for (const part of [...event.payload.content].sort((left, right) => left.partIndex - right.partIndex)) {
            if (part.kind === "text") content.push({type: "text", text: part.text})
            if (part.kind === "image") content.push({type: "image", data: part.data, mimeType: part.mimeType})
            if (role !== "assistant") continue
            if (part.kind === "thinking_summary") {
                content.push({type: "thinking", thinking: part.text, summary: true})
            }
            if (part.kind === "tool_call") {
                const {toolCallId} = part
                const call = calls.get(messageId)?.get(toolCallId)
                if (!call) continue
                const {toolName, args} = call
                content.push({type: "toolCall", id: toolCallId, name: toolName, arguments: isObject(args) ? args : {}})
                const result = results.get(toolKey(event, toolCallId))
                toolResults.push(restoreToolResult(toolCallId, toolName, event.timestamp, result))
            }
        }

        const {timestamp} = event
        if (role !== "assistant") {
            sessionManager.appendMessage({
                role: role === "system" ? "developer" : "user",
                content: content.filter(part => part.type === "image" || part.type === "text"),
                timestamp,
            })
            continue
        }

        const status = event.turnId === undefined ? undefined : turns.get(event.turnId)
        if (content.length === 0 && status !== "failed" && status !== "cancelled") continue
        sessionManager.appendMessage({
            role, content, timestamp,
            api: "openai-completions", provider: "agent-core-history", model: "<synthetic>",
            usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
            },
            stopReason: status === "failed" ? "error" : status === "cancelled" ? "aborted"
                : toolResults.length > 0 ? "toolUse" : "stop",
        })
        for (const result of toolResults) sessionManager.appendMessage(result)
    }
}
