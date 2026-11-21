import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition, ProjectionHandle } from "@deepseek-ai/dsh-session-projection";
import { isProductPermissionEventType } from "@myagents-dsh/tool-runtime-product";
import { z } from "zod";

interface ColdPermissionHistory {
  inheritedEventCount: number;
  permissionEvents: SessionEvent[];
  nativePolicyTail: SessionEvent[];
}


const projection: ProjectionDefinition<"myagentsColdPermissionHistory", ColdPermissionHistory> = {
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

export const installColdPermissionHistory = (ctx: Context): Promise<ProjectionHandle<ColdPermissionHistory>> =>
  ctx.sessionProjections.register(projection);
