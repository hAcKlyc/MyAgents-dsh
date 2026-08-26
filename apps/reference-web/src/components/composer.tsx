import { useEffect, useRef, useState } from "react";

import type { AttachmentSummary, BrowserAttachmentPreview } from "@myagents-dsh/web-host-contract";

import type {
  ConfigurationApplyOutcome,
  InputDelivery,
  ReferencePermissionMode,
} from "../store.js";

const permissionOptions: readonly Readonly<{ value: ReferencePermissionMode; label: string }>[] = [
  { value: "default", label: "按需询问" },
  { value: "acceptEdits", label: "自动允许编辑" },
  { value: "dontAsk", label: "拒绝且不询问" },
  { value: "bypassPermissions", label: "完全访问" },
];

export function Composer(props: Readonly<{
  attachmentDisabled: boolean;
  inputDisabled: boolean;
  sendDisabled: boolean;
  busy: boolean;
  permissionScope: string | undefined;
  permissionMode: ReferencePermissionMode | undefined;
  permissionDisabled: boolean;
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
  onPermissionModeChange: (permissionMode: ReferencePermissionMode) => Promise<ConfigurationApplyOutcome>;
}>): React.JSX.Element {
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<readonly AttachmentSummary[]>([]);
  const [busyDelivery, setBusyDelivery] = useState<Extract<InputDelivery, "steer" | "follow_up">>("follow_up");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [permissionState, setPermissionState] = useState<"idle" | "saving" | "applied" | "queued">("idle");
  const [selectedPermission, setSelectedPermission] = useState<ReferencePermissionMode | undefined>(props.permissionMode);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [preview, setPreview] = useState<Readonly<{ name: string; url: string }>>();
  const fileRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const steerHasAttachments = props.busy && busyDelivery === "steer" && uploads.length > 0;

  useEffect(() => () => {
    if (preview !== undefined) URL.revokeObjectURL(preview.url);
  }, [preview]);
  useEffect(() => {
    setSelectedPermission(props.permissionMode);
  }, [props.permissionMode]);
  useEffect(() => {
    setSelectedPermission(props.permissionMode);
    setPermissionState("idle");
  }, [props.permissionScope]);
  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !addMenuRef.current?.contains(event.target)) setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [addMenuOpen]);

  const submit = async (): Promise<void> => {
    if (props.sendDisabled || submitting || text.trim() === "") return;
    setError(undefined);
    setSubmitting(true);
    try {
      await props.onSubmit(text, uploads, props.busy ? busyDelivery : "turn");
      setText("");
      setUploads([]);
    } catch {
      setError("The message could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };
  const addFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    setError(undefined);
    try {
      const attachments: AttachmentSummary[] = [];
      for (const file of Array.from(files)) attachments.push(await props.onUpload(file));
      setUploads((current) => [...current, ...attachments]);
    } catch {
      setError("图片未能上传；请检查格式、大小或 Host 日志。");
    } finally {
      if (fileRef.current !== null) fileRef.current.value = "";
    }
  };
  const changePermission = async (permissionMode: ReferencePermissionMode): Promise<void> => {
    const previous = props.permissionMode;
    setSelectedPermission(permissionMode);
    setPermissionState("saving");
    setError(undefined);
    try {
      const outcome = await props.onPermissionModeChange(permissionMode);
      setPermissionState(outcome.state === "applied" ? "applied" : "queued");
    } catch {
      setSelectedPermission(previous);
      setPermissionState("idle");
      setError("权限模式未能应用；当前设置没有改变。");
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
    <div className="composer" data-disabled={props.inputDisabled} aria-busy={submitting}>
      <textarea
        aria-label="Message the agent"
        autoFocus
        disabled={props.inputDisabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="输入消息，使用 @ 引用文件，/ 使用技能…"
        rows={3}
        value={text}
      />
      <div className="composer-actions">
        <div>
          <div className="composer-add" ref={addMenuRef}>
            <button className="attach-button" type="button"
              disabled={props.attachmentDisabled || (props.busy && busyDelivery === "steer")}
              onClick={() => setAddMenuOpen((open) => !open)} aria-label="Add content"
              aria-expanded={addMenuOpen} aria-haspopup="menu" title="添加内容">＋</button>
            {addMenuOpen && <div className="composer-add-menu" role="menu" aria-label="添加内容">
              <button type="button" role="menuitem" onClick={() => {
                setAddMenuOpen(false);
                fileRef.current?.click();
              }}><span className="menu-icon">▧</span><span><strong>添加图片</strong><small>PNG、JPG、GIF 或 WebP</small></span></button>
              <p>图片由 Host 临时托管，只在当前 Session 中可用。</p>
            </div>}
          </div>
          <input ref={fileRef} className="sr-only" type="file" aria-label="Upload attachment"
            accept="image/jpeg,image/png,image/gif,image/webp" multiple
            onChange={(event) => void addFiles(event.target.files)} tabIndex={-1} />
          {props.busy && <select aria-label="Delivery mode" value={busyDelivery}
            onChange={(event) => setBusyDelivery(event.target.value as typeof busyDelivery)}>
            <option value="steer">立即补充</option>
            <option value="follow_up">排队发送</option>
          </select>}
          <label className="permission-control" title={selectedPermission === "bypassPermissions"
            ? "完全访问会绕过交互式权限确认，Runtime 硬策略仍然有效。" : "设置当前 Session 的工具权限策略。"}>
            <span>权限</span>
            <select aria-label="Permission mode" data-danger={selectedPermission === "bypassPermissions"}
              disabled={props.permissionDisabled || permissionState === "saving"}
              value={selectedPermission ?? ""} onChange={(event) => void changePermission(
                event.target.value as ReferencePermissionMode,
              )}>
              {selectedPermission === undefined && <option value="">读取中…</option>}
              {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {permissionState !== "idle" && <small className="permission-state" role="status">{
              permissionState === "saving" ? "应用中…" : permissionState === "applied" ? "已生效" : "已排队"
            }</small>}
          </label>
          <span className="composer-hint">↵ 发送 · ⇧↵ 换行</span>
        </div>
        <div>
          {props.busy && <button className="stop-button" type="button" aria-label="Stop"
            onClick={() => void props.onInterrupt()}>停止</button>}
          <button className="send-button" type="button"
            disabled={props.sendDisabled || submitting || text.trim() === "" || steerHasAttachments}
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
