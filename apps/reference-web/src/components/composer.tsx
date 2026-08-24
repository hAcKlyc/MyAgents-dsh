import { useEffect, useRef, useState } from "react";

import type { AttachmentSummary, BrowserAttachmentPreview } from "@myagents-dsh/web-host-contract";

import type { InputDelivery } from "../store.js";

export function Composer(props: Readonly<{
  disabled: boolean;
  busy: boolean;
  attachments: readonly AttachmentSummary[];
  onSubmit: (
    text: string,
    attachments: readonly AttachmentSummary[],
    delivery: InputDelivery,
  ) => Promise<void>;
  onUpload: (file: File) => Promise<AttachmentSummary>;
  onPreview: (attachmentId: string) => Promise<BrowserAttachmentPreview>;
  onRelease: (attachmentId: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
}>): React.JSX.Element {
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<readonly AttachmentSummary[]>([]);
  const [busyDelivery, setBusyDelivery] = useState<Extract<InputDelivery, "steer" | "follow_up">>("steer");
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<Readonly<{ name: string; url: string }>>();
  const fileRef = useRef<HTMLInputElement>(null);
  const steerHasAttachments = props.busy && busyDelivery === "steer" && uploads.length > 0;

  useEffect(() => () => {
    if (preview !== undefined) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const submit = async (): Promise<void> => {
    if (text.trim() === "") return;
    setError(undefined);
    try {
      await props.onSubmit(text, uploads, props.busy ? busyDelivery : "turn");
      setText("");
      setUploads([]);
    } catch {
      setError("The message could not be submitted.");
    }
  };
  const addFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(undefined);
    try {
      const attachment = await props.onUpload(file);
      setUploads((current) => [...current, attachment]);
    } catch {
      setError("The attachment could not be uploaded.");
    } finally {
      if (fileRef.current !== null) fileRef.current.value = "";
    }
  };
  const remove = async (attachment: AttachmentSummary): Promise<void> => {
    try {
      await props.onRelease(attachment.attachmentId);
      setUploads((current) => current.filter(({ attachmentId }) => attachmentId !== attachment.attachmentId));
    } catch {
      setError("The attachment is still in use.");
    }
  };
  const openPreview = async (attachment: AttachmentSummary): Promise<void> => {
    setError(undefined);
    try {
      const resource = await props.onPreview(attachment.attachmentId);
      setPreview({ name: attachment.name, url: URL.createObjectURL(new Blob(
        [resource.bytes.slice().buffer], { type: resource.mimeType },
      )) });
    } catch {
      setError("The attachment preview could not be verified.");
    }
  };

  return <div className="composer-wrap">
    {uploads.length > 0 && <div className="composer-attachments" aria-label="Pending attachments">
      {uploads.map((attachment) => <span key={attachment.attachmentId}>
        {attachment.name} · {attachment.state}
        <button type="button" onClick={() => void openPreview(attachment)} aria-label={`Preview ${attachment.name}`}>⌕</button>
        <button type="button" onClick={() => void remove(attachment)} aria-label={`Remove ${attachment.name}`}>×</button>
      </span>)}
    </div>}
    <div className="composer" data-disabled={props.disabled}>
      <textarea
        aria-label="Message the agent"
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={props.disabled ? "Select or create a Session" : "Message the agent…"}
        rows={3}
        value={text}
      />
      <div className="composer-actions">
        <div>
          <button className="ghost-button" type="button" disabled={props.disabled || (props.busy && busyDelivery === "steer")}
            onClick={() => fileRef.current?.click()} aria-label="Attach file">＋ Attach</button>
          <input ref={fileRef} className="sr-only" type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={(event) => void addFile(event.target.files?.[0])} tabIndex={-1} />
          {props.busy && <select aria-label="Delivery mode" value={busyDelivery}
            onChange={(event) => setBusyDelivery(event.target.value as typeof busyDelivery)}>
            <option value="steer">Steer now</option>
            <option value="follow_up">Queue follow-up</option>
          </select>}
          <span className="composer-hint">↵ send · ⇧↵ newline</span>
        </div>
        <div>
          {props.busy && <button className="stop-button" type="button" onClick={() => void props.onInterrupt()}>Stop</button>}
          <button className="send-button" type="button"
            disabled={props.disabled || text.trim() === "" || steerHasAttachments}
            onClick={() => void submit()} aria-label={props.busy
              ? busyDelivery === "steer" ? "Send steering message" : "Queue follow-up"
              : "Send message"}>↑</button>
        </div>
      </div>
    </div>
    {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
    {props.attachments.length > 0 && <div className="composer-resource-note">
      <span>{props.attachments.length} Host-owned attachment{props.attachments.length === 1 ? "" : "s"} in this Session</span>
      {props.attachments.map((attachment) => <button type="button" key={attachment.attachmentId}
        onClick={() => void openPreview(attachment)}>{attachment.name} · {attachment.state}</button>)}
    </div>}
    {preview !== undefined && <div className="attachment-preview-backdrop" role="dialog" aria-modal="true"
      aria-label={`Preview ${preview.name}`}>
      <div className="attachment-preview">
        <div><strong>{preview.name}</strong><button type="button" aria-label="Close attachment preview"
          onClick={() => setPreview(undefined)}>×</button></div>
        <img src={preview.url} alt={preview.name} />
      </div>
    </div>}
  </div>;
}
