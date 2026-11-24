import {ThinkingLevel} from "@oh-my-pi/pi-agent-core/thinking";
import type {TurnConfig} from "../../model.ts";

export const thinkingLevels = {
    none: ThinkingLevel.Off,
    low: ThinkingLevel.Low,
    medium: ThinkingLevel.Medium,
    high: ThinkingLevel.High,
    xhigh: ThinkingLevel.XHigh,
    max: ThinkingLevel.Max,
    ultra: ThinkingLevel.Max,
} satisfies Record<TurnConfig["thinkingLevel"], ThinkingLevel>
