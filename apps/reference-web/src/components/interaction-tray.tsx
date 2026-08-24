import { useEffect, useRef, useState } from "react";

import type { InteractionResponse, OpenInteraction } from "@myagents-dsh/web-host-contract";

export function InteractionTray(props: Readonly<{
  interactions: readonly OpenInteraction[];
  onRespond: (response: InteractionResponse) => Promise<void>;
}>): React.JSX.Element | null {
  const interaction = props.interactions[0];
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setAnswer("");
    setError(undefined);
    const first = dialog.current?.querySelector<HTMLElement>("button, input, textarea");
    first?.focus();
    return () => restore?.focus();
  }, [interaction?.interactionId]);

  if (interaction === undefined) return null;
  const settle = async (decision: InteractionResponse["decision"]): Promise<void> => {
    setError(undefined);
    try {
      await props.onRespond({
        interactionId: interaction.interactionId,
        expectedRevision: interaction.desiredPolicyRevision,
        decision,
        ...(decision === "answered" ? { value: { answer } } : {}),
      });
    } catch {
      setError("This interaction is stale or could not be settled.");
    }
  };
  return <div className="interaction-backdrop">
    <div className="interaction-dialog" ref={dialog} role="dialog" aria-modal="true"
      aria-labelledby="interaction-title" onKeyDown={(event) => {
        if (event.key === "Escape") void settle("cancelled");
        if (event.key === "Tab") {
          const focusable = dialog.current === null ? [] : [...dialog.current.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
          )];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (first !== undefined && last !== undefined
            && ((!event.shiftKey && document.activeElement === last)
              || (event.shiftKey && document.activeElement === first))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }
      }}>
      <span className="eyebrow">Runtime request</span>
      <h2 id="interaction-title">{interaction.kind.replaceAll("_", " ")}</h2>
      {interaction.permissionAction !== undefined && <p className="interaction-action">{interaction.permissionAction}</p>}
      <pre className="interaction-schema">{JSON.stringify(interaction.schema, null, 2)}</pre>
      {interaction.kind === "ask_user" && <textarea
        aria-label="Answer"
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Type your answer"
        rows={3}
        value={answer}
      />}
      {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="ghost-button" type="button" onClick={() => void settle("deny")}>
          {interaction.kind === "permission" ? "Deny" : "Cancel"}
        </button>
        {interaction.kind === "permission" && <button className="ghost-button" type="button"
          onClick={() => void settle("always_allow")}>Always allow</button>}
        <button className="primary-button" type="button"
          disabled={interaction.kind === "ask_user" && answer.trim() === ""}
          onClick={() => void settle(interaction.kind === "ask_user" ? "answered" : "allow_once")}>
          {interaction.kind === "ask_user" ? "Submit answer" : "Allow once"}
        </button>
      </div>
      {props.interactions.length > 1 && <p className="dialog-queue">+{props.interactions.length - 1} waiting</p>}
    </div>
  </div>;
}
