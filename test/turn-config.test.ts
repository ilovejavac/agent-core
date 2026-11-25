import assert from "node:assert/strict"
import test from "node:test"
import {createAgentSession} from "@oh-my-pi/pi-coding-agent/sdk"
import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager"
import type {AgentSession} from "@oh-my-pi/pi-coding-agent/session/agent-session"
import {createAssistantMessageEventStream, type AssistantMessage} from "@oh-my-pi/pi-ai"
import {applyTurnConfig} from "../src/agent/oh-my-pi/config.ts";

const base = {
    revision: 1,
    contextWindow: 200_000,
    maxTokens: 32_000,
    thinkingLevel: "low" as const,
}

async function withSession(run: (session: AgentSession) => Promise<void>): Promise<void> {
    const {session} = await createAgentSession({
        cwd: process.cwd(),
        sessionManager: SessionManager.inMemory(),
    })
    try {
        await run(session)
    } finally {
        await session.dispose()
    }
}

test("the vendor's own endpoint is used for a known model, with the turn's key", async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base, protocol: "openai-completions", model: "deepseek-v4-pro", apiKey: "sk-test",
        })

        assert.equal(session.model!.provider, "deepseek")
        assert.equal(session.model!.id, "deepseek-v4-pro")
    })
})

test("vendor names that differ from the provider id still reach the official endpoint", async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base, protocol: "anthropic-messages", model: "glm-4.6", apiKey: "sk-test",
        })
        assert.equal(session.model!.provider, "zai")

        await applyTurnConfig(session, {
            ...base, protocol: "openai-completions", model: "kimi-k2.5", apiKey: "sk-test",
        })
        assert.equal(session.model!.provider, "moonshot")
    })
})

test("a custom base url keeps the protocol and accepts a model the catalog has never seen", async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base,
            protocol: "anthropic-messages",
            model: "my-private-model",
            baseurl: "https://gateway.invalid",
            apiKey: "sk-test",
        })

        assert.equal(session.model!.api, "anthropic-messages")
        assert.equal(session.model!.id, "my-private-model")
        assert.equal(session.model!.baseUrl, "https://gateway.invalid")
    })
})

test("a custom base url over a catalog model stays on the gateway", async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base,
            protocol: "openai-responses",
            model: "gpt-5",
            baseurl: "https://gateway.invalid/v1",
            apiKey: "sk-test",
        })

        assert.match(session.model!.provider, /^agent-gateway-/)
        assert.equal(session.model!.baseUrl, "https://gateway.invalid/v1")
    })
})

test("turn limits tighten a catalog model and never widen it", async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-test",
            contextWindow: 50_000, maxTokens: 4_000,
        })

        assert.equal(session.model!.contextWindow, 50_000)
        assert.equal(session.model!.maxTokens, 4_000)

        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-test",
            contextWindow: 9_000_000, maxTokens: 9_000_000,
        })

        const catalog = session.modelRegistry.find("openai", "gpt-5")!
        assert.equal(session.model!.contextWindow, catalog.contextWindow)
        assert.equal(session.model!.maxTokens, catalog.maxTokens)
    })
})

test("a model the catalog does not have fails instead of guessing", async () => {
    await withSession(async session => {
        await assert.rejects(
            applyTurnConfig(session, {
                ...base, protocol: "openai-completions", model: "no-such-model", apiKey: "sk-test",
            }),
            /找不到与 openai-completions\/no-such-model 匹配的模型/,
        )
    })
})

test("a protocol the model is not served on fails instead of switching transports", async () => {
    await withSession(async session => {
        await assert.rejects(
            applyTurnConfig(session, {
                ...base, protocol: "google-generative-ai", model: "gpt-5", apiKey: "sk-test",
            }),
            /找不到与 google-generative-ai\/gpt-5 匹配的模型/,
        )
    })
})

test("a gateway turn without a key fails", async () => {
    await withSession(async session => {
        await assert.rejects(
            applyTurnConfig(session, {
                ...base, protocol: "openai-completions", model: "gpt-5",
                baseurl: "https://gateway.invalid/v1", apiKey: "",
            }),
            /自定义网关需要有效的 API Key/,
        )
    })
})

test("a provider with no endpoint of its own asks for one instead of failing later", async () => {
    await withSession(async session => {
        await assert.rejects(
            applyTurnConfig(session, {
                ...base, protocol: "azure-openai-responses", model: "gpt-5", apiKey: "sk-test",
            }),
            /没有默认接口地址，请通过 baseurl 指定端点/,
        )

        await applyTurnConfig(session, {
            ...base, protocol: "azure-openai-responses", model: "gpt-5",
            baseurl: "https://my.openai.azure.com/openai", apiKey: "sk-test",
        })
        assert.equal(session.model!.baseUrl, "https://my.openai.azure.com/openai")
    })
})

test("an official key does not leak into the next turn", async () => {
    await withSession(async session => {
        session.modelRegistry.authStorage.keys.setConfig("openai", "sk-default")
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-turn-one",
        })
        assert.equal(await session.modelRegistry.getApiKey(session.model!), "sk-turn-one")

        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "",
        })
        assert.equal(await session.modelRegistry.getApiKey(session.model!), "sk-default")
    })
})

test("switching models preserves runtime credentials supplied outside turn config", async () => {
    await withSession(async session => {
        const keys = session.modelRegistry.authStorage.keys
        keys.setRuntime("openai", "sk-external")
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "",
        })
        await applyTurnConfig(session, {
            ...base, protocol: "openai-completions", model: "deepseek-v4-pro", apiKey: "sk-turn",
        })
        assert.equal(await keys.get("openai"), "sk-external")
    })
})

test("an invalid configuration keeps the current model's credential", async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-current",
        })
        await assert.rejects(applyTurnConfig(session, {
            ...base, protocol: "azure-openai-responses", model: "gpt-5", apiKey: "sk-invalid",
        }), /没有默认接口地址/)
        assert.equal(await session.modelRegistry.getApiKey(session.model!), "sk-current")
    })
})

test("a turn key temporarily overrides an existing runtime key", async () => {
    await withSession(async session => {
        const keys = session.modelRegistry.authStorage.keys
        keys.setRuntime("openai", "sk-external")
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-turn",
        })
        assert.equal(await keys.get("openai"), "sk-turn")
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "",
        })
        assert.equal(await keys.get("openai"), "sk-external")
    })
})

test("the same session can switch official models, gateway endpoints, and keys repeatedly", async () => {
    await withSession(async session => {
        const settings = [
            {protocol: "openai-responses" as const, model: "gpt-5", apiKey: "sk-first"},
            {protocol: "openai-responses" as const, model: "gpt-5", apiKey: "sk-second"},
            {protocol: "openai-completions" as const, model: "deepseek-v4-pro", apiKey: "sk-deepseek"},
            {protocol: "openai-completions" as const, model: "deepseek-v4-pro", apiKey: "sk-gateway",
                baseurl: "https://gateway.invalid/v1"},
            {protocol: "openai-completions" as const, model: "private-model", apiKey: "sk-private",
                baseurl: "https://other-gateway.invalid/v1"},
            {protocol: "openai-responses" as const, model: "gpt-5", apiKey: "sk-return"},
        ]

        for (const [index, setting] of settings.entries()) {
            await applyTurnConfig(session, {...base, ...setting, revision: index + 1})
            assert.equal(session.model!.id, setting.model)
            assert.equal(session.model!.api, setting.protocol)
            assert.equal(await session.modelRegistry.getApiKey(session.model!), setting.apiKey)
            if (setting.baseurl) assert.equal(session.model!.baseUrl, setting.baseurl)
        }
        assert.equal(session.model!.provider, "openai")
    })
})

test("a streaming session accepts a new model and uses it for the next request", {timeout: 10_000}, async () => {
    await withSession(async session => {
        await applyTurnConfig(session, {
            ...base, protocol: "openai-responses", model: "gpt-5", apiKey: "sk-first",
        })
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const requested: string[] = []
        session.agent.streamFn = model => {
            const stream = createAssistantMessageEventStream()
            requested.push(model.id)
            const message: AssistantMessage = {
                role: "assistant", content: [{type: "text", text: "ok"}],
                api: model.api, provider: model.provider, model: model.id,
                usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
                stopReason: "stop", timestamp: Date.now(),
            }
            stream.push({type: "start", partial: message})
            started.resolve()
            void release.promise.then(() => {
                stream.push({type: "done", reason: "stop", message})
                stream.end()
            })
            return stream
        }

        const running = session.agent.prompt("first request")
        try {
            await started.promise
            assert.equal(session.isStreaming, true)
            await applyTurnConfig(session, {
                ...base, revision: 2, protocol: "openai-completions",
                model: "deepseek-v4-pro", apiKey: "sk-next",
            })
            assert.equal(session.model!.id, "deepseek-v4-pro")
            assert.equal(await session.modelRegistry.getApiKey(session.model!), "sk-next")
        } finally {
            release.resolve()
            await running
        }
        await session.agent.prompt("next request")
        assert.deepEqual(requested, ["gpt-5", "deepseek-v4-pro"])
    })
})
