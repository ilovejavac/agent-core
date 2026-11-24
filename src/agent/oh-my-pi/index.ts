import type {AgentSession} from "@oh-my-pi/pi-coding-agent/session/agent-session"
import {USER_INTERRUPT_LABEL} from "@oh-my-pi/pi-coding-agent/session/messages"
import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager"
import {createAgentSession} from "@oh-my-pi/pi-coding-agent/sdk"
import type {AgentEvent, AgentOptions, UserOperation} from "../../model.ts"
import {AbstractAgent, type AgentCore} from "../core.ts"
import {applyTurnConfig} from "./config.ts";
import {toEvents} from "./events.ts"
import {restoreHistory} from "./history.ts"

export async function CreateOhMyPiAgent(
    id: string, options: AgentOptions, history: readonly AgentEvent[] = [],
): Promise<AgentCore> {
    const sessionManager = SessionManager.inMemory()
    restoreHistory(sessionManager, history)
    const {session} = await createAgentSession({
        cwd: options.cwd,
        sessionManager,
    })
    await applyTurnConfig(session, options.setting)

    return new OhMyPiAgent(id, session)
}

class OhMyPiAgent extends AbstractAgent {
    private readonly events: ReturnType<typeof toEvents>
    private readonly listeners = new Set<(event: AgentEvent) => void>()
    private unsubscribeCore?: () => void

    constructor(id: string, private readonly core: AgentSession) {
        super(id)
        this.events = toEvents(id)
    }

    override subscribe(listener: (event: AgentEvent) => void): () => void {
        this.listeners.add(listener)
        this.unsubscribeCore ??= this.core.subscribe(event => this.publishEvents(this.events.convert(event)))
        return () => { this.listeners.delete(listener) }
    }

    private publishEvents(events: AgentEvent[]): void {
        for (const event of events) {
            for (const subscriber of this.listeners) subscriber(event)
        }
    }

    override waitForEnd(): Promise<void> {
        return this.core.waitForIdle()
    }

    protected override async doDispose(): Promise<void> {
        try {
            await this.core.dispose()
            this.publishEvents(this.events.dispose())
        } finally {
            this.unsubscribeCore?.()
            this.unsubscribeCore = undefined
            this.listeners.clear()
        }
    }

    override async handleInput(input: UserOperation): Promise<void> {
        switch (input.kind) {
            case "user-input":
                await this.core.prompt(input.prompt, {
                    streamingBehavior: input.mode === "followup" ? "followUp" : "steer",
                    throwOnDrop: true,
                })
                return

            case "user-interrupt":
                await this.core.abort({reason: USER_INTERRUPT_LABEL})
                return

            case "user-compact":
                await this.core.compact()
                return

            case "user-resume":
                await this.core.resume()
                return
        }
    }
}
