import assert from "node:assert/strict"
import test from "node:test"
import {toEvents} from "../src/agent/oh-my-pi/events.ts"

test("Pi pause and resume keep the same run ID, and disposal closes an open run once", () => {
    const {convert, dispose} = toEvents("session")
    const [started] = convert({type: "agent_start"})
    const [paused] = convert({type: "agent_pause", yielded: true, awaiting: true, messages: []})
    const [resumed] = convert({type: "agent_start"})
    const [ended] = dispose()

    assert.ok(started?.type === "run.started")
    assert.ok(paused?.type === "run.paused")
    assert.ok(resumed?.type === "run.resumed")
    assert.ok(ended?.type === "run.ended")
    assert.deepEqual(paused.payload, {yielded: true, awaiting: true})
    assert.equal(ended.payload.status, "cancelled")
    assert.deepEqual([paused.runId, resumed.runId, ended.runId], Array(3).fill(started.runId))
    assert.deepEqual([started.seq, paused.seq, resumed.seq, ended.seq], [1, 2, 3, 4])
    assert.deepEqual(dispose(), [])
    assert.deepEqual(convert({type: "agent_end", messages: []}), [])
})

test("Pi retry events share the enclosing run and preserve the attempt outcome", () => {
    const {convert, dispose} = toEvents("session")
    const [started] = convert({type: "agent_start"})
    const [retry] = convert({
        type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: "busy",
    })
    const [result] = convert({type: "auto_retry_end", attempt: 2, success: false, finalError: "unavailable"})
    const [ended] = convert({type: "agent_end", messages: []})

    assert.ok(retry?.type === "retry.started")
    assert.ok(result?.type === "retry.ended")
    assert.equal(retry.runId, started?.runId)
    assert.equal(result.runId, started?.runId)
    assert.deepEqual(retry.payload, {attempt: 2, maxAttempts: 3, delayMs: 500, error: {message: "busy"}})
    assert.deepEqual(result.payload, {attempt: 2, success: false, error: {message: "unavailable"}})
    assert.equal(ended?.type, "run.ended")
    assert.deepEqual(dispose(), [])
})

test("Pi compaction retains its original scope and correlates manual and automatic results", () => {
    const {convert} = toEvents("session")
    const [manualStart] = convert({type: "manual_compaction_start", mode: "summary"})
    const [run] = convert({type: "agent_start"})
    const [autoStart] = convert({type: "auto_compaction_start", reason: "overflow", action: "context-full"})
    const [manualEnd] = convert({type: "manual_compaction_end", aborted: false, skipped: true})
    const [autoEnd] = convert({
        type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: true,
        result: {summary: "summary", firstKeptEntryId: "entry", tokensBefore: 100},
    })

    assert.ok(manualStart?.type === "context.compaction.started")
    assert.ok(manualEnd?.type === "context.compaction.ended")
    assert.ok(autoStart?.type === "context.compaction.started")
    assert.ok(autoEnd?.type === "context.compaction.ended")
    assert.equal(manualEnd.runId, undefined)
    assert.equal(manualEnd.payload.compactionId, manualStart.payload.compactionId)
    assert.equal(manualEnd.payload.status, "skipped")
    assert.equal(autoEnd.runId, run?.runId)
    assert.equal(autoEnd.payload.compactionId, autoStart.payload.compactionId)
    assert.equal(autoEnd.payload.status, "succeeded")
    assert.equal(autoEnd.payload.tokensBefore, 100)
    assert.equal(autoEnd.payload.willRetry, true)
})
