import type { RuntimeProjection, WebSessionSummary } from "@myagents-dsh/web-host-contract";

import type { BrowserHistorySnapshot } from "../history.js";
import type { HostTraceEntry } from "../store.js";

export function InspectorPane(props: Readonly<{
  session: WebSessionSummary | undefined;
  projection: RuntimeProjection | undefined;
  history: BrowserHistorySnapshot | undefined;
  trace: readonly HostTraceEntry[];
  onClose: () => void;
  onRestart: () => void;
  onColdStop: () => void;
}>): React.JSX.Element {
  return <aside className="inspector" aria-label="Runtime inspector">
    <div className="inspector-heading">
      <div><span className="eyebrow">Inspector</span><h2>Runtime</h2></div>
      <button className="icon-button" type="button" onClick={props.onClose} aria-label="Close inspector">×</button>
    </div>
    <section className="inspector-section">
      <h3>Session state</h3>
      <dl className="fact-grid">
        <div><dt>Lifecycle</dt><dd>{props.session?.lifecycle ?? "none"}</dd></div>
        <div><dt>Runtime Session</dt><dd>{props.projection?.runtimeSessionId ?? "not bound"}</dd></div>
        <div><dt>Generation</dt><dd>{props.projection?.runtimeGeneration ?? "cold"}</dd></div>
        <div><dt>Visible events</dt><dd>{props.projection?.events.length ?? 0}</dd></div>
        <div><dt>Durable history</dt><dd>{props.history === undefined
          ? "not loaded" : `${props.history.events.length} / ${props.history.durableSequence} · ${props.history.status}`}</dd></div>
      </dl>
      {props.session !== undefined && <div className="inspector-actions">
        <button className="ghost-button" type="button" onClick={props.onRestart}>Restart</button>
        <button className="ghost-button" type="button" onClick={props.onColdStop}>Cold stop</button>
      </div>}
    </section>
    <section className="inspector-section">
      <h3>Diagnostics</h3>
      {props.projection?.diagnostics.length
        ? <ul className="diagnostic-list">{props.projection.diagnostics.map((diagnostic, index) =>
            <li key={`${diagnostic.code}:${index}`} data-level={diagnostic.level}>
              <strong>{diagnostic.code}</strong><span>{diagnostic.message}</span>
            </li>)}</ul>
        : <p className="muted-copy">No Runtime diagnostics.</p>}
    </section>
    <section className="inspector-section">
      <h3>Host resources</h3>
      <p className="metric-line"><span>Open interactions</span><strong>{props.projection?.openInteractions.length ?? 0}</strong></p>
      <p className="metric-line"><span>Attachments</span><strong>{props.projection?.attachments.length ?? 0}</strong></p>
      <p className="metric-line"><span>Active operations</span><strong>{props.projection?.activeOperationIds.length ?? 0}</strong></p>
    </section>
    <section className="inspector-section">
      <h3>Event trace</h3>
      {props.trace.length === 0
        ? <p className="muted-copy">No Host events received.</p>
        : <ol className="trace-list">{[...props.trace].reverse().map((entry) => <li key={entry.id}>
            <time dateTime={entry.emittedAt}>{entry.emittedAt.slice(11, 23)}</time>
            <strong>{entry.kind}{entry.count > 1 ? ` ×${entry.count}` : ""}</strong>
            <span>{entry.detail}</span>
          </li>)}</ol>}
    </section>
  </aside>;
}
