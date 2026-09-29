import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { queueHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "myagents-task-assignment": {
      kind: "myagents-task-assignment";
      taskId: string;
    };
  }
}

export const isNativeContinuableChild = (root: Agent, childId: string): boolean =>
  root.session.ownEvents().some((event) => event.type === "subagent/catalog"
    && String(event.data.childId) === childId && event.data.mode === "continuable");

export const notifyNativeSharedTask = async (
  ctx: Context,
  root: Agent,
  childId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<void> => {
  if (!isNativeContinuableChild(root, childId)) throw new Error("task recipient is no longer a direct continuable child");
  await queueHostSubagentPrompt(
    ctx.subagents,
    root,
    SessionId(childId),
    [{ type: "text", text: `Shared task ${taskId} is available to you. Call TaskGet with {"taskId":"${taskId}","list":"shared"} to read its current requirements before acting.` }],
    { kind: "myagents-task-assignment", taskId },
    signal,
  );
};
