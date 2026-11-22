import assert from "node:assert/strict"
import test from "node:test"
import {setTimeout as sleep} from "node:timers/promises"
import {AbstractAgent, SessionManager, type AgentEvent, type HistoryStore, type Submission, type UserOperation} from "../src/index.ts"

test("another Pod queues an interrupt for the running Agent and close flushes history", {timeout: 3_000}, async () => {
    let pending: Submission[] = []
    let wakeConsumer: (() => void) | undefined
    let waitingReads = 0
    let immediateReads = 0
    const consumerWaiting = Promise.withResolvers<void>()
    const closingConsumerWaiting = Promise.withResolvers<void>()
    const history: string[] = []
    const takePending = () => {
        const batch = pending
        pending = []
        return batch
    }
    const store: HistoryStore = {
        async load_history_from_store() { return [] },
        async append_history_to_store(event) {
            await sleep(25)
            history.push(event.type)
        },
        async submit_pending_messages(submission) {
            pending.push(submission)
            wakeConsumer?.()
        },
        async recall_pending_messages() {
            immediateReads++
            return takePending()
        },
        async wait_and_recall_pending_messages(_id, signal) {
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
            return signal.aborted ? [] : takePending()
        },
    }

    const inputStarted = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    let listener: ((event: AgentEvent) => void) | undefined
    let creations = 0
    const liveSessions = new Set<string>()

    class TestAgent extends AbstractAgent {
        constructor(id: string) { super(id) }

        override async handleInput(operation: UserOperation): Promise<void> {
            if (operation.kind === "user-input") {
                inputStarted.resolve()
                await interrupted.promise
                listener?.({type: "input-finished"})
            } else if (operation.kind === "user-interrupt") {
                listener?.({type: "interrupted"})
                interrupted.resolve()
            }
        }

        override subscribe(onEvent: (event: AgentEvent) => void): () => void {
            listener = onEvent
            return () => { listener = undefined }
        }

        override async waitForEnd(): Promise<void> {}

        protected override async doDispose(): Promise<void> {
            listener?.({type: "disposed"})
        }
    }

    const life = {
        async alive(id: string) { return liveSessions.has(id) },
        async report(id: string) { liveSessions.add(id) },
    }
    const owner = new SessionManager(store, life, async id => {
        creations++
        return new TestAgent(id)
    })
    const otherPod = new SessionManager(store, life, async () => {
        throw new Error("The session is already running on the owner Pod")
    })

    const submission = (operation: UserOperation): Submission => ({
        session: "test-session",
        options: {
            cwd: ".",
            setting: {
                revision: 1, provider: "openai", model: "test", apiKey: "",
                contextWindow: 100, thinkingLevel: "none",
            },
        },
        operation,
    })

    try {
        const input = submission({
            kind: "user-input", mode: "steer", prompt: "hello",
            skills: {name: "", path: ""}, attachments: [], mentions: [],
        })
        await Promise.all([owner.submit(input), owner.submit(submission({kind: "user-resume"}))])
        await inputStarted.promise
        await consumerWaiting.promise
        await sleep(125)
        assert.equal(waitingReads, 1)
        assert.equal(immediateReads, 0)
        assert.ok(liveSessions.has(input.session))

        const closing = owner.close(input.session)
        await closingConsumerWaiting.promise
        await otherPod.submit(submission({kind: "user-interrupt"}))
        await closing

        assert.equal(creations, 1)
        assert.equal(immediateReads, 1)
        assert.deepEqual(history, ["interrupted", "input-finished", "disposed"])
    } finally {
        interrupted.resolve()
        await owner.close("test-session")
    }
})
