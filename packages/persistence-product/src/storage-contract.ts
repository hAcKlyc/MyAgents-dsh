import { Session, SessionId, SessionLogOffset, adoptSessionEvent, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import { assertVersion, materializeCreateHeader, SessionPersistenceCorruptionError, validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import { expandAssistantStream } from "@deepseek-ai/dsh-llm";
import { isProductOperationEventType, validateProductOperationEventData } from "@myagents-dsh/operation-runtime";
import { validateProductCheckpointEvent } from "@myagents-dsh/checkpoint";
import { isProductPermissionEventType, validateProductPermissionEventData } from "@myagents-dsh/tool-runtime-product";
import { isProductWorkEventType, validateProductWorkEventData } from "@myagents-dsh/tools-agent";
import { isProductTaskEventType, validateProductTaskEventData } from "@myagents-dsh/task-graph";
import { validateProductPlanTransition } from "@myagents-dsh/tools-interaction";

import { PRODUCT_REQUIRED_SESSION_EVENT_TYPES } from "./known-events.js";
import { validateProductCompactionReceipt } from "./compaction.js";
import { validateProductForkReceipt } from "./fork.js";
import { validateProductRewindReceipt } from "./rewind.js";

const productTypes = new Set<string>(PRODUCT_REQUIRED_SESSION_EVENT_TYPES);

const validateProductPayload = (event: SessionEvent): void => {
  if (isProductOperationEventType(event.type)) return validateProductOperationEventData(event.type, event.data);
  if (isProductPermissionEventType(event.type)) return validateProductPermissionEventData(event.type, event.data);
  if (isProductWorkEventType(event.type)) { validateProductWorkEventData(event.type, event.data); return; }
  if (isProductTaskEventType(event.type)) { validateProductTaskEventData(event.type, event.data); return; }
  switch (event.type) {
    case "myagents/checkpoint/state": validateProductCheckpointEvent(event); return;
    case "myagents/plan/transition": validateProductPlanTransition(event.data); return;
    case "myagents/session/compaction": validateProductCompactionReceipt(event.data); return;
    case "myagents/session/fork": validateProductForkReceipt(event.data); return;
    case "myagents/session/rewind": validateProductRewindReceipt(event.data); return;
    case "myagents/session/configuration": {
      const data: unknown = event.data;
      if (data === null || typeof data !== "object" || Array.isArray(data)
        || Object.keys(data).length !== 1 || !("revision" in data)
        || typeof data.revision !== "string" || data.revision.length === 0 || data.revision.length > 256
        // Configuration identifiers exclude ASCII controls; Unicode grapheme boundaries are irrelevant.
        // eslint-disable-next-line no-control-regex
        || /[\u0000-\u001f\u007f]/u.test(data.revision)) {
        throw new TypeError("Product configuration anchor must contain one bounded revision");
      }
      return;
    }
    default: throw new TypeError(`Product event has no payload validator: ${event.type}`);
  }
};

/** Validate metadata through the public native Session owner; the physical cut remains separate. */
export const materializeProductSessionHeader = (
  header: SessionHeader,
  inheritedEventCount?: SessionLogOffset,
): SessionHeader => {
  const snapshot = materializeCreateHeader(header);
  SessionId(snapshot.id);
  assertVersion(snapshot);
  if (snapshot.isSeeded && inheritedEventCount === undefined) {
    throw new TypeError("seeded Session requires its exact inherited event count");
  }
  const cut = SessionLogOffset(inheritedEventCount ?? 0);
  if (!snapshot.isSeeded && cut !== 0) throw new TypeError("unseeded Session cannot inherit events");
  // Validate the header without inventing events for an as-yet unmaterialized
  // inherited prefix. Its actual cut is checked against the first stored batch.
  return Session.fromRestore(snapshot.id, [], snapshot, SessionLogOffset(0), "detached").header;
};

/** Compose the native vocabulary with the exact Product registry, without changing native globals. */
export const validateProductStoredEvents = (header: SessionHeader, events: SessionEvent[]): SessionEvent[] => {
  for (const [index, event] of events.entries()) {
    if (!productTypes.has(event.type)) {
      const validated = validateStoredEvents(header, [event])[0];
      if (validated === undefined) throw new Error("native event validation lost its record");
      if (validated.type === "assistant/message" || validated.type === "assistant/attempt") {
        try { expandAssistantStream(validated.data.stream); }
        catch (cause) { throw new SessionPersistenceCorruptionError("stored assistant stream failed native validation", { cause }); }
      }
      events[index] = deepFreeze(validated);
      continue;
    }
    try {
      const adopted = adoptSessionEvent(event);
      validateProductPayload(adopted);
      events[index] = deepFreeze(adopted);
    } catch (cause) {
      throw new SessionPersistenceCorruptionError("stored Product Session event failed validation", { cause });
    }
  }
  return events;
};
