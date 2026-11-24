import type {AgentEventListener, AgentLife, AgentOptions, Submission} from "./model.ts"
import type {HistoryStore, PendingMessage, SessionCloseRequest} from "./agent"
import type {AgentCore} from "./agent/core.ts"
import {CreateOhMyPiAgent} from "./agent/oh-my-pi";
import {createAgentEventSmoother} from "./buffer.ts"

const closeReplyPrefix = "@agent-core/close/"
const remoteCloseTimeout = 30_000
const ownerCheckInterval = 500

type SessionState = {
    ownerId: string
    closing: boolean
    pendingWait?: AbortController
    closeRequests: SessionCloseRequest[]
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
        this.validateSessionId(submission.session)
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
        this.validateSessionId(id)
        let session = this.sessions.get(id)
        if (!session) {
            const owner = await this.life.alive(id)
            session = this.sessions.get(id)
            if (!session) {
                if (owner) await this.closeRemoteSession(id, owner)
                return
            }
        }

        this.beginClose(session.state)
        await session.done
    }

    private validateSessionId(id: string): void {
        if (id.startsWith(closeReplyPrefix)) throw new Error(`Reserved session id: ${id}`)
    }

    private beginClose(state: SessionState): void {
        state.closing = true
        state.pendingWait?.abort()
    }

    private async closeRemoteSession(id: string, owner: string | true): Promise<void> {
        const replyTo = `${closeReplyPrefix}${crypto.randomUUID()}`
        const expiresAt = Date.now() + remoteCloseTimeout
        const ownerId = typeof owner === "string" ? owner : undefined
        const signal = AbortSignal.timeout(remoteCloseTimeout)
        await this.store.submit_pending_messages({kind: "session-close", session: id, replyTo, expiresAt, ownerId})

        while (!signal.aborted) {
            const wait = ownerId === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(ownerCheckInterval)])
            const batch = await this.store.wait_and_recall_pending_messages(replyTo, wait)
            if (this.readCloseResult(batch)) return
            if (ownerId !== undefined && await this.life.alive(id) !== ownerId) {
                this.readCloseResult(await this.store.recall_pending_messages(replyTo))
                return
            }
        }

        throw new Error(`Timed out waiting for session ${id} to close`)
    }

    private readCloseResult(batch: PendingMessage[]): boolean {
        for (const message of batch) {
            if (!("kind" in message) || message.kind !== "session-close-result") continue
            if (message.error !== undefined) throw new Error(message.error)
            return true
        }
        return false
    }

    private startSession(id: string, options: AgentOptions): ManagedSession {
        const ownerId = crypto.randomUUID()
        const ready = Promise.resolve().then(async () => {
            await this.life.report(id, ownerId)
            return this.getCoreAgent(id, options)
        })
        const state: SessionState = {ownerId, closing: false, closeRequests: []}
        const session: ManagedSession = {
            state,
            ready,
            done: this.runSession(id, ready, state)
                .catch(async error => {
                    await this.replyToCloseRequests(state.closeRequests.splice(0), String(error))
                    throw error
                })
                .finally(async () => {
                    try {
                        await this.life.release?.(id, ownerId)
                    } finally {
                        this.sessions.delete(id)
                    }
                })
                .then(() => this.replyToCloseRequests(state.closeRequests)),
        }

        this.sessions.set(id, session)
        void session.done.catch(error => console.error("会话运行失败", id, error))
        return session
    }

    private async replyToCloseRequests(requests: SessionCloseRequest[], error?: string): Promise<void> {
        await Promise.all(requests.map(async ({replyTo, expiresAt}) => {
            if (expiresAt <= Date.now()) return
            await this.store.submit_pending_messages({
                kind: "session-close-result", session: replyTo, expiresAt, error,
            })
        }))
    }

    private async runSession(id: string, ready: Promise<AgentCore>, state: SessionState): Promise<void> {
        const agent = await ready
        const listener = this.listener
        const delivery = listener && createAgentEventSmoother(async event => {
            try {
                await listener.onEvent(event)
            } catch (error) {
                console.error("事件发送失败", id, event.type, error)
            }
        })
        let historyWrites = Promise.resolve()
        let unsubscribe: (() => void) | undefined

        try {
            unsubscribe = agent.subscribe(event => {
                if (event.type !== "message.delta") {
                    historyWrites = historyWrites.then(() => this.store.append_history_to_store(event))
                        .catch(error => console.error("事件写入历史失败", id, event.type, error))
                }
                delivery?.push(event)
            })

            agent.startHeartbeat(() => this.life.report(id, state.ownerId))
            await this.consumePending(id, agent, state)
        } finally {
            try {
                await agent.dispose()
            } finally {
                unsubscribe?.()
                await Promise.all([historyWrites, delivery?.end()])
            }
        }
    }

    private async consumePending(id: string, agent: AgentCore, state: SessionState): Promise<void> {
        const running = new Set<Promise<void>>()

        while (true) {
            let batch: PendingMessage[]
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

            for (const message of batch) {
                if ("kind" in message) {
                    if (message.kind === "session-close" && message.expiresAt > Date.now() &&
                        (message.ownerId === undefined || message.ownerId === state.ownerId)) {
                        state.closeRequests.push(message)
                        this.beginClose(state)
                    }
                    continue
                }

                const {operation, options} = message
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
