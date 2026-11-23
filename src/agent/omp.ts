import {ThinkingLevel} from "@oh-my-pi/pi-agent-core/thinking"
import type {AgentSession} from "@oh-my-pi/pi-coding-agent/session/agent-session"
import {USER_INTERRUPT_LABEL} from "@oh-my-pi/pi-coding-agent/session/messages"
import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager"
import {createAgentSession} from "@oh-my-pi/pi-coding-agent/sdk"
import type {AgentEvent, AgentOptions, TurnConfig, UserOperation} from "../model.ts"
import {type AgentCore, AbstractAgent} from "./core.ts"

const thinkingLevels = {
    none: ThinkingLevel.Off,
    low: ThinkingLevel.Low,
    medium: ThinkingLevel.Medium,
    high: ThinkingLevel.High,
    xhigh: ThinkingLevel.XHigh,
    max: ThinkingLevel.Max,
    ultra: ThinkingLevel.Max,
} satisfies Record<TurnConfig["thinkingLevel"], ThinkingLevel>

export async function CreateOhMyPiAgent(id: string, options: AgentOptions): Promise<AgentCore> {
    const {session} = await createAgentSession({
        cwd: options.cwd,
        sessionManager: SessionManager.inMemory(),
    })
    await applyTurnConfig(session, options.setting)

    return new OhMyPiAgent(id, session)
}

async function applyTurnConfig(session: AgentSession, setting: TurnConfig) {
    const registry = session.modelRegistry
    const modelId = setting.model.trim()
    const baseUrl = setting.baseurl?.trim()
    if (!modelId) throw new Error("模型名不能为空")

    let providerId: string = setting.provider

    if (baseUrl) {
        const apiKey = setting.apiKey?.trim()
        if (!apiKey || apiKey.startsWith("!")) {
            throw new Error("自定义网关需要有效的 API Key")
        }

        const catalogModel = registry.find(providerId, modelId)

        providerId = `agent-gateway-${providerId}`
        registry.registerProvider(providerId, {
            api: catalogModel?.api ?? "openai-responses",
            baseUrl,
            apiKey,
            models: [{
                id: modelId,
                name: catalogModel?.name ?? modelId,
                input: catalogModel ? [...catalogModel.input] : ["text"],
                contextWindow: catalogModel?.contextWindow ?? setting.contextWindow,
                maxTokens: catalogModel?.maxTokens ?? setting.maxTokens,
                cost:  catalogModel?.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
            }],
        })
    }

    const model = registry.find(providerId, modelId)
    if (!model) throw new Error(`找不到模型：${providerId}/${modelId}`)
    await session.setModelTemporary(model, thinkingLevels[setting.thinkingLevel])

    session.setSteeringMode("all", false)
}

class OhMyPiAgent extends AbstractAgent {
    constructor(id: string, private readonly core: AgentSession) {
        super(id)
    }

    override subscribe(listener: (event: AgentEvent) => void): () => void {
        return this.core.subscribe(async (event) => {
            console.log(JSON.stringify(event))
        })
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
