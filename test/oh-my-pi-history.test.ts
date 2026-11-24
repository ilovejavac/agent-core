import assert from "node:assert/strict"
import test from "node:test"
import {createAssistantMessageEventStream, type AssistantMessage, type UserMessage} from "@oh-my-pi/pi-ai"
import {createAgentSession} from "@oh-my-pi/pi-coding-agent/sdk"
import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager"
import {applyTurnConfig} from "../src/agent/oh-my-pi/config.ts"
import {restoreHistory} from "../src/agent/oh-my-pi/history.ts"
import type {AgentEvent, AgentEventData} from "../src/event.ts"

test("a fresh Pi session resumes from stored messages and paired tool results", async () => {
    const history: AgentEvent[] = []
    const append = (data: AgentEventData, turnId?: string, seq = history.length + 1) => {
        history.push({...data, id: String(history.length + 1), sessionId: "session", seq, turnId, timestamp: 1})
    }
    const runId = "first-run"
    append({type: "message.ended", runId, payload: {messageId: "user", role: "user", content: [
        {partIndex: 0, kind: "text", text: "Compare the results."},
    ]}})
    for (const toolCallId of ["call-first", "call-second", "call-missing"]) {
        append({type: "tool.call.ready", runId, payload: {
            toolCallId, messageId: "assistant", toolName: "read", args: {path: toolCallId},
        }}, "turn")
    }
    append({type: "message.ended", runId, payload: {messageId: "assistant", role: "assistant", content: [
        {partIndex: 2, kind: "tool_call", toolCallId: "call-second"},
        {partIndex: 0, kind: "thinking_summary", text: "Check each result."},
        {partIndex: 1, kind: "tool_call", toolCallId: "call-first"},
        {partIndex: 3, kind: "tool_call", toolCallId: "call-missing"},
    ]}}, "turn")
    append({type: "tool.execution.ended", runId, payload: {
        toolCallId: "call-second", status: "failed", error: {message: "Not found"},
    }}, "turn")
    append({type: "tool.execution.ended", runId, payload: {
        toolCallId: "call-first", status: "succeeded", result: {content: [{type: "text", text: "First result"}]},
    }}, "turn")
    append({type: "message.ended", runId: "next-run", payload: {messageId: "answer", role: "assistant", content: [
        {partIndex: 0, kind: "text", text: "I found one result."},
    ]}}, "next-turn", 1)

    const sessionManager = SessionManager.inMemory()
    restoreHistory(sessionManager, history)
    const {session} = await createAgentSession({cwd: process.cwd(), sessionManager})
    try {
        await applyTurnConfig(session, {
            revision: 1, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-test",
            contextWindow: 200_000, maxTokens: 32_000, thinkingLevel: "none",
        })
        const {messages} = session.agent.state
        const restored = messages.filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
        assert.deepEqual(restored.map(message => message.role), ["user", "assistant", "toolResult", "toolResult", "toolResult", "assistant"])
        assert.deepEqual(restored[1]?.content, [
            {type: "thinking", thinking: "Check each result.", summary: true},
            ...["call-first", "call-second", "call-missing"].map(id => ({
                type: "toolCall", id, name: "read", arguments: {path: id},
            })),
        ])
        const toolResults = restored.filter(message => message.role === "toolResult")
        assert.deepEqual(toolResults.map(result => [result.toolCallId, result.isError, result.content]), [
            ["call-first", false, [{type: "text", text: "First result"}]],
            ["call-second", true, [{type: "text", text: "Not found"}]],
            ["call-missing", true, [{type: "text", text: "No result was recorded for this tool call."}]],
        ])

        let userContent: UserMessage["content"] | undefined
        session.agent.streamFn = (model, context) => {
            userContent = context.messages.find(message => message.role === "user")?.content
            const message: AssistantMessage = {
                role: "assistant", content: [{type: "text", text: "Continued."}],
                api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
                usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
            }
            const stream = createAssistantMessageEventStream()
            stream.push({type: "start", partial: message})
            stream.push({type: "done", reason: "stop", message})
            stream.end()
            return stream
        }
        await session.resume()
        await session.waitForIdle()
        const userText = typeof userContent === "string" ? userContent : userContent?.flatMap(part =>
            part.type === "text" ? [part.text] : []).join("\n")
        assert.match(userText ?? "", /Compare the results\./)
    } finally {
        await session.dispose()
    }
})
