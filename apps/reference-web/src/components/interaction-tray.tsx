import { useState } from "react";

import type { InteractionResponse, OpenInteraction } from "@myagents-dsh/web-host-contract";

export function ConversationInteractionCard(props: Readonly<{
  interaction: OpenInteraction;
  waitingCount: number;
  onRespond: (response: InteractionResponse) => Promise<void>;
}>): React.JSX.Element | null {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const [settled, setSettled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const interaction = props.interaction;
  const settle = async (decision: InteractionResponse["decision"]): Promise<void> => {
    if (submitting) return;
    setError(undefined);
    setSubmitting(true);
    try {
      await props.onRespond({
        interactionId: interaction.interactionId,
        expectedRevision: interaction.desiredPolicyRevision,
        decision,
        ...(decision === "answered" ? { value: { answer } } : {}),
      });
      setSettled(true);
    } catch {
      setError("请求已失效或暂时无法处理，请重试。");
      setSubmitting(false);
    }
  };
  if (settled) return null;
  const title = interaction.kind === "permission"
    ? "需要你的允许"
    : interaction.kind === "plan_approval" ? "请确认执行计划" : "Agent 需要补充信息";
  return <article className="interaction-card conversation-entry" aria-labelledby={`interaction-title-${interaction.interactionId}`}>
    <div className="interaction-card-header">
      <span className="interaction-icon" aria-hidden="true">◇</span>
      <div>
        <span className="interaction-kicker">Runtime 请求</span>
        <h3 id={`interaction-title-${interaction.interactionId}`}>{title}</h3>
      </div>
    </div>
    {interaction.permissionAction !== undefined && <p className="interaction-action">{interaction.permissionAction}</p>}
    <details className="interaction-schema">
      <summary>查看请求详情</summary>
      <pre>{JSON.stringify(interaction.schema, null, 2)}</pre>
    </details>
      {interaction.kind === "ask_user" && <textarea
        aria-label="回答 Agent"
        disabled={submitting}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="输入你的回答"
        rows={3}
        value={answer}
      />}
      {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="ghost-button" disabled={submitting} type="button" onClick={() => void settle("deny")}>
          {interaction.kind === "permission" ? "拒绝" : "取消"}
        </button>
        {interaction.kind === "permission" && <button className="ghost-button" type="button"
          disabled={submitting} onClick={() => void settle("always_allow")}>总是允许</button>}
        <button className="primary-button" type="button"
          disabled={submitting || (interaction.kind === "ask_user" && answer.trim() === "")}
          onClick={() => void settle(interaction.kind === "ask_user" ? "answered" : "allow_once")}>
          {interaction.kind === "ask_user" ? "提交回答" : "仅允许一次"}
        </button>
      </div>
      {submitting && <p className="interaction-state" role="status">正在处理…</p>}
      {props.waitingCount > 0 && <p className="dialog-queue">另有 {props.waitingCount} 项等待处理</p>}
  </article>;
}
