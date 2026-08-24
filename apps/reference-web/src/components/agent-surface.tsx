import { useMemo } from "react";

import type { RuntimeProjection } from "@myagents-dsh/web-host-contract";

import type { BrowserHistoryEvent, BrowserHistorySnapshot } from "../history.js";
import type { LocalInput } from "../store.js";

type RuntimeEnvelope = RuntimeProjection["events"][number];
type ConversationRow = Readonly<{
  id: string;
  at: string;
  tone: "user" | "assistant" | "thinking" | "tool" | "system";
  label: string;
  title?: string;
  body: string;
  queuedMessageId?: string;
  queuedState?: "queued" | "admitted" | "delivered" | "cancelled";
}>;

const detail = (value: unknown): string => {
  if (value === undefined) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…` : text;
};
const rowForEvent = (envelope: RuntimeEnvelope): ConversationRow => {
  const event = envelope.event;
  const base = { id: `${envelope.runtimeGeneration}:${envelope.sequence}`, at: envelope.emittedAt };
  switch (event.kind) {
    case "assistant_delta": return { ...base, tone: "assistant", label: "Assistant", body: event.delta };
    case "thinking_delta": return { ...base, tone: "thinking", label: "Reasoning", body: event.delta };
    case "tool": return {
      ...base, tone: "tool", label: "Tool", title: `${event.name} · ${event.phase}`, body: detail(event.detail),
    };
    case "usage": return {
      ...base, tone: "system", label: "Usage", title: `${event.usage.totalTokens.toLocaleString()} tokens`,
      body: event.usage.costUsd === null ? "Cost unavailable" : `$${event.usage.costUsd.toFixed(4)}`,
    };
    case "context": return {
      ...base, tone: "system", label: "Context", title: event.modelProfileRevision,
      body: event.contextOccupiedTokens === null
        ? `Window ${event.runtimeContextWindow.toLocaleString()}`
        : `${event.contextOccupiedTokens.toLocaleString()} / ${event.runtimeContextWindow.toLocaleString()} tokens`,
    };
    case "warning": return { ...base, tone: "system", label: "Warning", title: event.code, body: event.message };
    case "turn_terminal": return {
      ...base, tone: "system", label: "Turn", title: event.terminal.kind.replaceAll("_", " "), body: detail(event.terminal),
    };
    case "queued_message": return {
      ...base,
      tone: "system",
      label: "Queue",
      title: event.state,
      body: `Message ${event.messageId}`,
      queuedMessageId: event.messageId,
      queuedState: event.state,
    };
    case "plan": return { ...base, tone: "system", label: "Plan", title: event.revision, body: detail(event.detail) };
    case "task_graph": return { ...base, tone: "system", label: "Tasks", title: event.revision, body: detail(event.detail) };
    case "work": return { ...base, tone: "system", label: "Subagent", title: event.phase, body: detail(event.detail) };
    case "component": return {
      ...base, tone: "system", label: "Component", title: event.component.key,
      body: `${event.component.state}${event.component.reason === undefined ? "" : ` · ${event.component.reason}`}`,
    };
    default: return { ...base, tone: "system", label: "Runtime", title: event.kind.replaceAll("_", " "), body: detail(event) };
  }
};
const foldRows = (events: readonly RuntimeEnvelope[]): ConversationRow[] => {
  const rows: ConversationRow[] = [];
  for (const envelope of events) {
    const next = rowForEvent(envelope);
    const previous = rows.at(-1);
    if (previous?.tone === next.tone
      && (next.tone === "assistant" || next.tone === "thinking") && previous.label === next.label) {
      rows[rows.length - 1] = { ...previous, body: `${previous.body}${next.body}`, at: next.at };
    } else rows.push(next);
  }
  return rows;
};
const jsonRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
const messageText = (value: unknown): string | undefined => {
  const message = jsonRecord(value);
  if (!Array.isArray(message?.content)) return undefined;
  const parts = message.content.flatMap((candidate) => {
    const block = jsonRecord(candidate);
    if (block?.type === "text" && typeof block.text === "string") return [block.text];
    if (block?.type === "image") return ["[image]"];
    return [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
};
const rowForHistory = (event: BrowserHistoryEvent): ConversationRow | undefined => {
  const data = jsonRecord(event.data);
  const base = { id: `history:${event.sequence}:${event.eventSha256}`, at: `0000:${String(event.sequence).padStart(12, "0")}` };
  if (event.eventType === "user/message") {
    return { ...base, tone: "user", label: "You", body: messageText(data) ?? detail(event.data) };
  }
  if (event.eventType === "assistant/message") {
    return { ...base, tone: "assistant", label: "Assistant", body: messageText(data?.message) ?? detail(event.data) };
  }
  if (event.eventType === "assistant/chunk") {
    const chunk = jsonRecord(data?.chunk);
    if (typeof chunk?.text !== "string") return undefined;
    return {
      ...base,
      tone: chunk.type === "reasoning-delta" ? "thinking" : "assistant",
      label: chunk.type === "reasoning-delta" ? "Reasoning" : "Assistant",
      body: chunk.text,
    };
  }
  if (event.eventType.includes("tool")) {
    return { ...base, tone: "tool", label: "Tool", title: event.eventType, body: detail(event.data) };
  }
  if (event.eventType === "myagents/operation/terminal") {
    return { ...base, tone: "system", label: "Turn", title: "durable terminal", body: detail(event.data) };
  }
  return undefined;
};

export function ConversationSurface(props: Readonly<{
  projection: RuntimeProjection | undefined;
  history: BrowserHistorySnapshot | undefined;
  localInputs: readonly LocalInput[];
  onCancelQueued: (messageId: string) => Promise<void>;
}>): React.JSX.Element {
  const runtimeRows = useMemo(() => foldRows(props.projection?.events ?? []), [props.projection?.events]);
  const historyRows = useMemo(() => runtimeRows.length > 0 ? []
    : (props.history?.events ?? []).flatMap((event) => {
      const row = rowForHistory(event);
      return row === undefined ? [] : [row];
    }), [props.history?.events, runtimeRows.length]);
  const timeline = useMemo(() => [
    ...historyRows.map((row) => ({ kind: "runtime" as const, id: row.id, at: row.at, row })),
    ...props.localInputs.map((input) => ({ kind: "local" as const, id: input.id, at: input.createdAt, input })),
    ...runtimeRows.map((row) => ({ kind: "runtime" as const, id: row.id, at: row.at, row })),
  ].sort((left, right) => left.at.localeCompare(right.at)), [historyRows, props.localInputs, runtimeRows]);
  if (runtimeRows.length === 0 && historyRows.length === 0 && props.localInputs.length === 0) {
    return <section className="conversation empty-conversation" aria-label="Conversation">
      <div className="empty-mark" aria-hidden="true">⌁</div>
      <h2>What are we building?</h2>
      <p>Ask the DSH Root Agent to inspect, change, or explain the selected workspace.</p>
    </section>;
  }
  return <section className="conversation" aria-label="Conversation" aria-live="off">
    {props.history !== undefined && props.history.status !== "complete" && <div className="history-status" role="status">
      {props.history.status === "loading" && "Restoring durable DSH history…"}
      {props.history.status === "truncated" && "Visible durable history reached its browser bound; Runtime truth is unchanged."}
      {props.history.status === "failed" && "Durable history could not be verified. Live Runtime events remain visible."}
    </div>}
    <div className="conversation-list">
      {timeline.map((item) => item.kind === "local"
        ? <article className="conversation-row user-row" key={item.id}>
            <div className="row-label">You</div>
            <div className="message-card user-card">
              <p>{item.input.text}</p>
              {item.input.attachmentNames.length > 0 && <div className="attachment-chips">
                {item.input.attachmentNames.map((name) => <span key={name}>⌕ {name}</span>)}
              </div>}
              <span className={`delivery-state delivery-${item.input.state}`}>{item.input.state}</span>
            </div>
          </article>
        : <article className={`conversation-row ${item.row.tone}-row`} key={item.id}>
            <div className="row-label">{item.row.label}</div>
            <div className={`message-card ${item.row.tone}-card`}>
              {item.row.title !== undefined && <strong>{item.row.title}</strong>}
              {item.row.tone === "thinking"
                ? <details open><summary>Reasoning trace</summary><p>{item.row.body}</p></details>
                : item.row.body.startsWith("{") || item.row.body.includes("\n")
                  ? <pre>{item.row.body}</pre>
                  : <p>{item.row.body}</p>}
              {item.row.queuedMessageId !== undefined
                && (item.row.queuedState === "queued" || item.row.queuedState === "admitted")
                && <button className="row-action" type="button"
                  onClick={() => {
                    const messageId = item.row.queuedMessageId;
                    if (messageId !== undefined) void props.onCancelQueued(messageId);
                  }}>
                  Cancel queued message
                </button>}
            </div>
          </article>)}
    </div>
    <div className="sr-only" aria-live="polite">{runtimeRows.at(-1)?.label ?? "Conversation ready"}</div>
  </section>;
}
