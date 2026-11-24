import type {AgentSession} from "@oh-my-pi/pi-coding-agent/session/agent-session"
import type {ModelRegistry} from "@oh-my-pi/pi-coding-agent/config/model-registry"
import type {Model} from "@oh-my-pi/pi-ai"
import type {TurnConfig} from "../../model.ts"
import {GATEWAY_PROVIDER_PREFIX, narrowerLimit, pickCatalogModel, pickTurnModel} from "./model-selection.ts"
import {thinkingLevels} from "./thinking.ts"

type RuntimeKey = {provider: string, apiKey: string, previous?: string}

const runtimeKeys = new WeakMap<AgentSession, RuntimeKey>()

export async function applyTurnConfig(session: AgentSession, setting: TurnConfig): Promise<void> {
    const registry = session.modelRegistry
    const modelId = setting.model.trim()
    const baseUrl = setting.baseurl?.trim()
    const apiKey = setting.apiKey?.trim()
    if (!modelId) throw new Error("模型名不能为空")
    if (baseUrl && (!apiKey || apiKey.startsWith("!"))) {
        throw new Error("自定义网关需要有效的 API Key")
    }

    const candidates = registry.getAll().filter(model =>
        model.id.toLowerCase() === modelId.toLowerCase()
        && !model.provider.startsWith(GATEWAY_PROVIDER_PREFIX)
    )
    const matching = candidates.filter(model => model.api === setting.protocol)
    if (!baseUrl && matching.length === 0) {
        throw new Error(`找不到与 ${setting.protocol}/${modelId} 匹配的模型`)
    }

    const keys = registry.authStorage.keys
    const previous = runtimeKeys.get(session)
    restoreRuntimeKey(registry, previous)
    runtimeKeys.delete(session)

    try {
        let model = baseUrl
            ? registerGateway(registry, setting, modelId, baseUrl, apiKey!,
                pickCatalogModel(matching.length ? matching : candidates, modelId))
            : apiKey
                ? pickCatalogModel(matching, modelId)!
                : pickTurnModel(matching, modelId, candidate => registry.hasConfiguredAuth(candidate))!

        requireEndpoint(registry, model)

        if (!baseUrl && apiKey) {
            const priorKey = keys.source(model.provider)?.kind === "runtime"
                ? await keys.peek(model.provider) : undefined
            keys.setRuntime(model.provider, apiKey)
            runtimeKeys.set(session, {provider: model.provider, apiKey, previous: priorKey})
        }

        if (!baseUrl) {
            model = {
                ...model,
                contextWindow: narrowerLimit(setting.contextWindow, model.contextWindow),
                maxTokens: narrowerLimit(setting.maxTokens, model.maxTokens),
            }
        }
        await session.setModelTemporary(model, thinkingLevels[setting.thinkingLevel])
        session.setSteeringMode("all", false)
    } catch (error) {
        restoreRuntimeKey(registry, runtimeKeys.get(session))
        runtimeKeys.delete(session)
        if (previous) {
            keys.setRuntime(previous.provider, previous.apiKey)
            runtimeKeys.set(session, previous)
        }
        throw error
    }
}

function requireEndpoint(registry: ModelRegistry, model: Model): void {
    if (!model.baseUrl && !registry.getProviderBaseUrl(model.provider)) {
        throw new Error(`${model.provider}/${model.id} 没有默认接口地址，请通过 baseurl 指定端点`)
    }
}

function registerGateway(
    registry: ModelRegistry,
    setting: TurnConfig,
    modelId: string,
    baseUrl: string,
    apiKey: string,
    catalog?: Model,
): Model {
    const provider = `${GATEWAY_PROVIDER_PREFIX}${setting.protocol}`
    registry.registerProvider(provider, {
        api: setting.protocol,
        baseUrl,
        apiKey,
        models: [{
            id: modelId,
            name: catalog?.name ?? modelId,
            input: catalog ? [...catalog.input] : ["text"],
            contextWindow: narrowerLimit(setting.contextWindow, catalog?.contextWindow),
            maxTokens: narrowerLimit(setting.maxTokens, catalog?.maxTokens),
            cost: catalog?.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        }],
    })
    const model = registry.find(provider, modelId)
    if (!model) throw new Error(`找不到模型：${provider}/${modelId}`)
    return model
}

function restoreRuntimeKey(registry: ModelRegistry, key?: RuntimeKey): void {
    if (!key) return
    if (key.previous === undefined) registry.authStorage.keys.removeRuntime(key.provider)
    else registry.authStorage.keys.setRuntime(key.provider, key.previous)
}
