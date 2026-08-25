import { useEffect, useMemo, useRef, useState } from "react";

import {
  type BrowserComponentDefinition,
  type SessionConfiguration,
} from "@myagents-dsh/web-host-contract";

import type { BrowserHistorySnapshot } from "../history.js";
import type {
  ControlInspection,
  ControlTab,
  MutationDraft,
} from "../store.js";

const componentKinds = ["skill", "mcp", "agent", "command", "hook", "host_tool"] as const;
const canonicalTools = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "ls", "WebFetch", "WebSearch",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Skill", "Agent", "TaskStop",
  "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
] as const;

const starterConfiguration = (kind: BrowserComponentDefinition["kind"]): unknown => {
  switch (kind) {
    case "skill": return {
      descriptor: {
        description: "A declarative workspace Skill",
        whenToUse: "When this workflow is relevant",
        invocation: { modelInvocable: true, userInvocable: true },
        rank: 50,
        resourceId: "new-skill-document",
      },
      resource: { content: "# New Skill\n\nDescribe the bounded workflow here." },
    };
    case "command": return {
      descriptor: { description: "A declarative command", resourceId: "new-command-template" },
      resource: { content: "Follow this command for $ARGUMENTS." },
    };
    case "agent": return { descriptor: { description: "A focused child Agent", prompt: "Complete the assigned bounded task.", maxTurns: 8 } };
    case "hook": return { descriptor: { event: "PreToolUse", matcher: "Write", originScope: ["root"], priority: 0, timeoutMs: 5_000, failurePolicy: "deny" } };
    case "mcp": return { descriptor: { transport: "http", url: "https://example.com/mcp" } };
    case "host_tool": return {
      descriptor: {
        serverId: "reference_host",
        toolName: "example_tool",
        description: "A build-registered Host tool",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    };
  }
};

const statusValue = (value: unknown): string => typeof value === "string" ? value : "unknown";

export function ControlCenter(props: Readonly<{
  open: boolean;
  tab: ControlTab;
  loading: boolean;
  inspection: ControlInspection | undefined;
  mutation: MutationDraft | undefined;
  sessionTitle: string;
  history: BrowserHistorySnapshot | undefined;
  onClose: () => void;
  onTab: (tab: ControlTab) => void;
  onRefresh: () => Promise<void>;
  onApplyConfiguration: (configuration: SessionConfiguration) => Promise<void>;
  onReplaceComponents: (revision: string, components: readonly BrowserComponentDefinition[]) => Promise<void>;
  onCompact: () => Promise<void>;
  onPrepareMutation: (
    mutation: MutationDraft["mutation"],
    options?: Readonly<{ boundaryId?: string; forkTitle?: string }>,
  ) => Promise<void>;
  onCommitMutation: (confirmation: string) => Promise<void>;
  onRollbackMutation: () => Promise<void>;
  onPurge: (confirmation: string) => Promise<void>;
}>): React.JSX.Element | null {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setWorking(true);
    setError(undefined);
    try { await operation(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation failed.");
    } finally { setWorking(false); }
  };
  if (!props.open) return null;
  const tabs: readonly Readonly<{ id: ControlTab; label: string }>[] = [
    { id: "settings", label: "模型与权限" },
    { id: "components", label: "组件" },
    { id: "session", label: "会话" },
    { id: "runtime", label: "Runtime" },
  ];
  return <aside className="control-center" aria-label="Session control center">
    <header className="control-header">
      <div><span className="eyebrow">Session controls</span><h2>控制中心</h2></div>
      <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭控制中心">×</button>
    </header>
    <nav className="control-tabs" aria-label="Control sections">
      {tabs.map((tab) => <button type="button" key={tab.id} data-selected={tab.id === props.tab}
        onClick={() => props.onTab(tab.id)}>{tab.label}</button>)}
    </nav>
    <div className="control-body" aria-busy={props.loading || working}>
      {(props.loading || props.inspection === undefined) && <div className="control-loading">正在读取 Runtime 权威状态…</div>}
      {props.inspection !== undefined && props.tab === "settings" && <SettingsPanel
        key={props.inspection.controls.configuration.revision}
        inspection={props.inspection} disabled={working}
        onApply={(configuration) => run(() => props.onApplyConfiguration(configuration))} />}
      {props.inspection !== undefined && props.tab === "components" && <ComponentsPanel
        key={props.inspection.controls.components.digest}
        inspection={props.inspection} disabled={working}
        onReplace={(revision, components) => run(() => props.onReplaceComponents(revision, components))} />}
      {props.inspection !== undefined && props.tab === "session" && <SessionPanel
        history={props.history} mutation={props.mutation} sessionTitle={props.sessionTitle} disabled={working}
        onCompact={() => run(props.onCompact)}
        onPrepare={(mutation, options) => run(() => props.onPrepareMutation(mutation, options))}
        onCommit={(confirmation) => run(() => props.onCommitMutation(confirmation))}
        onRollback={() => run(props.onRollbackMutation)}
        onPurge={(confirmation) => run(() => props.onPurge(confirmation))} />}
      {props.inspection !== undefined && props.tab === "runtime" && <RuntimePanel inspection={props.inspection}
        onRefresh={() => run(props.onRefresh)} disabled={working} />}
      {error !== undefined && <p className="control-error" role="alert">{error}</p>}
    </div>
  </aside>;
}

function SettingsPanel(props: Readonly<{
  inspection: ControlInspection;
  disabled: boolean;
  onApply: (configuration: SessionConfiguration) => Promise<void>;
}>): React.JSX.Element {
  const current = props.inspection.controls.configuration;
  const [effort, setEffort] = useState(current.reasoningEffort ?? "high");
  const [permissionMode, setPermissionMode] = useState(current.permissionMode);
  const [scenario, setScenario] = useState(current.interactionScenario);
  const [systemPrompt, setSystemPrompt] = useState(current.systemPrompt);
  const [autoAllow, setAutoAllow] = useState<readonly string[]>(current.visibleTools ?? []);
  const toggleTool = (tool: string): void => setAutoAllow((tools) => tools.includes(tool)
    ? tools.filter((candidate) => candidate !== tool) : [...tools, tool]);
  return <section className="control-section">
    <div className="control-section-heading"><div><h3>模型执行</h3><p>配置在下一轮生效；密钥仍只由 Host 反向端口提供。</p></div>
      <span className="revision-chip">{current.revision}</span></div>
    <label className="field"><span>模型</span><select value={current.modelId} disabled><option>{current.modelId}</option></select>
      <small>Reference Host 当前只安装已验证的 DeepSeek 路由。</small></label>
    <label className="field"><span>推理强度</span><select value={effort} onChange={(event) => setEffort(event.target.value as typeof effort)}>
      {(["low", "medium", "high", "xhigh", "max"] as const).map((value) => <option key={value}>{value}</option>)}
    </select></label>
    <label className="field"><span>权限模式</span><select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value)}>
      <option value="default">默认 · 按需询问</option><option value="acceptEdits">自动接受编辑</option>
      <option value="dontAsk">不主动询问</option><option value="bypassPermissions">绕过交互权限</option>
    </select></label>
    <label className="field"><span>交互场景版本</span><input value={scenario} onChange={(event) => setScenario(event.target.value)} /></label>
    <label className="field"><span>System prompt</span><textarea rows={7} value={systemPrompt}
      onChange={(event) => setSystemPrompt(event.target.value)} /></label>
    <fieldset className="tool-policy"><legend>无需逐次询问的工具</legend><p>全部 20 个 Runtime 工具保持可见；这里仅配置自动允许集合。</p>
      <div>{canonicalTools.map((tool) => <label key={tool}><input type="checkbox" checked={autoAllow.includes(tool)}
        onChange={() => toggleTool(tool)} />{tool}</label>)}</div></fieldset>
    <button className="primary-control" type="button" disabled={props.disabled || systemPrompt.length > 1_000_000}
      onClick={() => void props.onApply({
        revision: `reference-web-config-${Date.now()}`,
        providerRouteId: current.providerRouteId,
        modelId: current.modelId,
        reasoningEffort: effort,
        permissionMode,
        interactionScenario: scenario,
        systemPrompt,
        ...(autoAllow.length === 0 ? {} : { visibleTools: [...autoAllow] }),
      })}>应用到当前 Session</button>
  </section>;
}

function ComponentsPanel(props: Readonly<{
  inspection: ControlInspection;
  disabled: boolean;
  onReplace: (revision: string, components: readonly BrowserComponentDefinition[]) => Promise<void>;
}>): React.JSX.Element {
  const initial = props.inspection.controls.components.components;
  const [components, setComponents] = useState<readonly BrowserComponentDefinition[]>(initial);
  const [selectedId, setSelectedId] = useState(initial[0]?.id ?? "");
  const selected = components.find(({ id }) => id === selectedId);
  const [draft, setDraft] = useState(selected === undefined ? "" : JSON.stringify(selected.configuration, null, 2));
  const [jsonError, setJsonError] = useState<string>();
  const select = (component: BrowserComponentDefinition): void => {
    setSelectedId(component.id);
    setDraft(JSON.stringify(component.configuration, null, 2));
    setJsonError(undefined);
  };
  const componentsWithDraft = (): readonly BrowserComponentDefinition[] | undefined => {
    if (selected === undefined) return components;
    try {
      const parsed = JSON.parse(draft) as unknown;
      const next = components.map((item) => item.id === selected.id
        ? { ...item, configuration: parsed as never }
        : item);
      setComponents(next);
      setJsonError(undefined);
      return next;
    } catch {
      setJsonError("配置必须是有效 JSON。");
      return undefined;
    }
  };
  const add = (kind: BrowserComponentDefinition["kind"]): void => {
    let index = 1;
    while (components.some(({ id }) => id === `new-${kind}-${index}`)) index += 1;
    const next = { id: `new-${kind}-${index}`, kind, enabled: true, configuration: starterConfiguration(kind) as never };
    setComponents((items) => [...items, next]);
    select(next);
  };
  return <section className="control-section components-panel">
    <div className="control-section-heading"><div><h3>声明式组件</h3><p>整代校验、准备并原子替换；不安装浏览器 JavaScript。</p></div>
      <span className="revision-chip">{props.inspection.controls.components.digest.slice(0, 10)}</span></div>
    <div className="component-health">
      <span><strong>{props.inspection.catalog.tools.length}</strong> 工具</span>
      <span><strong>{props.inspection.catalog.skills.length}</strong> Skills</span>
      <span><strong>{props.inspection.catalog.agents.length}</strong> Agents</span>
      <span><strong>{props.inspection.catalog.mcpServers.length}</strong> MCP</span>
    </div>
    <div className="component-workbench">
      <div className="component-list">
        {components.map((component) => <button type="button" key={component.id} data-selected={component.id === selectedId}
          onClick={() => select(component)}><span>{component.id}</span><small>{component.kind} · {component.enabled ? "启用" : "停用"}</small></button>)}
        <label className="component-add"><span>添加组件</span><select defaultValue="" onChange={(event) => {
          if (event.target.value !== "") add(event.target.value as BrowserComponentDefinition["kind"]);
          event.target.value = "";
        }}><option value="" disabled>选择类型…</option>{componentKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      </div>
      {selected !== undefined && <div className="component-editor">
        <div className="component-editor-bar"><label><input type="checkbox" checked={selected.enabled} onChange={() => setComponents((items) =>
          items.map((item) => item.id === selected.id ? { ...item, enabled: !item.enabled } : item))} />启用</label>
          <button type="button" onClick={() => {
            setComponents((items) => items.filter(({ id }) => id !== selected.id)); setSelectedId("");
          }}>移除</button></div>
        <label className="field"><span>{selected.kind} 配置</span><textarea className="json-editor" rows={18} value={draft}
          spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={() => componentsWithDraft()} /></label>
        {jsonError !== undefined && <p className="control-error">{jsonError}</p>}
      </div>}
    </div>
    <button className="primary-control" type="button" disabled={props.disabled || jsonError !== undefined}
      onClick={() => {
        const next = componentsWithDraft();
        if (next !== undefined) void props.onReplace(`reference-web-components-${Date.now()}`, next);
      }}>
      校验并替换组件代次</button>
  </section>;
}

function SessionPanel(props: Readonly<{
  history: BrowserHistorySnapshot | undefined;
  mutation: MutationDraft | undefined;
  sessionTitle: string;
  disabled: boolean;
  onCompact: () => Promise<void>;
  onPrepare: (mutation: MutationDraft["mutation"], options?: Readonly<{ boundaryId?: string; forkTitle?: string }>) => Promise<void>;
  onCommit: (confirmation: string) => Promise<void>;
  onRollback: () => Promise<void>;
  onPurge: (confirmation: string) => Promise<void>;
}>): React.JSX.Element {
  const boundaries = props.history?.mutationBoundaries ?? [];
  const [boundaryId, setBoundaryId] = useState(boundaries.at(-1)?.stableBoundaryId ?? "");
  const [forkTitle, setForkTitle] = useState(`${props.sessionTitle} · Fork`);
  const [confirmation, setConfirmation] = useState("");
  const confirmationRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousMutationToken = useRef<string | undefined>(undefined);
  useEffect(() => {
    const token = props.mutation?.token;
    if (token === previousMutationToken.current) return;
    if (token === undefined) {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    } else {
      setConfirmation("");
      confirmationRef.current?.focus();
    }
    previousMutationToken.current = token;
  }, [props.mutation?.token]);
  const prepare = (
    event: React.MouseEvent<HTMLButtonElement>,
    mutation: MutationDraft["mutation"],
    options?: Readonly<{ boundaryId?: string; forkTitle?: string }>,
  ): void => {
    returnFocusRef.current = event.currentTarget;
    void props.onPrepare(mutation, options);
  };
  const trapDialogFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      void props.onRollback();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const expected = props.mutation?.mutation === "delete"
    ? props.mutation.state === "committed" ? `PURGE ${props.sessionTitle}` : `DELETE ${props.sessionTitle}`
    : props.mutation?.mutation === "fork" ? "FORK" : "REWIND";
  return <section className="control-section">
    <div className="control-section-heading"><div><h3>持久会话</h3><p>DSH 是唯一 transcript 权威；以下操作直接作用于持久 Session。</p></div>
      <span className="revision-chip">{props.history?.durableSequence ?? 0} events</span></div>
    <article className="session-operation"><div><h4>压缩上下文</h4><p>请求 Runtime 在空闲边界执行 durable compaction。</p></div>
      <button type="button" disabled={props.disabled} onClick={() => void props.onCompact()}>Compact</button></article>
    <label className="field"><span>稳定边界</span><select value={boundaryId} onChange={(event) => setBoundaryId(event.target.value)}>
      {boundaries.length === 0 && <option value="">尚无稳定边界</option>}
      {boundaries.map((boundary) => <option key={boundary.stableBoundaryId} value={boundary.stableBoundaryId}>
        Turn {boundary.turn} · event {boundary.sequence}</option>)}
    </select></label>
    <article className="session-operation"><div><h4>Fork</h4><p>在所选稳定边界创建独立 Runtime home 与 Session。</p>
      <input value={forkTitle} onChange={(event) => setForkTitle(event.target.value)} aria-label="Fork Session title" /></div>
      <button type="button" disabled={props.disabled || boundaryId === ""}
        onClick={(event) => prepare(event, "fork", { boundaryId, forkTitle })}>Prepare</button></article>
    <article className="session-operation danger-soft"><div><h4>Rewind</h4><p>切换到所选不可变前缀；可使用同一 token 回滚。</p></div>
      <button type="button" disabled={props.disabled || boundaryId === ""}
        onClick={(event) => prepare(event, "rewind", { boundaryId })}>Prepare</button></article>
    <article className="session-operation danger"><div><h4>删除 Session</h4><p>先 tombstone；确认后仍可回滚，物理 purge 不可恢复。</p></div>
      <button type="button" disabled={props.disabled} onClick={(event) => prepare(event, "delete")}>Prepare</button></article>
    {props.mutation !== undefined && <div className="mutation-confirm" role="dialog" aria-modal="true"
      aria-labelledby="mutation-title" onKeyDown={trapDialogFocus}>
      <h4 id="mutation-title">确认 {props.mutation.mutation}</h4>
      <p>Runtime 已准备 token <code>{props.mutation.token.slice(0, 16)}…</code>，当前状态：{props.mutation.state}。</p>
      <p>输入 <strong>{expected}</strong> 执行下一步。</p>
      <input ref={confirmationRef} aria-label="Mutation confirmation" value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)} />
      <div><button type="button" onClick={() => void props.onRollback()}>回滚 / Abort</button>
        {props.mutation.mutation === "delete" && props.mutation.state === "committed"
          ? <button className="danger-button" type="button" disabled={confirmation !== expected}
              onClick={() => void props.onPurge(confirmation)}>永久 Purge</button>
          : <button className="danger-button" type="button" disabled={confirmation !== expected}
              onClick={() => void props.onCommit(confirmation)}>确认执行</button>}</div>
    </div>}
  </section>;
}

function RuntimePanel(props: Readonly<{
  inspection: ControlInspection;
  onRefresh: () => Promise<void>;
  disabled: boolean;
}>): React.JSX.Element {
  const runtimeFacts = useMemo(() => Object.entries(props.inspection.runtime), [props.inspection.runtime]);
  return <section className="control-section">
    <div className="control-section-heading"><div><h3>Runtime 权威状态</h3><p>状态来自当前 Session 的原生 RPC，不读取浏览器推断。</p></div>
      <button type="button" disabled={props.disabled} onClick={() => void props.onRefresh()}>刷新</button></div>
    <dl className="runtime-facts">{runtimeFacts.map(([key, value]) => <div key={key}><dt>{key}</dt>
      <dd>{typeof value === "object" ? JSON.stringify(value) : statusValue(value)}</dd></div>)}</dl>
    <h4>组件应用状态</h4><pre className="runtime-json">{JSON.stringify(props.inspection.status, null, 2)}</pre>
  </section>;
}
