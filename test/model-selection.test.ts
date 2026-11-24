import assert from "node:assert/strict"
import test from "node:test"
import type {Api, Model} from "@oh-my-pi/pi-ai"
import {narrowerLimit, pickCatalogModel, pickTurnModel} from "../src/agent/oh-my-pi/model-selection.ts"

function row(provider: string, id: string, api: Api, vendor: string): Model<Api> {
    return {
        provider, id, api, name: id, baseUrl: "", reasoning: false,
        input: ["text"], contextWindow: 100_000, maxTokens: 10_000,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        identity: {class: vendor},
    } as Model<Api>
}

const none = () => false

test("model id alone selects the vendor's own provider, not a relay ranked above it", () => {
    const models = [
        row("alibaba-token-plan", "deepseek-v4-pro", "openai-completions", "deepseek"),
        row("deepseek", "deepseek-v4-pro", "openai-completions", "deepseek"),
        row("opencode-zen", "deepseek-v4-pro", "openai-completions", "deepseek"),
    ]

    assert.equal(pickTurnModel(models, "deepseek-v4-pro", none)?.provider, "deepseek")
})

test("vendors whose provider id differs from the vendor name resolve through the vendor table", () => {
    const kimi = [row("moonshot", "kimi-k2.5", "openai-completions", "kimi")]
    const glm = [row("zai", "glm-4.6", "anthropic-messages", "glm")]
    const mimo = [row("xiaomi", "mimo-v2.5", "openai-completions", "mimo")]

    assert.equal(pickTurnModel(kimi, "kimi-k2.5", none)?.provider, "moonshot")
    assert.equal(pickTurnModel(glm, "glm-4.6", none)?.provider, "zai")
    assert.equal(pickTurnModel(mimo, "mimo-v2.5", none)?.provider, "xiaomi")
})

test("credentials narrow the pool before the vendor does", () => {
    const models = [
        row("deepseek", "deepseek-v4-pro", "openai-completions", "deepseek"),
        row("openrouter", "deepseek-v4-pro", "openai-completions", "deepseek"),
    ]

    assert.equal(pickTurnModel(models, "deepseek-v4-pro", model => model.provider === "openrouter")?.provider, "openrouter")
    assert.equal(pickTurnModel(models, "deepseek-v4-pro", none)?.provider, "deepseek")
})

test("gateway metadata ignores credentials and takes the vendor's own row", () => {
    const models = [
        row("openrouter", "deepseek-v4-pro", "openai-completions", "deepseek"),
        row("deepseek", "deepseek-v4-pro", "openai-completions", "deepseek"),
    ]

    assert.equal(pickCatalogModel(models, "deepseek-v4-pro")?.provider, "deepseek")
})

test("an unknown vendor still resolves through the registry ordering", () => {
    const models = [
        row("nanogpt", "acme-1", "openai-completions", "unknown"),
        row("kilo", "acme-1", "openai-completions", "unknown"),
    ]

    assert.ok(pickTurnModel(models, "acme-1", none))
})

test("no candidate yields no model", () => {
    assert.equal(pickTurnModel([], "missing", none), undefined)
})

test("limits take the smaller of the turn and the catalog", () => {
    assert.equal(narrowerLimit(200_000, 100_000), 100_000)
    assert.equal(narrowerLimit(8_192, 100_000), 8_192)
    assert.equal(narrowerLimit(100_000, undefined), 100_000)
    assert.equal(narrowerLimit(0, 100_000), 100_000)
})
