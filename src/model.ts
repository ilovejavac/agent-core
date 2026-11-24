import type {AgentEventDelivery} from "./event.ts"

export type {AgentEvent} from "./event.ts"

export type UserInput = {
    kind: "user-input"

    mode: 'steer' | 'followup'
    prompt: string

    skills: {
      name: string
      path: string
    }[]

    attachments: {
        index: number,
        path: string,
        detail: string
    }[]

    mentions: {
        name: string,
        path: string
    }[]
}

export type UserInterrupt = {
    kind: "user-interrupt"
}

export type UserResume = {
    kind: "user-resume"
}

export type UserCompact = {
    kind: "user-compact"
}

export type UserSettingOverride = {
    kind: "user-setting-override"
    setting: TurnConfig
}

export type AgentOptions = {
    cwd: string,
    setting: TurnConfig
}

export type TurnProtocol =
    | 'openai-responses'
    | 'openai-completions'
    | 'anthropic-messages'
    | 'google-generative-ai'
    | 'azure-openai-responses'

export type TurnConfig = {
    revision: number
    protocol: TurnProtocol
    baseurl?: string
    model: string
    apiKey: string
    contextWindow: number,
    maxTokens: number,
    thinkingLevel: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra',
}

export type UserOperation = UserInput | UserInterrupt | UserCompact | UserResume

export type Submission = {
    session: string,
    options: AgentOptions,
    operation: UserOperation
}

export interface AgentEventListener {
    onEvent(evt: AgentEventDelivery): Promise<void>
}

export interface AgentLife {
    alive(id: string): Promise<boolean | string>

    report(id: string, ownerId: string): Promise<void>

    release?(id: string, ownerId: string): Promise<void>
}
