export const PRODUCT_CONFIGURATION_EVENT_TYPES = Object.freeze([
  "myagents/session/configuration",
] as const);

export interface ProductConfigurationAnchorEventData {
  readonly revision: string;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "myagents/session/configuration": ProductConfigurationAnchorEventData;
  }
}
