import assert from "node:assert/strict"
import test from "node:test"
import {setTimeout as sleep} from "node:timers/promises"
import {SessionManager, type AgentEvent, type AgentEventDelivery, type HistoryStore, type PendingMessage, type Submission, type UserOperation} from "../src/index.ts"
import {AbstractAgent} from "../src/agent/core.ts"
import {createMemoryAgentLife, createMemoryPendingStore} from "../src/agent/store.ts"

const submission = (operation: UserOperation): Submission => ({
    session: "test-session",
    options: {
        cwd: ".",
        setting: {
            revision: 1, protocol: "openai-responses", model: "test", apiKey: "",
            contextWindow: 100, maxTokens: 100, thinkingLevel: "none",
        },
    },
    operation,
})

test("another Pod can interrupt a running session during remote close and wait for history to flush", {timeout: 3_000}, async () => {
    let pending: PendingMessage[] = []
    let wakeConsumer: (() => void) | undefined
    let waitingReads = 0
    let immediateReads = 0
    const consumerWaiting = Promise.withResolvers<void>()
    const closingConsumerWaiting = Promise.withResolvers<void>()
    const history: string[] = []
    const replies = createMemoryPendingStore()
    const takePending = () => {
        const batch = pending
        pending = []
        return batch
    }
    const store: HistoryStore = {
        async load_history_from_store() { return [] },
        async append_history_to_store(_id, event) {
            await sleep(25)
            if (event.type === "run.ended") history.push(event.payload.status)
        },
        async submit_pending_messages(message) {
            if ("kind" in message && message.kind === "session-close-result") {
                await replies.submit_pending_messages(message)
                return
            }
            pending.push(message)
            wakeConsumer?.()
        },
        async recall_pending_messages() {
            immediateReads++
            return takePending()
        },
        async wait_and_recall_pending_messages(id, signal) {
            if (id !== "test-session") return replies.wait_and_recall_pending_messages(id, signal)
            if (pending.length === 0 && !signal.aborted) {
                await new Promise<void>(resolve => {
                    const wake = () => {
                        signal.removeEventListener("abort", wake)
                        wakeConsumer = undefined
                        resolve()
                    }
                    wakeConsumer = wake
                    signal.addEventListener("abort", wake, {once: true})
                    waitingReads++
                    if (waitingReads === 1) consumerWaiting.resolve()
                    if (waitingReads === 2) closingConsumerWaiting.resolve()
                })
            }
            return takePending()
        },
    }

    const inputStarted = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    let listener: ((event: AgentEvent) => void) | undefined
    let creations = 0
    let seq = 0

    class TestAgent extends AbstractAgent {
        constructor(id: string) { super(id) }

        private emitRunEnd(status: "succeeded" | "cancelled" | "unknown") {
            listener?.({
                type: "run.ended", id: String(++seq), sessionId: this.id,
                runId: "test-run", seq, timestamp: Date.now(), payload: {status},
            })
        }

        override async handleInput(operation: UserOperation): Promise<void> {
            if (operation.kind === "user-input") {
                inputStarted.resolve()
                await interrupted.promise
                this.emitRunEnd("succeeded")
            } else if (operation.kind === "user-interrupt") {
                this.emitRunEnd("cancelled")
                interrupted.resolve()
            }
        }

        override subscribe(onEvent: (event: AgentEvent) => void): () => void {
            listener = onEvent
            return () => { listener = undefined }
        }

        override async waitForEnd(): Promise<void> {}

        protected override async doDispose(): Promise<void> {
            this.emitRunEnd("unknown")
        }
    }

    const life = createMemoryAgentLife()
    const owner = new SessionManager(store, life, async id => {
        creations++
        return new TestAgent(id)
    })
    const otherPod = new SessionManager(store, life, async () => {
        throw new Error("The session is already running on the owner Pod")
    })

    try {
        const input = submission({
            kind: "user-input", mode: "steer", prompt: "hello",
            skills: [], attachments: [], mentions: [],
        })
        await Promise.all([owner.submit(input), owner.submit(submission({kind: "user-resume"}))])
        await inputStarted.promise
        await consumerWaiting.promise
        await sleep(125)
        assert.equal(waitingReads, 1)
        assert.equal(immediateReads, 0)
        const ownerId = await life.alive(input.session)
        assert.equal(typeof ownerId, "string")
        assert.deepEqual(await otherPod.getActiveSessions(), [{sessionId: input.session, ownerId}])

        const closing = otherPod.close(input.session)
        await closingConsumerWaiting.promise
        await otherPod.submit(submission({kind: "user-interrupt"}))
        await closing

        assert.equal(creations, 1)
        assert.equal(immediateReads, 1)
        assert.deepEqual(history, ["cancelled", "succeeded", "unknown"])
        assert.deepEqual(await otherPod.getActiveSessions(), [])
    } finally {
        interrupted.resolve()
        await owner.close("test-session")
    }
})

test("returns no active sessions when agent life cannot list them", async () => {
    const store: HistoryStore = {
        ...createMemoryPendingStore(),
        async load_history_from_store() { return [] },
        async append_history_to_store() {},
    }
    const manager = new SessionManager(store, {
        async alive() { return false },
        async report() {},
    }, async () => {
        throw new Error("Listing active sessions must not start a session")
    })

    assert.deepEqual(await manager.getActiveSessions(), [])
})

test("a close queued during disposal cannot close the replacement session", {timeout: 3_000}, async () => {
    const pending = createMemoryPendingStore()
    const lateCloseQueued = Promise.withResolvers<void>()
    let closeRequests = 0
    const store: HistoryStore = {
        ...pending,
        async submit_pending_messages(message) {
            await pending.submit_pending_messages(message)
            if ("kind" in message && message.kind === "session-close" && ++closeRequests === 2) {
                lateCloseQueued.resolve()
            }
        },
        async load_history_from_store() { return [] },
        async append_history_to_store() {},
    }
    const disposing = Promise.withResolvers<void>()
    const releaseDisposal = Promise.withResolvers<void>()
    let disposals = 0
    const liveSessions = new Map<string, string>()
    const life = {
        async alive(id: string) { return liveSessions.get(id) ?? false },
        async report(id: string, ownerId: string) { liveSessions.set(id, ownerId) },
        async release(id: string, ownerId: string) {
            if (liveSessions.get(id) === ownerId) liveSessions.delete(id)
        },
    }
    class TestAgent extends AbstractAgent {
        constructor(id: string) { super(id) }

        override async handleInput() {}

        override subscribe() { return () => {} }

        override async waitForEnd() {}

        protected override async doDispose(): Promise<void> {
            disposals++
            disposing.resolve()
            await releaseDisposal.promise
        }
    }
    const owner = new SessionManager(store, life, async id => new TestAgent(id))
    const otherPod = new SessionManager(store, life, async () => {
        assert.fail("Close must not start a new agent")
    })
    await otherPod.close("unknown-session")
    assert.deepEqual(await store.recall_pending_messages("unknown-session"), [])

    const input = submission({kind: "user-resume"})
    await owner.submit(input)
    let completed = false
    const closing = otherPod.close(input.session).then(() => { completed = true })
    try {
        await disposing.promise
        assert.equal(completed, false)
        const closingAgain = otherPod.close(input.session)
        await lateCloseQueued.promise
        releaseDisposal.resolve()
        await closing
        await owner.submit(input)
        await closingAgain
        assert.equal(disposals, 1)
    } finally {
        releaseDisposal.resolve()
        await owner.close(input.session)
    }
    await otherPod.close(input.session)
    assert.deepEqual(await store.recall_pending_messages(input.session), [])
})

test("stores complete messages and lifecycle events while sending deltas only to the listener", {timeout: 3_000}, async () => {
    const envelope = {sessionId: "test-session", runId: "run", timestamp: 0}
    const delta: AgentEvent = {
        type: "message.delta", ...envelope, seq: 2, id: "delta",
        payload: {messageId: "message", partIndex: 0, kind: "thinking_summary", delta: "你好🙂世界继续输出下一段"},
    }
    const turnStarted: AgentEvent = {type: "turn.started", ...envelope, seq: 1, id: "turn-start", payload: {turnId: "turn"}}
    const messageEnded: AgentEvent = {
        type: "message.ended", ...envelope, seq: 3, id: "message-end",
        payload: {messageId: "message", role: "assistant", content: [
            {partIndex: 0, kind: "thinking_summary", text: delta.payload.delta},
            {partIndex: 1, kind: "text", text: "Complete answer"},
        ]},
    }
    const toolStarted: AgentEvent = {
        type: "tool.execution.started", ...envelope, seq: 4, id: "tool-start", payload: {toolCallId: "call", toolName: "read"},
    }
    const toolEnded: AgentEvent = {
        type: "tool.execution.ended", ...envelope, seq: 5, id: "tool-end", payload: {toolCallId: "call", status: "succeeded"},
    }
    const ended: AgentEvent = {type: "turn.ended", ...envelope, seq: 6, id: "turn-end", payload: {turnId: "turn", status: "succeeded"}}
    const history: AgentEvent[] = []
    const written: AgentEventDelivery[] = []
    const stored = Promise.withResolvers<void>()
    const firstWrite = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const historyBlocked = Promise.withResolvers<void>()
    const releaseHistory = Promise.withResolvers<void>()
    const liveEnded = Promise.withResolvers<void>()
    let firstWriteReceived = false
    const store: HistoryStore = {
        ...createMemoryPendingStore(),
        async load_history_from_store() { return history },
        async append_history_to_store(_id, event) {
            history.push(event)
            if (event.type === "tool.execution.started") {
                historyBlocked.resolve()
                await releaseHistory.promise
            }
            if (event.type === "turn.ended") stored.resolve()
        },
    }
    class TestAgent extends AbstractAgent {
        private listener?: (event: AgentEvent) => void

        constructor(id: string) { super(id) }

        override subscribe(listener: (event: AgentEvent) => void): () => void {
            this.listener = listener
            return () => { this.listener = undefined }
        }

        override async handleInput() {
            for (const event of [turnStarted, delta, messageEnded, toolStarted, toolEnded, ended]) this.listener?.(event)
        }

        override async waitForEnd() {}

        protected override async doDispose() {}
    }
    const manager = new SessionManager(store, {
        async alive() { return false },
        async report() {},
    }, async id => new TestAgent(id))
    const input = submission({kind: "user-resume"})
    const unbind = manager.bindListener(input.session, {
        async onEvent(event) {
            written.push(event)
            if (event.type === "turn.ended") liveEnded.resolve()
            if (event.type === "message.delta" && !firstWriteReceived) {
                firstWriteReceived = true
                firstWrite.resolve()
                await release.promise
            }
        },
    })
    try {
        await manager.submit(input)
        await Promise.all([historyBlocked.promise, firstWrite.promise])
        assert.deepEqual(history, [turnStarted, messageEnded, toolStarted])
        assert.deepEqual(written.map(event => event.type), [
            "turn.started", "message.delta",
        ])
        const firstDelta = written.at(-1)
        assert.ok(firstDelta?.type === "message.delta")
        assert.equal(firstDelta.payload.delta, delta.payload.delta)
        release.resolve()
        await liveEnded.promise
        assert.deepEqual(history, [turnStarted, messageEnded, toolStarted])
        releaseHistory.resolve()
        await stored.promise
        assert.deepEqual(history, [turnStarted, messageEnded, toolStarted, toolEnded, ended])
    } finally {
        release.resolve()
        releaseHistory.resolve()
        try {
            await manager.close(input.session)
        } finally {
            unbind()
        }
    }
    assert.equal(written.filter(event => event.type === "message.delta").map(event => event.payload.delta).join(""), delta.payload.delta)
    assert.deepEqual(written.filter(event => event.type !== "message.delta").map(event => [event.type, event.payload]), [
        ["turn.started", turnStarted.payload],
        ["message.ended", {messageId: "message", role: "assistant"}],
        ["tool.execution.started", toolStarted.payload],
        ["tool.execution.ended", toolEnded.payload],
        ["turn.ended", ended.payload],
    ])
})

test("keeps one listener per session across submissions and allows explicit rebinding", {timeout: 3_000}, async t => {
    const store: HistoryStore = {
        ...createMemoryPendingStore(),
        async load_history_from_store() { return [] },
        async append_history_to_store() {},
    }
    class TestAgent extends AbstractAgent {
        private listener?: (event: AgentEvent) => void
        private seq = 0

        constructor(id: string) { super(id) }

        override subscribe(listener: (event: AgentEvent) => void): () => void {
            this.listener = listener
            return () => { this.listener = undefined }
        }

        override async handleInput() {
            const runId = String(++this.seq)
            this.listener?.({
                type: "run.started", id: `${this.id}-${runId}`, sessionId: this.id,
                runId, seq: this.seq, timestamp: 0, payload: null,
            })
        }

        override async waitForEnd() {}

        protected override async doDispose() {}
    }
    const manager = new SessionManager(store, {
        async alive() { return false },
        async report() {},
    }, async id => new TestAgent(id))
    const first = submission({kind: "user-resume"})
    const second = {...first, session: "other-session"}
    t.after(async () => { await Promise.all([manager.close(first.session), manager.close(second.session)]) })

    const originalEvents: string[] = []
    const secondEvents: string[] = []
    const replacementEvents: string[] = []
    const originalReceived = Promise.withResolvers<void>()
    const unbindOriginal = manager.bindListener(first.session, {
        async onEvent(event) {
            originalEvents.push(event.id)
            if (originalEvents.length === 2) originalReceived.resolve()
        },
    })
    const unbindSecond = manager.bindListener(second.session, {
        async onEvent(event) { secondEvents.push(event.id) },
    })
    const replacement = {
        async onEvent(event: AgentEventDelivery) { replacementEvents.push(event.id) },
    }
    const unbindDuplicate = manager.bindListener(first.session, replacement)
    unbindDuplicate()
    await Promise.all([manager.submit(first), manager.submit(second), manager.submit(first)])
    await originalReceived.promise

    unbindOriginal()
    const unbindReplacement = manager.bindListener(first.session, replacement)
    unbindOriginal()
    unbindDuplicate()
    await manager.submit(first)
    await Promise.all([manager.close(first.session), manager.close(second.session)])
    await manager.submit(first)
    await manager.close(first.session)

    assert.deepEqual(originalEvents, [`${first.session}-1`, `${first.session}-2`])
    assert.deepEqual(secondEvents, [`${second.session}-1`])
    assert.deepEqual(replacementEvents, [`${first.session}-3`, `${first.session}-1`])
    unbindReplacement()
    unbindSecond()
})
