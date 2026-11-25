import assert from "node:assert/strict"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {createFileBasedHistoryAppendLoader, createMemoryAgentLife} from "../src/agent/store.ts"
import type {AgentEvent} from "../src/event.ts"

test("file history appends concurrent events in order and repairs an incomplete tail", async t => {
    const directory = await mkdtemp(join(tmpdir(), "agent-core-history-"))
    t.after(() => rm(directory, {recursive: true, force: true}))
    const store = createFileBasedHistoryAppendLoader(directory)
    const filename = join(directory, "rollout-session.jsonl")
    const events = [1, 2, 3].map((seq): AgentEvent => ({
        type: "run.started", id: `event-${seq}`, sessionId: "session",
        runId: "run", seq, timestamp: 0, payload: null,
    }))

    assert.deepEqual(await store.load_history_from_store("missing"), [])
    await writeFile(filename, `${JSON.stringify(events[0])}\n{"incomplete":`)
    assert.deepEqual(await store.load_history_from_store("session"), events.slice(0, 1))

    await Promise.all(events.slice(1).map(event => store.append_history_to_store("session", event)))

    assert.deepEqual(await store.load_history_from_store("session"), events)
    assert.equal(await readFile(filename, "utf8"), events.map(event => `${JSON.stringify(event)}\n`).join(""))
})

test("memory agent life only releases the current owner", async () => {
    const life = createMemoryAgentLife()
    assert.ok(life.release)
    assert.equal(await life.alive("session"), false)

    await life.report("session", "old-owner")
    await life.report("session", "current-owner")
    await life.release("session", "old-owner")
    assert.equal(await life.alive("session"), "current-owner")
    assert.equal(await life.alive("other-session"), false)

    await life.release("session", "current-owner")
    assert.equal(await life.alive("session"), false)
})
