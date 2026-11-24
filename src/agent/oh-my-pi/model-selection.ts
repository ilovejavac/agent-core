import {resolveModelFromString} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type {Api, Model} from "@oh-my-pi/pi-ai";

export const GATEWAY_PROVIDER_PREFIX = "agent-gateway-"

const VENDOR_PROVIDERS: Record<string, readonly string[]> = {
    gemini: ["google", "google-vertex"],
    gemma: ["google", "google-vertex"],
    xai: ["xai", "xai-oauth"],
    kimi: ["kimi-code", "moonshot"],
    glm: ["zai", "zhipu-coding-plan"],
    minimax: ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"],
    qwen: ["qwen-portal", "alibaba-token-plan"],
    mimo: ["xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"],
    meta: ["meta", "muse-code"],
    amazon: ["amazon-bedrock"],
}

export function pickTurnModel(
    models: Model<Api>[],
    modelId: string,
    hasAuth: (model: Model<Api>) => boolean,
): Model<Api> | undefined {
    if (models.length === 0) return undefined

    const configured = models.filter(hasAuth)
    const pool = configured.length > 0 ? configured : models
    return pickCatalogModel(pool, modelId)
}

export function pickCatalogModel(models: Model<Api>[], modelId: string): Model<Api> | undefined {
    if (models.length === 0) return undefined
    return pickVendorModel(models) ?? resolveModelFromString(modelId, models) ?? models[0]
}

function pickVendorModel(models: Model<Api>[]): Model<Api> | undefined {
    const vendor = models.find(model => model.identity.class !== "unknown")?.identity.class
    if (!vendor) return undefined

    for (const provider of VENDOR_PROVIDERS[vendor] ?? [vendor]) {
        const match = models.find(model => model.provider === provider)
        if (match) return match
    }

    return undefined
}

export function narrowerLimit(setting: number, catalog: number | null | undefined): number {
    if (!catalog || catalog <= 0) return setting
    if (!setting || setting <= 0) return catalog
    return Math.min(setting, catalog)
}
