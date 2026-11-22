import type {AgentEventListener, AgentLife, AgentOptions, Submission} from "./model.ts"
import type {HistoryStore} from "./agent"
import type {AgentCore} from "./agent/core.ts"
import {CreateOhMyPiAgent} from "./agent/omp.ts";

type SessionState = {
    closing: boolean
    pendingWait?: AbortController
}

type ManagedSession = {
    state: SessionState
    ready: Promise<AgentCore>
    done: Promise<void>
}

export class SessionManager {
    private readonly sessions = new Map<string, ManagedSession>()

    constructor(
        private readonly store: HistoryStore,
        private readonly life: AgentLife,
        private readonly getCoreAgent: (id: string, options: AgentOptions) => Promise<AgentCore>,
        private readonly listener?: AgentEventListener,
    ) {}

    async submit(submission: Submission): Promise<void> {
        await this.store.submit_pending_messages(submission)

        const {session: id, options} = submission
        while (true) {
            let session = this.sessions.get(id)
            if (!session) {
                const alive = await this.life.alive(id)
                session = this.sessions.get(id)
                if (!session) {
                    if (alive) return
                    session = this.startSession(id, options)
                }
            }

            if (!session.state.closing) {
                await session.ready
                return
            }

            // A submission can arrive after the closing session's final queue read.
            await session.done.catch(() => undefined)
        }
    }

    async close(id: string): Promise<void> {
        const session = this.sessions.get(id)
        if (!session) return

        session.state.closing = true
        session.state.pendingWait?.abort()
        await session.done
    }

    private startSession(id: string, options: AgentOptions): ManagedSession {
        const ready = Promise.resolve().then(() => this.getCoreAgent(id, options))
        const state: SessionState = {closing: false}
        const session: ManagedSession = {
            state,
            ready,
            done: this.runSession(id, ready, state).finally(() => {
                this.sessions.delete(id)
            }),
        }

        this.sessions.set(id, session)
        void session.done.catch(error => console.error("会话运行失败", id, error))
        return session
    }

    private async runSession(id: string, ready: Promise<AgentCore>, state: SessionState): Promise<void> {
        const agent = await ready
        let events = Promise.resolve()
        let unsubscribe: (() => void) | undefined

        try {
            unsubscribe = agent.subscribe(event => {
                events = events.then(async () => {
                    await this.store.append_history_to_store(event)
                    await this.listener?.onEvent(event)
                }).catch(error => console.error("事件处理失败", id, event.type, error))
            })

            agent.startHeartbeat(() => this.life.report(id))
            await this.consumePending(id, agent, state)
        } finally {
            try {
                await agent.dispose()
            } finally {
                unsubscribe?.()
                await events
            }
        }
    }

    private async consumePending(id: string, agent: AgentCore, state: SessionState): Promise<void> {
        const running = new Set<Promise<void>>()

        while (true) {
            let batch: Submission[]
            if (state.closing && running.size === 0) {
                batch = await this.store.recall_pending_messages(id)
                if (batch.length === 0) break
            } else {
                const wait = new AbortController()
                state.pendingWait = wait
                try {
                    batch = await this.store.wait_and_recall_pending_messages(id, wait.signal)
                } finally {
                    state.pendingWait = undefined
                }
            }

            for (const {operation, options} of batch) {
                const task = agent.handleInput(operation, options)
                    .catch(error => console.error("处理操作失败", id, operation.kind, error))
                running.add(task)
                void task.then(() => {
                    running.delete(task)
                    if (state.closing && running.size === 0) state.pendingWait?.abort()
                })
            }
        }

        await agent.waitForEnd()
    }
}

export function createManager(
    store: HistoryStore,
    life: AgentLife,
    listener?: AgentEventListener,
): SessionManager {
    return new SessionManager(store, life, async (id, options) => {
        return CreateOhMyPiAgent(id, options)
    }, listener)
}
