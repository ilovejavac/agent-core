import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentEventSmoother} from "../src/buffer.ts";
import type {AgentEvent, AgentEventDelivery} from "../src/event.ts";

const envelope = {sessionId: "session", runId: "run", timestamp: 0}
const ended: AgentEvent = {type: "run.ended", ...envelope, seq: 3, id: "run-end", payload: {status: "succeeded"}}
const textDelta: Extract<AgentEvent, {type: "message.delta"}> = {
    type: "message.delta", ...envelope, seq: 1, id: "text",
    payload: {messageId: "message", partIndex: 1, kind: "text", delta: ""},
}

test("text batching preserves a surrogate pair across frames", {timeout: 500}, async () => {
    const chunks: string[] = []
    const firstWrite = Promise.withResolvers<void>()
    const smoother = createAgentEventSmoother(event => {
        if (event.type !== "message.delta") return
        chunks.push(event.payload.delta)
        firstWrite.resolve()
    }, {intervalMs: 1})
    smoother.push({...textDelta, payload: {...textDelta.payload, delta: "你\uD83D"}})
    await firstWrite.promise
    assert.deepEqual(chunks, ["你"])
    smoother.push({...textDelta, payload: {...textDelta.payload, delta: "\uDE42好"}})
    await smoother.end()
    assert.deepEqual(chunks, ["你", "🙂好"])
})

test("tool results bypass queued delta chunks and completion follows the final chunk", async () => {
    const firstWrite = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const written: AgentEventDelivery[] = []
    const smoother = createAgentEventSmoother(async event => {
        written.push(event)
        if (written.length === 1) {
            firstWrite.resolve()
            await release.promise
        }
    }, {intervalMs: 10_000})
    const started: AgentEvent = {type: "run.started", ...envelope, seq: 1, id: "run-start", payload: null}
    const delta: AgentEvent = {
        type: "message.delta", ...envelope, seq: 1, id: "delta",
        payload: {messageId: "message", partIndex: 0, kind: "text", delta: "你好🙂世界"},
    }
    const toolResult: AgentEvent = {
        type: "tool.execution.ended", ...envelope, seq: 2, id: "tool-end",
        payload: {toolCallId: "call", status: "succeeded", result: {text: "complete result"}},
    }
    smoother.push(started)
    await firstWrite.promise
    try {
        smoother.push(delta)
        smoother.push(toolResult)
        smoother.push(ended)
        assert.equal(written.length, 1)
    } finally {
        release.resolve()
    }
    await smoother.end()
    const fragments = written.filter(event => event.type === "message.delta")
    assert.deepEqual(fragments.map(event => event.payload.delta), ["你好🙂世界"])
    assert.deepEqual(written[1], toolResult)
    assert.deepEqual(written.map(event => event.seq), [1, 2, 3, 4])
    assert.notEqual(fragments[0]?.id, delta.id)
    assert.deepEqual(written.at(-1), {...ended, seq: 4})
    assert.equal(delta.payload.delta, "你好🙂世界")
})

test("live listeners receive thinking deltas and message completion with usage", async () => {
    const written: AgentEventDelivery[] = []
    const smoother = createAgentEventSmoother(event => { written.push(event) }, {intervalMs: 1})
    const delta: AgentEvent = {
        type: "message.delta", ...envelope, seq: 1, id: "first",
        payload: {messageId: "message", partIndex: 0, kind: "thinking_summary", delta: "abc"},
    }
    const finalMessage: AgentEvent = {
        type: "message.ended", ...envelope, seq: 2, id: "final", turnId: "turn",
        payload: {
            messageId: "message", role: "assistant",
            content: [
                {kind: "thinking_summary", partIndex: 0, text: "abcd"},
                {kind: "text", partIndex: 1, text: "你好世界"},
            ],
            usage: {input: 15, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
                cost: {input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003}},
        },
    }
    smoother.push(delta)
    smoother.push(finalMessage)
    smoother.push(ended)
    await smoother.end()

    assert.deepEqual(written.filter(event => event.type === "message.delta").map(event => [event.payload.kind, event.payload.delta]), [
        ["thinking_summary", "abc"],
    ])
    assert.deepEqual(written.at(-2), {...finalMessage, seq: 2, payload: {
        messageId: "message", role: "assistant", usage: finalMessage.payload.usage,
    }})
    assert.deepEqual(written.at(-1), {...ended, seq: 3})
})

test("a burst of text is batched without waiting for completion", {timeout: 500}, async () => {
    const written: string[] = []
    const firstWrite = Promise.withResolvers<void>()
    const smoother = createAgentEventSmoother(event => {
        if (event.type !== "message.delta") return
        written.push(event.payload.delta)
        firstWrite.resolve()
    })
    const text = "项目说明🙂".repeat(800)
    smoother.push({...textDelta, payload: {...textDelta.payload, delta: text}})
    smoother.push({...textDelta, id: "second", seq: 2, payload: {...textDelta.payload, delta: "结束"}})
    await firstWrite.promise
    assert.deepEqual(written, [text + "结束"])
    await smoother.end()
})

test("switching to text and cancelling flush pending batches without timers", {timeout: 500}, async () => {
    const written: AgentEventDelivery[] = []
    const firstWrite = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const smoother = createAgentEventSmoother(event => {
        written.push(event)
        firstWrite.resolve()
        if (event.type === "run.ended") cancelled.resolve()
    }, {intervalMs: 10_000})
    const thinking = "分析项目配置。".repeat(600)
    const text = "项目使用 Bun。".repeat(40)
    const terminal: AgentEvent = {...ended, payload: {status: "cancelled"}}
    smoother.push({...textDelta, payload: {...textDelta.payload, partIndex: 0, kind: "thinking_summary", delta: thinking}})
    smoother.push({...textDelta, id: "body", seq: 2, payload: {...textDelta.payload, delta: text}})
    try {
        await firstWrite.promise
        assert.equal(written.length, 1)
        smoother.push(terminal)
        await cancelled.promise
        assert.deepEqual(written.filter(event => event.type === "message.delta").map(event => event.payload.delta), [thinking, text])
        assert.deepEqual(written.at(-1), terminal)
    } finally {
        await smoother.end()
    }
})
