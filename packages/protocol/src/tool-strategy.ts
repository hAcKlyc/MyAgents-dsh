/** The build owns one model-visible tool vocabulary for its entire lifetime. */
export const DSH_FIRST_REPLACEMENTS = Object.freeze({
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

export type DshToolStrategy = "ma_first" | "dsh_first";
export type DshFirstToolName = (typeof DSH_FIRST_REPLACEMENTS)[keyof typeof DSH_FIRST_REPLACEMENTS]
  | "read_image" | "fork_agent" | "list_agents";

const reverse: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(DSH_FIRST_REPLACEMENTS).map(([canonical, official]) => [official, canonical]),
));

export const canonicalToolForModelName = (name: string): string =>
  name === "read_image" ? "Read"
    : name === "fork_agent" ? "Agent"
      : name === "list_agents" ? "SendMessage" : reverse[name] ?? name;

export const modelToolNamesForStrategy = <T extends string>(
  canonical: readonly T[],
  strategy: DshToolStrategy,
): readonly (T | DshFirstToolName)[] => strategy === "ma_first"
  ? canonical
  : Object.freeze(canonical.flatMap((name): (T | DshFirstToolName)[] => {
      const replacement = (DSH_FIRST_REPLACEMENTS as Readonly<Record<string, DshFirstToolName>>)[name];
      return replacement === undefined ? [name]
        : replacement === "read" ? ["read", "read_image"]
          : replacement === "subagent" ? ["subagent", "fork_agent"]
            : replacement === "send_message" ? ["send_message", "list_agents"] : [replacement];
    }));
