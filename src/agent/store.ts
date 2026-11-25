import type {AgentLife, Submission} from "../model.ts";
import type {AgentEvent} from "../event.ts";
import {dirname, join} from 'node:path'
import {mkdir, open, readFile, type FileHandle} from 'node:fs/promises';

export type SessionCloseRequest = {
    kind: "session-close"
    session: string
    replyTo: string
    expiresAt: number
    ownerId?: string
}

export type SessionCloseResult = {
    kind: "session-close-result"
    session: string
    expiresAt: number
    error?: string
}

export type PendingMessage = Submission | SessionCloseRequest | SessionCloseResult

export interface HistoryStore {
    /** Load stored events for this session in append order. */
    load_history_from_store(id: string): Promise<Array<AgentEvent>>

    append_history_to_store(id: string, event: AgentEvent): Promise<void>

    /** Take the currently queued batch without waiting for new messages. */
    recall_pending_messages(id: string): Promise<PendingMessage[]>

    /**
     * Wait until messages are available and take a batch. On cancellation, return
     * an empty batch if nothing was taken, or return the batch already taken.
     */
    wait_and_recall_pending_messages(id: string, signal: AbortSignal): Promise<PendingMessage[]>

    submit_pending_messages(message: PendingMessage): Promise<void>
}

type FileHistoryWriter = {
    handle?: Promise<FileHandle>
    tail: Promise<void>
    idleTimer?: ReturnType<typeof setTimeout>
}

export function createFileBasedHistoryAppendLoader(path: string): Pick<HistoryStore, 'load_history_from_store' | 'append_history_to_store'> {
    const writers = new Map<string, FileHistoryWriter>();
    const idleCloseMs = 30_000;

    function writerFor(filename: string): FileHistoryWriter {
        let writer = writers.get(filename);
        if (!writer) {
            writer = {tail: Promise.resolve()};
            writers.set(filename, writer);
        }
        return writer;
    }

    function openWriter(filename: string, writer: FileHistoryWriter): Promise<FileHandle> {
        if (writer.handle) return writer.handle;

        const handle = (async () => {
            await mkdir(dirname(filename), {recursive: true, mode: 0o700});
            const file = await open(filename, 'a+', 0o600);
            try {
                const journal = await file.readFile();
                const end = journal.lastIndexOf(0x0a) + 1;
                if (end !== journal.length) {
                    await file.truncate(end);
                    await file.sync();
                }
                return file;
            } catch (error) {
                await file.close();
                throw error;
            }
        })();

        writer.handle = handle;
        void handle.catch(() => {
            if (writer.handle === handle) writer.handle = undefined;
        });
        return handle;
    }

    function scheduleIdleClose(writer: FileHistoryWriter): void {
        writer.idleTimer = setTimeout(() => {
            writer.idleTimer = undefined;
            const close = writer.tail.then(async () => {
                if (!writer.handle) return;
                const handle = writer.handle;
                try {
                    await (await handle).close();
                } finally {
                    if (writer.handle === handle) writer.handle = undefined;
                }
            });
            writer.tail = close.catch(() => {});
        }, idleCloseMs);
        writer.idleTimer.unref?.();
    }

    return {
        async append_history_to_store(id: string, event: AgentEvent): Promise<void> {
            const filename = join(path, `rollout-${id}.jsonl`)
            const writer = writerFor(filename);
            clearTimeout(writer.idleTimer);
            writer.idleTimer = undefined;
            const write = writer.tail.then(async () => {
                const file = await openWriter(filename, writer);
                await file.appendFile(`${JSON.stringify(event)}\n`);
                await file.sync();
            });
            const settled = write.catch(() => {});
            writer.tail = settled;
            void settled.then(() => {
                if (writer.tail === settled) scheduleIdleClose(writer);
            });
            await write;
        },

        async load_history_from_store(id: string): Promise<Array<AgentEvent>> {
            const filename = join(path, `rollout-${id}.jsonl`)
            await writers.get(filename)?.tail;
            try {
                const journal = await readFile(filename, 'utf8');
                return journal.slice(0, journal.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                return [];
            }
        }
    }
}

export function createMemoryAgentLife(): AgentLife {

    const aliveMap = new Map<string, string>()

    return {
        async alive(id: string): Promise<boolean | string> {
            return aliveMap.get(id) ?? false
        },
        async release(id: string, ownerId: string): Promise<void> {
            if (aliveMap.get(id) === ownerId) {
                aliveMap.delete(id)
            }
        },
        async report(id: string, ownerId: string): Promise<void> {
            aliveMap.set(id, ownerId)
        }
    }
}

export function createMemoryPendingStore(): Pick<
    HistoryStore,
    | "submit_pending_messages"
    | "recall_pending_messages"
    | "wait_and_recall_pending_messages"
> {
    const queues = new Map<string, PendingMessage[]>()
    const waiters = new Map<string, (batch: PendingMessage[]) => void>()

    function take(id: string): PendingMessage[] {
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

            return new Promise<PendingMessage[]>(resolve => {
                const cancel = () => finish([])

                function finish(messages: PendingMessage[]) {
                    signal.removeEventListener("abort", cancel)
                    waiters.delete(id)
                    resolve(messages)
                }

                waiters.set(id, finish)
                signal.addEventListener("abort", cancel, {once: true})
            })
        },
    }
}
