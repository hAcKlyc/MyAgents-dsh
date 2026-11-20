import type {} from "@deepseek-ai/dsh-subagent";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectionDefinition, ProjectionHandle } from "@deepseek-ai/dsh-session-projection";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { MessageSource } from "@deepseek-ai/dsh-llm";
import { ownsOfficialJobNotice } from "@myagents-dsh/operation-runtime";
import { ownsHistoricalWorkMessage } from "./historical-work-events.js";

interface ContextProvenanceState { inheritedEventCount: number; events: SessionEvent[] }
const contextProvenance: ProjectionDefinition<"myagentsContextProvenance", ContextProvenanceState> = {
  key: "myagentsContextProvenance", stateVersion: 2,
  stateSchema: z.object({ inheritedEventCount: z.number().int().nonnegative(), events: z.array(z.custom<SessionEvent>()) }),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, events: [] }),
  apply: (state, event) => event.seq < state.inheritedEventCount
    || (event.type !== "subagent/catalog" && event.type !== "agent/inbox/spliced" && event.type !== "myagents/native-child-message-operation")
    ? state : { ...state, events: [...state.events, event] },
};
declare module "@deepseek-ai/cordis" {
  interface Context { productContextProvenance: ProjectionHandle<ContextProvenanceState> }
}

export const installProductContextProjection = async (ctx: Context): Promise<() => Promise<void>> => {
  const handle = await ctx.sessionProjections.register(contextProvenance);
  const detach = ctx.provide("productContextProvenance", handle);
  return async () => { detach(); await handle.dispose(); };
};

export const ownsRootContextMessage = (
  session: Session,
  source: MessageSource | undefined,
  messageId: string,
  ctx: Context,
): boolean => {
  const kind: string | undefined = source?.kind;
  const events = kind === "tool-jobs" || kind === "agent-message" || kind === "subagent-settled" || kind === "agent-instructions"
    ? ctx.get("productContextProvenance")?.stateOf(session).events ?? [] : [];
  if (ownsOfficialJobNotice(events, source, messageId)) return true;
  // Native instruction reconciliation can discard a queued delta and inject its
  // replacement directly. Its exact persisted Inbox source owns that lifecycle,
  // not the Product operation ledger (including historical crash recovery).
  if (kind === "agent-instructions") {
    return events.some((event) => event.type === "agent/inbox/spliced"
      && event.data.inserted.some((message) => message.id === messageId
        && isDeepStrictEqual(message.source, source)));
  }
  if (source?.kind === "agent-message" || source?.kind === "subagent-settled") {
    const admitted = events.some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) =>
      message.id === messageId && isDeepStrictEqual(message.source, source)));
    if (admitted && events.some((event) =>
      (event.type === "subagent/catalog" && event.data.childId === source.senderSessionId)
      || (source.kind === "agent-message" && event.type === "myagents/native-child-message-operation"
        && event.data.messageId === messageId))) return true;
  }
  return ownsHistoricalWorkMessage(session, source, messageId);
};
