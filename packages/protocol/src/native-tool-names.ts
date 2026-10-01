/** The build owns one model-visible tool vocabulary for its entire lifetime. */
export const NATIVE_TOOL_NAMES = Object.freeze({
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Agent: "subagent",
  TaskStop: "interrupt_agent",
  SendMessage: "send_message",
} as const);

export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[keyof typeof NATIVE_TOOL_NAMES]
  | "read_image" | "fork_agent" | "list_agents";

const reverse: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(NATIVE_TOOL_NAMES).map(([canonical, official]) => [official, canonical]),
));

export const canonicalToolForModelName = (name: string): string =>
  name === "read_image" ? "Read"
    : name === "fork_agent" ? "Agent"
      : name === "list_agents" ? "SendMessage" : reverse[name] ?? name;

export const modelToolNames = <T extends string>(
  canonical: readonly T[],
): readonly (T | NativeToolName)[] => Object.freeze(canonical.flatMap((name): (T | NativeToolName)[] => {
      const replacement = (NATIVE_TOOL_NAMES as Readonly<Record<string, NativeToolName>>)[name];
      return replacement === undefined ? [name]
        : replacement === "read" ? ["read", "read_image"]
          : replacement === "subagent" ? ["subagent", "fork_agent"]
            : replacement === "send_message" ? ["send_message", "list_agents"] : [replacement];
    }));
