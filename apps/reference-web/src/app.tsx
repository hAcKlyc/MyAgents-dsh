import { lazy, startTransition, Suspense, useEffect, useSyncExternalStore } from "react";

import { Composer } from "./components/composer.js";
import { ConversationSurface } from "./components/agent-surface.js";
import { InspectorPane } from "./components/inspector-pane.js";
import { SessionSidebar } from "./components/session-sidebar.js";
import type { ReferenceWebStore } from "./store.js";

const ControlCenter = lazy(async () => {
  const module = await import("./components/control-center.js");
  return { default: module.ControlCenter };
});

export function App(props: Readonly<{ store: ReferenceWebStore }>): React.JSX.Element {
  const state = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const selectedId = state.snapshot.selectedWebSessionId;
  const selected = state.snapshot.sessions.find(({ webSessionId }) => webSessionId === selectedId);
  const projection = state.snapshot.projection?.webSessionId === selectedId
    ? state.snapshot.projection : undefined;
  const busy = (projection?.activeOperationIds.length ?? 0) > 0;

  useEffect(() => {
    void props.store.start();
    return () => props.store.stop();
  }, [props.store]);
  useEffect(() => {
    if (state.connection === "online" && selectedId !== undefined && selected?.lifecycle === "ready"
      && state.controlInspection === undefined) void props.store.refreshControls().catch(() => undefined);
  }, [props.store, selectedId, selected?.lifecycle, state.connection, state.controlInspection]);

  return <div className="app-shell">
    <SessionSidebar
      workspaceName={state.bootstrap?.workspace.displayName ?? "MyAgents DSH"}
      workspaceRoot={state.bootstrap?.workspace.canonicalRoot ?? ""}
      sessions={state.snapshot.sessions}
      {...(selectedId === undefined ? {} : { selectedWebSessionId: selectedId })}
      onCreate={() => void props.store.createSession()}
      onSelect={(webSessionId) => void props.store.selectSession(webSessionId)}
    />
    <main className="workspace-main">
      <header className="workspace-header">
        <div className="workspace-identity">
          <span className="agent-mark" aria-hidden="true">ϟ</span>
          <strong>{state.bootstrap?.workspace.displayName ?? "MyAgents DSH"}</strong>
          <span className="header-slash">/</span>
          <h2>{selected?.title ?? "新对话"}</h2>
        </div>
        <div className="header-actions">
          <span className="connection-pill" data-state={state.connection}>
            <span className="status-dot" aria-hidden="true" />{state.connection}
          </span>
          <button className="header-button new-chat-button" type="button" onClick={() => void props.store.createSession()}>＋ 新对话</button>
          <button className="header-button" type="button" disabled={selectedId === undefined}
            onClick={() => startTransition(() => props.store.openControls("settings"))}
            aria-expanded={state.controlsOpen}>Controls</button>
          <button className="header-button" type="button" onClick={() => props.store.toggleInspector()}
            aria-expanded={state.inspectorOpen} aria-label="Runtime">Logs</button>
        </div>
      </header>
      <div className="workspace-content">
        <ConversationSurface projection={projection}
          history={state.history?.webSessionId === selectedId ? state.history : undefined}
          localInputs={state.localInputs.filter(({ webSessionId }) => webSessionId === selectedId)}
          onCancelQueued={(messageId) => selectedId === undefined
            ? Promise.resolve() : props.store.cancelQueued(selectedId, messageId)}
          onRespond={(response) => props.store.respond(response)} />
        <Composer
          attachments={projection?.attachments ?? []}
          attachmentDisabled={selectedId === undefined || selected?.lifecycle !== "ready"}
          inputDisabled={state.connection === "offline"}
          sendDisabled={state.connection !== "online"}
          busy={busy}
          permissionScope={selectedId}
          permissionMode={state.controlInspection?.controls.configuration.permissionMode as
            | "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | undefined}
          permissionDisabled={selectedId === undefined || selected?.lifecycle !== "ready"
            || state.connection !== "online" || state.controlInspection === undefined}
          onSubmit={(text, attachments, delivery) => props.store.submitInput(text, attachments, delivery)}
          onUpload={(file) => props.store.upload(file)}
          onPreview={(attachmentId) => props.store.previewAttachment(attachmentId)}
          onRelease={(attachmentId) => props.store.releaseAttachment(attachmentId)}
          onInterrupt={() => selectedId === undefined ? Promise.resolve() : props.store.interrupt(selectedId)}
          onPermissionModeChange={(permissionMode) => props.store.applyPermissionMode(permissionMode)}
        />
      </div>
    </main>
    {state.inspectorOpen && <InspectorPane
      session={selected}
      projection={projection}
      history={state.history?.webSessionId === selectedId ? state.history : undefined}
      trace={state.trace}
      onClose={() => props.store.toggleInspector()}
      onRestart={() => selectedId === undefined ? undefined : void props.store.restartRuntime(selectedId)}
      onColdStop={() => selectedId === undefined ? undefined : void props.store.coldStop(selectedId)}
    />}
    <Suspense fallback={<aside className="control-center control-loading" aria-label="Loading control center">正在加载控制中心…</aside>}>
      <ControlCenter
        open={state.controlsOpen}
        tab={state.controlTab}
        loading={state.controlsLoading}
        inspection={state.controlInspection}
        mutation={state.mutation}
        sessionTitle={selected?.title ?? "Session"}
        history={state.history?.webSessionId === selectedId ? state.history : undefined}
        onClose={() => props.store.closeControls()}
        onTab={(tab) => startTransition(() => props.store.selectControlTab(tab))}
        onRefresh={() => props.store.refreshControls()}
        onApplyConfiguration={(configuration) => props.store.applyConfiguration(configuration)}
        onReplaceComponents={(revision, components) => props.store.replaceComponents(revision, components)}
        onCompact={() => props.store.compactSession()}
        onPrepareMutation={(mutation, options) => props.store.prepareMutation(mutation, options)}
        onCommitMutation={(confirmation) => props.store.commitMutation(confirmation)}
        onRollbackMutation={() => props.store.rollbackMutation()}
        onPurge={(confirmation) => props.store.purgeDeletedSession(confirmation)}
      />
    </Suspense>
    <div className="notice-stack" aria-label="Notifications">
      {state.notices.map((notice) => <div className="notice" data-level={notice.level} key={notice.id} role="status">
        <span>{notice.message}</span>
        <button type="button" onClick={() => props.store.dismissNotice(notice.id)} aria-label="Dismiss notification">×</button>
      </div>)}
    </div>
  </div>;
}
