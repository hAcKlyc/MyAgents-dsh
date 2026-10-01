import type {} from "@deepseek-ai/dsh-subagent";
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { MessageSource } from "@deepseek-ai/dsh-llm";
import { ownsOfficialJobNotice } from "@myagents-dsh/operation-runtime";
import { ownsHistoricalWorkMessage } from "./historical-work-events.js";

interface ContextProvenanceState { inheritedEventCount: number; events: SessionEvent[] }
declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap { myagentsContextProvenance: ContextProvenanceState }
}
const contextProvenance: ProjectionDefinition<"myagentsContextProvenance"> = {
  key: "myagentsContextProvenance", stateVersion: 1,
  stateSchema: z.object({ inheritedEventCount: z.number().int().nonnegative(), events: z.array(z.custom<SessionEvent>()) }),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, events: [] }),
  apply: (state, event) => event.seq < state.inheritedEventCount
    || (event.type !== "subagent/catalog" && event.type !== "agent/inbox/spliced")
    ? state : { ...state, events: [...state.events, event] },
};
export const installProductContextProjection = (ctx: Context): (() => void) =>
  ctx.sessionProjections.register(contextProvenance);

export const ownsRootContextMessage = (
  session: Session,
  source: MessageSource | undefined,
  messageId: string,
  ctx: Context,
): boolean => {
  const kind: string | undefined = source?.kind;
  const events = kind === "tool-jobs" || kind === "agent-message" || kind === "subagent-settled"
    ? ctx.sessionProjections.stateOf(session, "myagentsContextProvenance")?.events ?? [] : [];
  if (ownsOfficialJobNotice(events, source, messageId)) return true;
  // DSH owns native relay/settlement provenance through the parent catalog and Inbox.
  // Native messages use the parent catalog and exact Inbox insertion.
  if ((source?.kind === "agent-message" || source?.kind === "subagent-settled")
    && events.some((event) => event.type === "subagent/catalog" && event.data.childId === source.senderSessionId)
    && events.some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) =>
      message.id === messageId && message.source.kind === source.kind
      && "senderSessionId" in message.source && message.source.senderSessionId === source.senderSessionId))) return true;
  return ownsHistoricalWorkMessage(session, source, messageId);
};
