import type { WebSessionSummary } from "@myagents-dsh/web-host-contract";

export function SessionSidebar(props: Readonly<{
  sessions: readonly WebSessionSummary[];
  selectedWebSessionId?: string;
  onCreate: () => void;
  onSelect: (webSessionId: string) => void;
}>): React.JSX.Element {
  return <aside className="session-sidebar" aria-label="Sessions">
    <div className="sidebar-heading">
      <div>
        <span className="eyebrow">Workspace</span>
        <h1>Sessions</h1>
      </div>
      <button className="icon-button" type="button" onClick={props.onCreate} aria-label="Create Session">+</button>
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
              {session.lifecycle.replaceAll("_", " ")}
            </span>
          </button>)}
    </nav>
    <div className="sidebar-footnote">
      <span className="status-dot status-ready" aria-hidden="true" />
      One verified Runtime per active Session
    </div>
  </aside>;
}
