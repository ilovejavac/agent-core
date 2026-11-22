import type {AgentEvent, AgentOptions, UserOperation} from "../model.ts"

export interface AgentCore {
    handleInput(input: UserOperation, options: AgentOptions): Promise<void>
    waitForEnd(): Promise<void>
    subscribe(listener: (event: AgentEvent) => void): () => void
    startHeartbeat(report: () => Promise<void>): void
    dispose(): Promise<void>
}

export abstract class AbstractAgent implements AgentCore {
    private heartbeat?: ReturnType<typeof setInterval>
    private reporting?: Promise<void>
    private disposal?: Promise<void>

    protected constructor(protected readonly id: string) {}

    startHeartbeat(report: () => Promise<void>): void {
        if (this.heartbeat !== undefined || this.disposal) return

        const tick = () => {
            if (this.reporting) return
            this.reporting = Promise.resolve()
                .then(report)
                .catch(error => console.error("心跳上报失败", this.id, error))
                .finally(() => {
                    this.reporting = undefined
                })
        }

        this.heartbeat = setInterval(tick, 5000)
        tick()
    }

    dispose(): Promise<void> {
        clearInterval(this.heartbeat)
        return this.disposal ??= this.finishDispose()
    }

    private async finishDispose(): Promise<void> {
        await this.reporting
        await this.doDispose()
    }

    abstract handleInput(input: UserOperation, options: AgentOptions): Promise<void>
    abstract waitForEnd(): Promise<void>
    abstract subscribe(listener: (event: AgentEvent) => void): () => void
    protected abstract doDispose(): Promise<void>
}
