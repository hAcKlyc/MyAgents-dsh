import type { WebSessionSummary } from "@myagents-dsh/web-host-contract";

export function SessionSidebar(props: Readonly<{
  workspaceName: string;
  workspaceRoot: string;
  sessions: readonly WebSessionSummary[];
  selectedWebSessionId?: string;
  onCreate: () => void;
  onSelect: (webSessionId: string) => void;
}>): React.JSX.Element {
  return <aside className="session-sidebar" aria-label="Sessions">
    <div className="workspace-switcher-wrap">
      <span className="eyebrow">当前工作区</span>
      <button className="workspace-switcher" type="button" title={props.workspaceRoot} aria-label="Current workspace">
        <span className="workspace-glyph" aria-hidden="true">⌘</span>
        <span>{props.workspaceName}</span>
        <span className="workspace-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
    <div className="sidebar-heading">
      <h1>对话</h1>
      <button className="icon-button" type="button" onClick={props.onCreate} aria-label="Create Session">＋</button>
    </div>
    <nav className="session-list" aria-label="Agent Sessions">
      {props.sessions.length === 0
        ? <p className="empty-copy">Start a Session to work with the verified DSH Runtime.</p>
        : props.sessions.map((session) => <button
            className="session-item"
            data-selected={session.webSessionId === props.selectedWebSessionId}
            key={session.webSessionId}
            onClick={() => props.onSelect(session.webSessionId)}
            type="button"
          >
            <span className="session-title">{session.title}</span>
            <span className="session-meta">
              <span className={`status-dot status-${session.lifecycle}`} aria-hidden="true" />
              {session.lifecycle === "ready" ? "就绪" : session.lifecycle === "cold" ? "未启动" : session.lifecycle.replaceAll("_", " ")}
            </span>
          </button>)}
    </nav>
  </aside>;
}
