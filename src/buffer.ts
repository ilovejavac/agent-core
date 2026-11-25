import type {AgentEvent, AgentEventDelivery} from "./event.ts"

const maxTimerMs = 2_147_483_647

type Delta = Extract<AgentEvent, {type: "message.delta"}>

function isSamePart(first: Delta, next: Delta): boolean {
    return first.sessionId === next.sessionId && first.runId === next.runId && first.turnId === next.turnId &&
        first.payload.messageId === next.payload.messageId && first.payload.partIndex === next.payload.partIndex &&
        first.payload.kind === next.payload.kind
}

export function createAgentEventSmoother(
    write: (event: AgentEventDelivery) => void | Promise<void>,
    {intervalMs = 16} = {},
) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > maxTimerMs) {
        throw new RangeError("intervalMs is outside the supported timer range")
    }

    let active: {source: Delta; text: string} | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let writes = Promise.resolve()
    let ended = false
    let seq = 0

    function send(event: AgentEventDelivery): void {
        writes = writes.then(() => write({...event, seq: ++seq}))
        void writes.catch(() => undefined)
    }

    function flush(seal: boolean): void {
        clearTimeout(timer)
        timer = undefined
        if (!active) return

        const {source, text} = active
        const lastCodeUnit = text.charCodeAt(text.length - 1)
        const keepTail = !seal && lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF
        const delta = keepTail ? text.slice(0, -1) : text
        active = keepTail ? {source, text: text.slice(-1)} : undefined
        if (delta) send({...source, id: crypto.randomUUID(), payload: {...source.payload, delta}})
    }

    return {
        push(event: AgentEvent): void {
            if (ended) throw new Error("The event input is closed")

            if (event.type === "message.delta") {
                if (!event.payload.delta) return
                if (active && !isSamePart(active.source, event)) flush(true)
                if (active) active.text += event.payload.delta
                else active = {source: event, text: event.payload.delta}
                timer ??= setTimeout(() => flush(false), intervalMs)
                return
            }

            if (event.type === "message.ended" || event.type === "turn.ended" || event.type === "run.ended") {
                flush(true)
            }

            if (event.type === "message.ended") {
                const {id, sessionId, runId, turnId, timestamp, seq, payload} = event
                const {messageId, role, usage} = payload
                send({
                    type: "message.ended", id, sessionId, runId, timestamp, seq,
                    ...(turnId === undefined ? {} : {turnId}),
                    payload: {messageId, role, ...(usage === undefined ? {} : {usage})},
                })
            } else {
                send(event)
            }
        },

        end(): Promise<void> {
            ended = true
            flush(true)
            return writes
        },
    }
}
