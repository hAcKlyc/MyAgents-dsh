import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

// DSH 0.1.7-rc.2 declares the official list-agents export but publishes its
// implementation under lib/types instead of the declared lib entry. Keep this
// small adapter on the public SubagentRuntime API until that export is fixed.
export const registerNativeSubagentList = (ctx: Context): (() => void) => ctx.tools.register(defineTool({
  name: "list_agents",
  description: "List continuable subagents you started. Running means active now; inactive agents can be continued with send_message. Use descendants to see the whole tree; only direct children accept send_message.",
  parameters: {
    scope: {
      type: "string",
      enum: ["children", "descendants"],
      description: "Direct children by default, or all descendants.",
    },
  },
  output: {
    schema: { type: "array", items: { type: "object", additionalProperties: true } },
    render: (_args, entries) => [{ type: "text", text: JSON.stringify(entries) }],
  },
  async execute(args, exec) {
    if (exec.agent === undefined) throw new Error("list_agents requires a calling Agent");
    const entries = args.scope === "descendants"
      ? await ctx.subagents.listDescendants(exec.agent.id, exec.signal)
      : await ctx.subagents.listChildren(exec.agent.id, exec.signal);
    const rows: Array<{ kind: string; id: string; [key: string]: string | number }> = [];
    for (const entry of entries) {
      const at = "parentId" in entry ? { parent: entry.parentId, depth: entry.depth } : {};
      if ("kind" in entry && entry.kind === "diagnostic") {
        rows.push({ kind: "diagnostic", id: entry.id, reason: entry.reason, ...at });
        continue;
      }
      if (entry.mode !== "continuable") continue;
      rows.push({
        kind: "child", id: entry.id, label: entry.label,
        status: ctx.agents.get(entry.id)?.status === "running" ? "running" : "inactive",
        ...at,
      });
    }
    return rows;
  },
}));
