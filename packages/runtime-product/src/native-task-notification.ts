import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "myagents-task-assignment": {
      kind: "myagents-task-assignment";
      taskId: string;
    };
  }
}

export const resolveNativeTaskRecipient = (root: Agent, address: string): string | undefined =>
  (root.ctx.sessionProjections.snapshot(root.session, ["subagentCatalog"]).values.subagentCatalog ?? [])
    .find((entry) => entry.mode === "continuable" && (entry.id === address || entry.name === address))?.id;

export const notifyNativeSharedTask = async (
  ctx: Context,
  root: Agent,
  childId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<void> => {
  if (resolveNativeTaskRecipient(root, childId) !== childId) throw new Error("task recipient is no longer a direct continuable child");
  await ctx.subagents.queueHostPrompt(
    SessionId(childId),
    [{ type: "text", text: `Shared task ${taskId} assignment/offer changed. Call TaskGet with {"taskId":"${taskId}","list":"shared"} to read its current requirements and assignment before acting. If it is missing or no longer assigned/offered to you, do not act on this notification.` }],
    { kind: "myagents-task-assignment", taskId },
    signal,
  );
};
