import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { isProductPermissionEventType } from "@myagents-dsh/tool-runtime-product";
import { z } from "zod";

interface ColdPermissionHistory {
  inheritedEventCount: number;
  permissionEvents: SessionEvent[];
  nativePolicyTail: SessionEvent[];
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap { myagentsColdPermissionHistory: ColdPermissionHistory }
}

const projection: ProjectionDefinition<"myagentsColdPermissionHistory"> = {
  key: "myagentsColdPermissionHistory", stateVersion: 1,
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative(),
    permissionEvents: z.array(z.custom<SessionEvent>()),
    nativePolicyTail: z.array(z.custom<SessionEvent>()),
  }),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, permissionEvents: [], nativePolicyTail: [] }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state;
    if (event.type === "myagents/operation/accepted" || event.type === "myagents/operation/terminal") {
      return { ...state, nativePolicyTail: [] };
    }
    const permissionEvent = isProductPermissionEventType(event.type);
    const nativeEvent = event.type === "myagents/permission/config"
      || event.type === "sandbox/mode" || event.type === "approval/policy";
    if (!permissionEvent && !nativeEvent) return state;
    return {
      ...state,
      permissionEvents: permissionEvent ? [...state.permissionEvents, event] : state.permissionEvents,
      nativePolicyTail: nativeEvent ? [...state.nativePolicyTail, event] : state.nativePolicyTail,
    };
  },
};

export const installColdPermissionHistory = (ctx: Context): (() => void) => ctx.sessionProjections.register(projection);

export const coldPermissionHistory = (ctx: Context, session: Session): Readonly<ColdPermissionHistory> => {
  const state = ctx.sessionProjections.stateOf(session, "myagentsColdPermissionHistory");
  if (state === undefined) throw new Error("cold permission history projection is unavailable");
  return state;
};
