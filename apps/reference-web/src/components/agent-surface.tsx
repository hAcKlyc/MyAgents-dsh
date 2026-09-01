import { useEffect, useMemo, useRef } from "react";

import type { InteractionResponse, RuntimeProjection } from "@myagents-dsh/web-host-contract";

import type { BrowserHistoryEvent, BrowserHistorySnapshot } from "../history.js";
import type { LocalInput } from "../store.js";
import { ConversationInteractionCard } from "./interaction-tray.js";
import { SafeMarkdown } from "./safe-markdown.js";

type RuntimeEnvelope = RuntimeProjection["events"][number];
type ToolState = "running" | "succeeded" | "failed";
type FlowBlock =
  | Readonly<{ kind: "text"; id: string; source: string }>
  | Readonly<{ kind: "thinking"; id: string; source: string; complete: boolean }>
  | Readonly<{
      kind: "tool";
      id: string;
      name: string;
      state: ToolState;
      input?: unknown;
      output?: unknown;
    }>
  | Readonly<{
      kind: "activity";
      id: string;
      label: string;
      title: string;
      detail?: unknown;
      tone?: "warning";
      queuedMessageId?: string;
      cancellable?: boolean;
    }>;
type AssistantTurn = Readonly<{
  id: string;
  at: string;
  blocks: readonly FlowBlock[];
  terminal?: Readonly<Record<string, unknown>>;
  usage?: Readonly<{ totalTokens: number; costUsd: number | null }>;
}>;
type TimelineItem =
  | Readonly<{ kind: "turn"; id: string; at: string; turn: AssistantTurn }>
  | Readonly<{ kind: "user"; id: string; at: string; text: string; attachmentNames: readonly string[]; state?: LocalInput["state"] }>;

const detailText = (value: unknown): string => {
  if (value === undefined) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…` : text;
};
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
const messageText = (value: unknown): string | undefined => {
  const message = record(value);
  if (!Array.isArray(message?.content)) return undefined;
  const parts = message.content.flatMap((candidate) => {
    const block = record(candidate);
    if (block?.type === "text" && typeof block.text === "string") return [block.text];
    if (block?.type === "image") return ["[图片]"];
    return [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
};
const turnIdFor = (envelope: RuntimeEnvelope): string | undefined => envelope.turnId
  ?? (envelope.event.kind === "turn_admitted" ? envelope.event.admission.turnId : undefined);
const queuedMessageTitle = (state: "queued" | "admitted" | "delivered" | "cancelled"): string => {
  switch (state) {
    case "queued": return "消息正在等待当前任务完成";
    case "admitted": return "排队消息已进入处理";
    case "delivered": return "排队消息已送达 Agent";
    case "cancelled": return "排队消息已取消";
  }
};
const activityFor = (envelope: RuntimeEnvelope): Extract<FlowBlock, { kind: "activity" }> | undefined => {
  const event = envelope.event;
  const id = `${envelope.runtimeGeneration}:${envelope.sequence}`;
  switch (event.kind) {
    case "plan": return { kind: "activity", id, label: "计划", title: `计划已更新 · ${event.revision}`, detail: { mode: event.mode } };
    case "task_graph": return { kind: "activity", id, label: "任务", title: `任务图已更新 · ${event.snapshot.revision}`, detail: event.snapshot };
    case "work": return { kind: "activity", id, label: "协作", title: `${event.snapshot.taskId} · ${event.snapshot.state}`, detail: event.snapshot };
    case "warning": return { kind: "activity", id, label: "警告", title: event.message, detail: { code: event.code }, tone: "warning" };
    case "compaction": return { kind: "activity", id, label: "上下文", title: `压缩${event.phase.replaceAll("_", " ")}` };
    case "retry": return { kind: "activity", id, label: "重试", title: event.phase, detail: event.detail };
    case "queued_message": return {
      kind: "activity",
      id,
      label: "队列",
      title: queuedMessageTitle(event.state),
      queuedMessageId: event.messageId,
      cancellable: event.state === "queued" || event.state === "admitted",
    };
    default: return undefined;
  }
};

const foldRuntimeTurns = (events: readonly RuntimeEnvelope[]): AssistantTurn[] => {
  const mutable = new Map<string, {
    id: string;
    at: string;
    blocks: FlowBlock[];
    terminal?: Readonly<Record<string, unknown>>;
    usage?: Readonly<{ totalTokens: number; costUsd: number | null }>;
  }>();
  const order: string[] = [];
  let latestTurnId: string | undefined;
  const ensure = (envelope: RuntimeEnvelope): ReturnType<typeof mutable.get> => {
    const id = turnIdFor(envelope) ?? latestTurnId;
    if (id === undefined) return undefined;
    latestTurnId = id;
    let turn = mutable.get(id);
    if (turn === undefined) {
      turn = { id, at: envelope.emittedAt, blocks: [] };
      mutable.set(id, turn);
      order.push(id);
    }
    return turn;
  };

  for (const envelope of events) {
    const turn = ensure(envelope);
    if (turn === undefined) continue;
    const event = envelope.event;
    const eventId = `${envelope.runtimeGeneration}:${envelope.sequence}`;
    if (event.kind === "assistant_delta") {
      const previous = turn.blocks.at(-1);
      if (previous?.kind === "text") turn.blocks[turn.blocks.length - 1] = { ...previous, source: `${previous.source}${event.delta}` };
      else turn.blocks.push({ kind: "text", id: eventId, source: event.delta });
      continue;
    }
    if (event.kind === "thinking_delta") {
      const previous = turn.blocks.at(-1);
      if (previous?.kind === "thinking") turn.blocks[turn.blocks.length - 1] = { ...previous, source: `${previous.source}${event.delta}`, complete: false };
      else turn.blocks.push({ kind: "thinking", id: eventId, source: event.delta, complete: false });
      continue;
    }
    if (event.kind === "tool") {
      const id = envelope.toolCallId ?? `${event.name}:${eventId}`;
      const index = turn.blocks.findIndex((block) => block.kind === "tool" && block.id === id);
      const prior = index < 0 ? undefined : turn.blocks[index];
      const isError = event.phase === "end" && event.result.state !== "succeeded";
      const next: FlowBlock = {
        kind: "tool",
        id,
        name: event.name,
        state: event.phase === "end" ? (isError ? "failed" : "succeeded") : "running",
        ...(event.phase === "start" ? { input: event.input } : prior?.kind === "tool" && prior.input !== undefined ? { input: prior.input } : {}),
        ...(event.phase === "start" ? {} : {
          output: event.phase === "end" ? event.result : event.progress,
        }),
      };
      if (index < 0) turn.blocks.push(next);
      else turn.blocks[index] = next;
      continue;
    }
    if (event.kind === "turn_terminal") {
      const terminal = record(event.terminal);
      if (terminal !== undefined) turn.terminal = terminal;
      turn.blocks = turn.blocks.map((block) => block.kind === "thinking" ? { ...block, complete: true } : block);
      continue;
    }
    if (event.kind === "usage") {
      turn.usage = { totalTokens: event.usage.totalTokens, costUsd: event.usage.costUsd };
      continue;
    }
    const activity = activityFor(envelope);
    if (activity !== undefined) {
      if (activity.queuedMessageId !== undefined) {
        turn.blocks = turn.blocks.filter((block) => block.kind !== "activity"
          || block.queuedMessageId !== activity.queuedMessageId);
      }
      turn.blocks.push(activity);
    }
  }
  return order.flatMap((id) => {
    const turn = mutable.get(id);
    return turn === undefined || turn.blocks.length === 0 ? [] : [turn];
  });
};

const historyTimeline = (events: readonly BrowserHistoryEvent[]): TimelineItem[] => {
  const timeline: TimelineItem[] = [];
  const turns = new Map<number, { item: Extract<TimelineItem, { kind: "turn" }>; blocks: FlowBlock[] }>();
  const turnFor = (event: BrowserHistoryEvent, data: Readonly<Record<string, unknown>>) => {
    if (!Number.isSafeInteger(data.turn) || (data.turn as number) < 1) return undefined;
    const turn = data.turn as number;
    const known = turns.get(turn);
    if (known !== undefined) return known;
    const id = `history:turn:${turn}`;
    const at = `0000:${String(event.sequence).padStart(12, "0")}`;
    const blocks: FlowBlock[] = [];
    const item = { kind: "turn" as const, id, at, turn: { id, at, blocks } };
    const created = { item, blocks };
    turns.set(turn, created);
    timeline.push(item);
    return created;
  };
  for (const event of events) {
    const data = record(event.data);
    const at = `0000:${String(event.sequence).padStart(12, "0")}`;
    const id = `history:${event.sequence}:${event.eventSha256}`;
    if (event.eventType === "user/message") {
      timeline.push({ kind: "user", id, at, text: messageText(data) ?? detailText(event.data), attachmentNames: [] });
      continue;
    }
    if (data === undefined) continue;
    const turn = turnFor(event, data);
    if (turn === undefined) continue;
    if (event.eventType === "assistant/chunk") {
      const chunk = record(data.chunk);
      if (typeof chunk?.text !== "string") continue;
      const kind = chunk.type === "reasoning-delta" ? "thinking" as const : "text" as const;
      const previous = turn.blocks.at(-1);
      if (previous?.kind === kind) {
        turn.blocks[turn.blocks.length - 1] = { ...previous, source: `${previous.source}${chunk.text}` };
      } else if (kind === "thinking") {
        turn.blocks.push({ kind, id: `${id}:thinking`, source: chunk.text, complete: true });
      } else {
        turn.blocks.push({ kind, id: `${id}:text`, source: chunk.text });
      }
      continue;
    }
    if (event.eventType === "assistant/message") {
      const text = messageText(data.message);
      if (text !== undefined && !turn.blocks.some((block) => block.kind === "text")) {
        turn.blocks.push({ kind: "text", id: `${id}:text`, source: text });
      }
      continue;
    }
    if (event.eventType === "tool/call") {
      turn.blocks.push({
        kind: "tool",
        id: typeof data.callId === "string" ? data.callId : `${id}:tool`,
        name: typeof data.name === "string" ? data.name : "Tool",
        state: "running",
        input: data.arguments,
      });
      continue;
    }
    if (event.eventType === "tool/result") {
      const index = turn.blocks.findLastIndex((block) => block.kind === "tool" && block.state === "running");
      if (index >= 0) {
        const previous = turn.blocks[index];
        if (previous?.kind === "tool") turn.blocks[index] = { ...previous, state: data.error === undefined ? "succeeded" : "failed", output: event.data };
      }
    }
  }
  return timeline.filter((item) => item.kind === "user" || item.turn.blocks.length > 0);
};

const toolHint = (block: Extract<FlowBlock, { kind: "tool" }>): string | undefined => {
  const input = record(block.input);
  for (const key of ["path", "command", "query", "url", "description", "task"]) {
    if (typeof input?.[key] === "string") return input[key].slice(0, 110);
  }
  return undefined;
};
const statusLabel = (state: ToolState): string => state === "running" ? "运行中" : state === "failed" ? "失败" : "完成";

function ToolBlock(props: Readonly<{ block: Extract<FlowBlock, { kind: "tool" }> }>): React.JSX.Element {
  const hint = toolHint(props.block);
  return <details className="flow-block tool-block" data-state={props.block.state}>
    <summary>
      <span className="flow-status-dot" aria-hidden="true" />
      <span className="flow-title"><strong>{props.block.name}</strong>{hint === undefined ? "" : ` · ${hint}`}</span>
      <span className="flow-state">{statusLabel(props.block.state)}</span>
    </summary>
    <div className="flow-detail">
      {props.block.input !== undefined && <><span>输入</span><pre>{detailText(props.block.input)}</pre></>}
      {props.block.output !== undefined && <><span>结果</span><pre>{detailText(props.block.output)}</pre></>}
    </div>
  </details>;
}

function AssistantTurnView(props: Readonly<{
  turn: AssistantTurn;
  onCancelQueued: (messageId: string) => Promise<void>;
}>): React.JSX.Element {
  const cancelQueued = (messageId: string | undefined): void => {
    if (messageId !== undefined) void props.onCancelQueued(messageId);
  };
  const assistantText = props.turn.blocks.filter((block): block is Extract<FlowBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.source).join("\n\n");
  const terminalKind = typeof props.turn.terminal?.kind === "string"
    ? props.turn.terminal.kind === "succeeded" ? "已完成" : props.turn.terminal.kind.replaceAll("_", " ")
    : undefined;
  return <article className="assistant-turn conversation-entry">
    <div className="assistant-avatar" aria-hidden="true">M</div>
    <div className="assistant-content">
      <div className="assistant-flow">
        {props.turn.blocks.map((block) => {
          if (block.kind === "text") return <SafeMarkdown key={block.id} source={block.source} />;
          if (block.kind === "thinking") return <details className="flow-block thinking-block" open={!block.complete} key={block.id}>
            <summary><span className="thinking-icon" aria-hidden="true">✦</span><span>{block.complete ? "思考过程" : "正在思考…"}</span><span className="flow-state">{block.complete ? "展开" : "生成中"}</span></summary>
            <SafeMarkdown className="thinking-content" source={block.source} />
          </details>;
          if (block.kind === "tool") return <ToolBlock block={block} key={block.id} />;
          return <details className="flow-block activity-block" data-tone={block.tone} key={block.id}>
            <summary><span className="activity-icon" aria-hidden="true">◇</span><span className="flow-title">{block.title}</span><span className="flow-state">{block.label}</span></summary>
            {block.detail !== undefined && <pre className="activity-detail">{detailText(block.detail)}</pre>}
            {block.cancellable === true && block.queuedMessageId !== undefined && <button className="queued-cancel" type="button"
              aria-label="Cancel queued message" onClick={() => cancelQueued(block.queuedMessageId)}>取消排队消息</button>}
          </details>;
        })}
      </div>
      <div className="turn-actions">
        <button type="button" aria-label="复制回答" disabled={assistantText === ""}
          onClick={() => void navigator.clipboard.writeText(assistantText)}>▢</button>
        {terminalKind !== undefined && <span>{terminalKind}</span>}
        {props.turn.usage !== undefined && <span>{props.turn.usage.totalTokens.toLocaleString()} tokens</span>}
      </div>
    </div>
  </article>;
}

export function ConversationSurface(props: Readonly<{
  projection: RuntimeProjection | undefined;
  history: BrowserHistorySnapshot | undefined;
  localInputs: readonly LocalInput[];
  onCancelQueued: (messageId: string) => Promise<void>;
  onRespond: (response: InteractionResponse) => Promise<void>;
}>): React.JSX.Element {
  const scrollRoot = useRef<HTMLElement>(null);
  const followsOutput = useRef(true);
  const runtimeTurns = useMemo(() => foldRuntimeTurns(props.projection?.events ?? []), [props.projection?.events]);
  const restored = useMemo(() => runtimeTurns.length > 0 ? [] : historyTimeline(props.history?.events ?? []), [props.history?.events, runtimeTurns.length]);
  const timeline = useMemo<TimelineItem[]>(() => [
    ...restored,
    ...props.localInputs.map((input) => ({
      kind: "user" as const,
      id: input.id,
      at: input.createdAt,
      text: input.text,
      attachmentNames: input.attachmentNames,
      state: input.state,
    })),
    ...runtimeTurns.map((turn) => ({ kind: "turn" as const, id: turn.id, at: turn.at, turn })),
  ].sort((left, right) => left.at.localeCompare(right.at)), [props.localInputs, restored, runtimeTurns]);
  const latestRevision = props.projection?.events.at(-1)?.sequence
    ?? props.history?.durableSequence
    ?? props.localInputs.length;
  const interactions = props.projection?.openInteractions ?? [];
  const interactionRevision = `${interactions[0]?.interactionId ?? "none"}:${interactions.length}`;

  useEffect(() => {
    if (!followsOutput.current) return;
    const frame = requestAnimationFrame(() => {
      const root = scrollRoot.current;
      if (root !== null) root.scrollTop = root.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [interactionRevision, latestRevision]);

  if (timeline.length === 0 && interactions.length === 0) {
    return <section ref={scrollRoot} className="conversation empty-conversation" aria-label="Conversation">
      <div className="empty-mark" aria-hidden="true">✦</div>
      <h2>今天想一起做什么？</h2>
      <p>向 DSH Agent 提问，或让它检查、修改和验证当前工作区。</p>
    </section>;
  }
  return <section ref={scrollRoot} className="conversation" aria-label="Conversation" aria-live="off"
    onScroll={(event) => {
      const root = event.currentTarget;
      followsOutput.current = root.scrollHeight - root.scrollTop - root.clientHeight <= 80;
    }}>
    {runtimeTurns.length === 0 && props.history !== undefined && props.history.status !== "complete" && <div className="history-status" role="status">
      {props.history.status === "loading" && "正在恢复 DSH 持久会话…"}
      {props.history.status === "truncated" && "较早的会话内容未完全加载。"}
      {props.history.status === "failed" && "历史记录暂时无法加载，仍可继续当前对话。"}
    </div>}
    <div className="conversation-list">
      {timeline.map((item) => item.kind === "user"
        ? <article className="user-turn conversation-entry" key={item.id}>
            <div className="user-message">
              <p>{item.text}</p>
              {item.attachmentNames.length > 0 && <div className="attachment-chips">
                {item.attachmentNames.map((name) => <span key={name}>▧ {name}</span>)}
              </div>}
            </div>
            {item.state !== undefined && <span className={`delivery-state delivery-${item.state}`}>{item.state}</span>}
          </article>
        : <AssistantTurnView key={item.id} turn={item.turn} onCancelQueued={props.onCancelQueued} />)}
      {interactions[0] !== undefined && <ConversationInteractionCard
        interaction={interactions[0]}
        key={interactions[0].interactionId}
        waitingCount={interactions.length - 1}
        onRespond={props.onRespond}
      />}
    </div>
    <div className="sr-only" aria-live="polite">{runtimeTurns.length > 0 ? "Agent 回复已更新" : "对话已就绪"}</div>
  </section>;
}
