import type {AgentSession} from "@oh-my-pi/pi-coding-agent/session/agent-session"
import {USER_INTERRUPT_LABEL} from "@oh-my-pi/pi-coding-agent/session/messages"
import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager"
import {createAgentSession} from "@oh-my-pi/pi-coding-agent/sdk"
import type {AgentEvent, AgentOptions, UserOperation} from "../model.ts"
import {type AgentCore, AbstractAgent} from "./core.ts"

export async function CreateOhMyPiAgent(id: string, options: AgentOptions): Promise<AgentCore> {
    const {session} = await createAgentSession({
        cwd: options.cwd,
        sessionManager: SessionManager.inMemory(),
    })

    session.setSteeringMode("all", false)
    return new OhMyPiAgent(id, session)
}

class OhMyPiAgent extends AbstractAgent {
    constructor(id: string, private readonly core: AgentSession) {
        super(id)
    }

    override subscribe(listener: (event: AgentEvent) => void): () => void {
        return this.core.subscribe(listener)
    }

    override waitForEnd(): Promise<void> {
        return this.core.waitForIdle()
    }

    protected override doDispose(): Promise<void> {
        return this.core.dispose()
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

            default:
                return assertNever(input)
        }
    }
}

function assertNever(_input: never): never {
    throw new Error("Unsupported user operation")
}
