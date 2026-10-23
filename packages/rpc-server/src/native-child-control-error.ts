import { ProtocolError } from "@myagents-dsh/protocol";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-subagent";

/** Translate only the native public control refusal vocabulary; never forward raw diagnostics. */
export function rethrowNativeChildControlError(error: unknown): never {
  const failure = remoteErrorOf(error);
  if (failure !== undefined) {
    switch (failure.code) {
      case "subagent/not-resumable":
        throw new ProtocolError("subagent_not_resumable",
          "This child has no supported continuation state. Historical externally owned children are read-only.");
      case "subagent/unauthorized":
        throw new ProtocolError("subagent_unauthorized", "The child does not belong to the addressed parent.");
      case "subagent/parent-unavailable":
      case "subagent/delivery-unavailable":
        throw new ProtocolError("subagent_unavailable", "The native child or its parent is temporarily unavailable.", true);
      case "gateway/cancelled":
        throw new ProtocolError("request_cancelled", "The native child request was cancelled.", true);
    }
  }
  throw error;
}
