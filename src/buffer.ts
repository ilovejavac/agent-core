import type {AgentEvent, AgentEventDelivery} from "./event.ts"

const maxTimerMs = 2_147_483_647

function validatePacing(intervalMs: number, charsPerTick: number, bufferMs: number) {
    if (!Number.isInteger(charsPerTick) || charsPerTick < 1) {
        throw new RangeError("charsPerTick must be a positive integer");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > maxTimerMs) {
        throw new RangeError("intervalMs is outside the supported timer range");
    }
    if (!Number.isInteger(bufferMs) || bufferMs < 0 || bufferMs > maxTimerMs) {
        throw new RangeError("bufferMs is outside the supported timer range")
    }
}

function wait(intervalMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, intervalMs))
}

export function createEventSmoother(
    write: (chunk: string) => void | Promise<void>,
    {intervalMs = 16, charsPerTick = 2, bufferMs = 200} = {},
) {
    validatePacing(intervalMs, charsPerTick, bufferMs)

    let buffer = "";
    let ended = false;
    let running = false;
    let started = bufferMs === 0
    const reserveChars = Math.ceil(bufferMs / intervalMs)
    let releaseBuffer: (() => void) | undefined
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;

    const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    async function drain(): Promise<void> {
        if (running) return;
        running = true;

        try {
            if (!started && !ended && buffer.length < reserveChars * charsPerTick) {
                await new Promise<void>(resolve => {
                    const timer = setTimeout(() => releaseBuffer?.(), bufferMs)
                    releaseBuffer = () => {
                        clearTimeout(timer)
                        releaseBuffer = undefined
                        resolve()
                    }
                })
            }
            started = true
            while (buffer) {
                await wait(intervalMs);

                let end = 0;
                let count = 0;
                const limit = !ended && buffer.length <= reserveChars ? 1 : charsPerTick
                for (const char of buffer) {
                    // 保留末尾单独的高代理项，等待下一段补齐 emoji 等字符。
                    if (!ended && end + 1 === buffer.length && /[\uD800-\uDBFF]/.test(char)) {
                        break;
                    }

                    end += char.length;
                    count += 1;
                    if (count === limit) break;
                }

                if (end === 0) break;

                const chunk = buffer.slice(0, end);
                buffer = buffer.slice(end);
                await write(chunk);
            }

            if (ended) resolveDone();
        } catch (error) {
            ended = true;
            buffer = "";
            rejectDone(error);
        } finally {
            running = false;
        }
    }

    return {
        push(chunk: string) {
            if (ended) throw new Error("The text input is closed");
            if (!chunk) return;

            buffer += chunk;
            if (buffer.length >= reserveChars * charsPerTick) releaseBuffer?.()
            void drain();
        },

        end() {
            ended = true;
            releaseBuffer?.()
            void drain();
            return done;
        },

        done,
    };
}

export function createAgentEventSmoother(
    write: (event: AgentEventDelivery) => void | Promise<void>,
    {intervalMs = 16, charsPerTick = 3, bufferMs = 200} = {},
) {
    validatePacing(intervalMs, charsPerTick, bufferMs)
    type Delta = Extract<AgentEvent, {type: "message.delta"}>
    let pending: Promise<void> | undefined
    let writes = Promise.resolve()
    let ended = false
    let seq = 0
    let nextDeltaAt = 0
    let active: {source: Delta; smoother: ReturnType<typeof createEventSmoother>} | undefined

    function enqueue(completion: Promise<void>) {
        pending = completion
        void completion.then(() => {
            if (pending === completion) pending = undefined
        }, () => undefined)
    }

    function send(event: AgentEventDelivery): Promise<void> {
        writes = writes.then(async () => {
            if (event.type === "message.delta") nextDeltaAt = performance.now() + intervalMs
            await write({...event, seq: ++seq})
        })
        void writes.catch(() => undefined)
        return writes
    }

    function seal() {
        if (!active) return
        void active.smoother.end()
        active = undefined
    }

    return {
        push(event: AgentEvent): void {
            if (ended) throw new Error("The event input is closed")

            if (event.type === "message.ended" || event.type === "turn.ended" || event.type === "run.ended") {
                seal()
                let delivery: AgentEventDelivery
                if (event.type === "message.ended") {
                    const {id, sessionId, runId, turnId, timestamp, seq, payload} = event
                    delivery = {
                        type: "message.ended", id, sessionId, runId, timestamp, seq,
                        ...(turnId === undefined ? {} : {turnId}),
                        payload: {messageId: payload.messageId, role: payload.role},
                    }
                } else {
                    delivery = event
                }
                if (pending) enqueue(pending.then(() => send(delivery)))
                else void send(delivery)
                return
            }

            if (event.type !== "message.delta") {
                void send(event)
                return
            }

            if (!event.payload.delta) return
            const source = active?.source
            if (!active || source?.sessionId !== event.sessionId || source.runId !== event.runId ||
                source.turnId !== event.turnId || source.payload.messageId !== event.payload.messageId ||
                source.payload.partIndex !== event.payload.partIndex || source.payload.kind !== event.payload.kind) {
                seal()
                const previous = pending
                const smoother = createEventSmoother(async delta => {
                    await previous
                    const delay = Math.ceil(nextDeltaAt - performance.now())
                    if (delay > 0) await wait(delay)
                    await send({...event, id: crypto.randomUUID(), payload: {...event.payload, delta}})
                }, {intervalMs, charsPerTick, bufferMs})
                active = {source: event, smoother}
                enqueue(smoother.done)
            }
            active.smoother.push(event.payload.delta)
        },

        async end(): Promise<void> {
            ended = true
            seal()
            await pending
            await writes
        },
    }
}
