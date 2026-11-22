import type {AgentEvent, Submission} from "../model.ts";

export interface HistoryStore {
    load_history_from_store(id: string): Promise<Array<AgentEvent>>
    append_history_to_store(event: AgentEvent): Promise<void>

    /** Take the currently queued batch without waiting for new messages. */
    recall_pending_messages(id: string): Promise<Array<Submission>>

    /**
     * Wait until messages are available and take a batch. On cancellation, return
     * an empty batch if nothing was taken, or return the batch already taken.
     */
    wait_and_recall_pending_messages(id: string, signal: AbortSignal): Promise<Array<Submission>>

    submit_pending_messages(submission: Submission): Promise<void>
}

export function createMemoryPendingStore(): Pick<
    HistoryStore,
    | "submit_pending_messages"
    | "recall_pending_messages"
    | "wait_and_recall_pending_messages"
> {
    const queues = new Map<string, Submission[]>()
    const waiters = new Map<string, (batch: Submission[]) => void>()

    function take(id: string): Submission[] {
        const batch = queues.get(id) ?? []
        queues.delete(id)
        return batch
    }

    return {
        async submit_pending_messages(submission) {
            const id = submission.session
            const waiter = waiters.get(id)
            if (waiter) {
                waiter([submission])
                return
            }

            const queue = queues.get(id) ?? []
            queue.push(submission)
            queues.set(id, queue)
        },

        async recall_pending_messages(id) {
            return take(id)
        },

        async wait_and_recall_pending_messages(id, signal) {
            if (signal.aborted) return []

            const batch = take(id)
            if (batch.length > 0) return batch

            if (waiters.has(id)) {
                throw new Error(`Session ${id} already has a waiting consumer`)
            }

            return new Promise<Submission[]>(resolve => {
                const cancel = () => finish([])

                function finish(messages: Submission[]) {
                    signal.removeEventListener("abort", cancel)
                    waiters.delete(id)
                    resolve(messages)
                }

                waiters.set(id, finish)
                signal.addEventListener("abort", cancel, { once: true })
            })
        },
    }
}