export type UserInput = {
    kind: "user-input"

    mode: 'steer' | 'followup'
    prompt: string

    skills: {
      name: string
      path: string
    }

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

export type TurnConfig = {
    revision: number
    provider: 'openai' | 'anthropic' | 'google' | 'grok' | 'kimi' | 'deepseek'
    baseurl?: string
    model: string
    apiKey: string
    contextWindow: number
    thinkingLevel: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra',
}

export type UserOperation = UserInput | UserInterrupt | UserCompact | UserResume

export type Submission = {
    session: string,
    options: AgentOptions,
    operation: UserOperation
}

export type AgentEvent = {
    type: string
    usage?: any
}

export interface AgentEventListener {
    onEvent(evt: AgentEvent): Promise<void>
}

export interface AgentLife {
    alive(id: string): Promise<boolean>

    report(id: string): Promise<void>
}
