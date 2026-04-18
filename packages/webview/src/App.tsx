import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  boardBackground,
  codeSyncMode,
  driftByTarget,
  randomId,
  worstSeverity,
  type AskAiRequest,
  type BoardBackground,
  type BoardSettings,
  type CodeInfo,
  type CodeState,
  type CodeSyncMode,
  type HostToWebview,
  type Plan,
} from '@agentic-whiteboard/shared';
import { DEFAULT_SIZE, svgCanvasAdapter as adapter } from './canvas/adapter';
import {
  Canvas,
  type Camera,
  type CanvasHandle,
  type ShapeStyleState,
  type Tool,
} from './canvas/Canvas';
import { exportScope } from './canvas/export';
import { unionBoxes } from './canvas/geometry';
import { addElement } from './canvas/ops';
import type { Scene } from './canvas/types';
import { CodePanel } from './CodePanel';
import type { Host } from './host';
import { Inspector } from './Inspector';
import { ToolPalette, TopBar, ZoomControls } from './Toolbar';

type Status =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready' }
  | { kind: 'invalid'; errors: string[] };

interface SavedState {
  camera?: Camera;
}

function effectiveTheme(setting: BoardSettings['theme']): 'light' | 'dark' {
  if (setting !== 'auto') return setting;
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || cls.contains('vscode-high-contrast') ? 'dark' : 'light';
}

export function App({ host }: { host: Host }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [scene, setScene] = useState<Scene | undefined>();
  const [settings, setSettings] = useState<BoardSettings>({ theme: 'auto', sketch: true });
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // The properties panel opens only from the top bar, never just by selecting or dragging.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    if (selection.size === 0) setInspectorOpen(false);
  }, [selection]);
  const [code, setCode] = useState<CodeState | undefined>();
  const [codeInfo, setCodeInfo] = useState<ReadonlyMap<string, CodeInfo>>(new Map());
  const [busy, setBusy] = useState<string | undefined>();
  // An AI agent is changing the board: nothing on it can be edited until it finishes.
  const [agentWorking, setAgentWorking] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const codeSync = codeSyncMode({
    codeSync: scene?.meta.codeSync as CodeSyncMode | undefined,
  });
  // Off: a plain whiteboard. Drop drift right away, before the host's next check arrives.
  const drift = useMemo(
    () => driftByTarget(codeSync === 'off' ? [] : (code?.drift ?? [])),
    [code, codeSync],
  );
  // A new scan may change code facts; Properties asks again for what it shows (the scan time
  // is part of its request key), and the answer arrives after this reset.
  useEffect(() => setCodeInfo(new Map()), [code?.scannedAt]);
  const serious =
    codeSync === 'off' ? [] : (code?.drift ?? []).filter((d) => d.severity !== 'info');
  const [shapeStyle, setShapeStyle] = useState<ShapeStyleState>({
    color: 'default',
    fill: 'none',
    strokeWidth: 2,
  });
  const canvas = useRef<CanvasHandle>(null);
  // The dock is one to three rows tall depending on the width; panels must stay above it.
  const dockObserver = useRef<ResizeObserver | undefined>(undefined);
  const dockRef = useCallback((dock: HTMLDivElement | null) => {
    dockObserver.current?.disconnect();
    if (!dock) return;
    const main = dock.parentElement;
    const update = () => main?.style.setProperty('--pc-dock-h', `${dock.offsetHeight}px`);
    update();
    dockObserver.current = new ResizeObserver(update);
    dockObserver.current.observe(dock);
  }, []);
  const [zoom, setZoom] = useState(() => host.getState<SavedState>()?.camera?.z ?? 1);
  const onCameraChange = useCallback(
    (camera: Camera) => {
      setZoom(camera.z);
      host.setState({ ...host.getState<SavedState>(), camera });
    },
    [host],
  );
  const baseRevision = useRef(0);
  const sceneRef = useRef<Scene | undefined>(undefined);
  sceneRef.current = scene;
  const gestureActive = useRef(false);
  const deferredLoad = useRef<Plan | undefined>(undefined);
  const fitted = useRef(!!host.getState<SavedState>()?.camera);
  const relayoutRequested = useRef(new Set<number>());

  const applyPlan = useCallback(
    (plan: Plan) => {
      const prev = sceneRef.current;
      const next = adapter.toScene(plan);
      baseRevision.current = plan.revision;
      // Elements that arrived from outside (an AI drawing on the board): bring them into view.
      // The user's own additions are already in the scene before the host echoes them back.
      if (prev) {
        const known = new Set(prev.elements.map((e) => e.id));
        const box = unionBoxes(
          next.elements.filter((e) => !known.has(e.id) && (e.w > 0 || e.h > 0)),
        );
        if (box) requestAnimationFrame(() => canvas.current?.reveal(box));
      }
      setScene(next);
      setStatus({ kind: 'ready' });
      setSelection((sel) => {
        const ids = new Set([...next.elements.map((e) => e.id), ...next.edges.map((e) => e.id)]);
        const kept = new Set([...sel].filter((id) => ids.has(id)));
        return kept.size === sel.size ? sel : kept;
      });
      // Elements without a layout entry: ask the host to auto-layout them (once per revision).
      if (next.unplaced.length && !relayoutRequested.current.has(plan.revision)) {
        relayoutRequested.current.add(plan.revision);
        host.post({ type: 'relayout', force: false });
      }
    },
    [host],
  );

  useEffect(() => {
    const off = host.onMessage((msg: HostToWebview) => {
      switch (msg.type) {
        case 'load':
          setSettings(msg.settings);
          // Never yank the scene out from under an active drag or text edit.
          if (gestureActive.current) deferredLoad.current = msg.plan;
          else applyPlan(msg.plan);
          break;
        case 'invalid':
          setSettings(msg.settings);
          setStatus({ kind: 'invalid', errors: msg.errors });
          break;
        case 'empty':
          setSettings(msg.settings);
          setStatus({ kind: 'empty' });
          break;
        case 'settings':
          setSettings(msg.settings);
          break;
        case 'requestExport':
          void doExport(msg.format);
          break;
        case 'code':
          setCode(msg.state);
          break;
        case 'codeInfo':
          setCodeInfo((m) => new Map(m).set(msg.nodeId, msg.info));
          break;
        case 'busy':
          setBusy(msg.task);
          if (msg.task) setCodeOpen(true);
          break;
        case 'agent':
          setAgentWorking(msg.working);
          break;
      }
    });
    host.post({ type: 'ready' });
    return off;
  }, [host, applyPlan]);

  // Theme: the board's own background if it has one, else follow VS Code unless overridden.
  const background = scene ? boardBackground(scene.meta) : undefined;
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => (root.dataset.theme = background?.tone ?? effectiveTheme(settings.theme));
    apply();
    if (background) root.style.setProperty('--pc-bg', background.color);
    else root.style.removeProperty('--pc-bg');
    const mo = new MutationObserver(apply);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [settings.theme, background?.tone, background?.color]);

  // Fit the board to the view the first time a plan arrives.
  useEffect(() => {
    if (scene && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(() => canvas.current?.fit());
    }
  }, [scene]);

  const commit = useCallback(
    (next: Scene, immediate = false) => {
      deferredLoad.current = undefined; // The host will answer with the merged result.
      host.post({
        type: 'edit',
        plan: adapter.fromScene(next),
        baseRevision: baseRevision.current,
        immediate,
      });
    },
    [host],
  );

  const onChange = useCallback(
    (next: Scene, isCommit: boolean) => {
      setScene(next);
      if (isCommit) commit(next);
    },
    [commit],
  );

  const onGestureChange = useCallback(
    (active: boolean) => {
      gestureActive.current = active;
      if (!active) {
        // If the gesture ended without a commit, catch up with whatever arrived meanwhile.
        setTimeout(() => {
          const pending = deferredLoad.current;
          if (pending && !gestureActive.current) {
            deferredLoad.current = undefined;
            applyPlan(pending);
          }
        }, 0);
      }
    },
    [applyPlan],
  );

  const setMeta = (patch: Partial<Scene['meta']>, immediate = true) => {
    const s = sceneRef.current;
    if (!s) return;
    const next: Scene = { ...s, meta: { ...s.meta, ...patch } };
    setScene(next);
    commit(next, immediate);
  };

  const addSticky = (kind: 'constraint' | 'comment', text: string, near?: string) => {
    const s = sceneRef.current;
    if (!s) return { scene: s, id: '' };
    const id = randomId(kind === 'constraint' ? 'k' : 'c');
    const size = DEFAULT_SIZE[kind];
    const target = near ? s.elements.find((e) => e.id === near) : undefined;
    const c = canvas.current?.viewportCenter() ?? { x: 0, y: 0 };
    const pos = target
      ? { x: target.x + target.w + 24, y: target.y - 10 }
      : { x: c.x - size.w / 2, y: c.y - size.h / 2 };
    const el =
      kind === 'constraint'
        ? { id, kind, data: { id, text, author: 'user' as const }, ...pos, ...size }
        : {
            id,
            kind,
            data: {
              id,
              text,
              ...(target && (target.kind === 'node' || target.kind === 'step')
                ? { attachedTo: target.id }
                : {}),
            },
            ...pos,
            ...size,
          };
    return { scene: addElement(s, el as Scene['elements'][number]), id };
  };

  const onAddNote = () => {
    const { scene: next, id } = addSticky('comment', '');
    if (!next) return;
    setScene(next);
    setSelection(new Set([id]));
    requestAnimationFrame(() => canvas.current?.edit(id, true));
  };

  const requestCodeInfo = useCallback(
    (nodeId: string) => host.post({ type: 'codeInfo', nodeId }),
    [host],
  );
  const askAi = (request: AskAiRequest, ids: string[]) =>
    host.post({ type: 'askAi', request, ids });

  /** Selects a box or arrow from the drift list and scrolls it into view. */
  const selectAndReveal = (id: string) => {
    const s = sceneRef.current;
    if (!s) return;
    const edge = s.edges.find((e) => e.id === id);
    const targets = edge ? [edge.from, edge.to] : [id];
    const box = unionBoxes(s.elements.filter((e) => targets.includes(e.id)));
    setSelection(new Set([id]));
    if (box) canvas.current?.reveal(box);
  };

  /** Exports the selection when there is one, otherwise the whole board. */
  async function doExport(format: 'png' | 'svg') {
    const svg = canvas.current?.svg();
    const full = sceneRef.current;
    if (!svg || !full) return;
    const sel = selectionRef.current;
    const s = sel.size ? exportScope(full, sel) : full;
    const selection = s !== full;
    try {
      if (format === 'svg')
        host.post({
          type: 'export',
          format,
          data: adapter.exportSvg(svg, s),
          encoding: 'utf8',
          selection,
        });
      else
        host.post({
          type: 'export',
          format,
          data: await adapter.exportPng(svg, s),
          encoding: 'base64',
          selection,
        });
    } catch (err) {
      host.post({
        type: 'error',
        message: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (
    status.kind === 'loading' ||
    (status.kind !== 'invalid' && !scene && status.kind !== 'empty')
  ) {
    return <div className="pc-center pc-muted">Loading board…</div>;
  }
  if (status.kind === 'empty' && !scene) {
    return <div className="pc-center pc-muted">Opening whiteboard…</div>;
  }

  const invalid = status.kind === 'invalid';
  const readOnly = invalid || agentWorking;
  const meta = scene?.meta;

  return (
    <div className="pc-app">
      {meta && (
        <TopBar
          title={meta.title}
          readOnly={readOnly}
          onRename={(title) => setMeta({ title }, false)}
          onRelayout={() => host.post({ type: 'relayout', force: true })}
          onAddNote={onAddNote}
          background={background?.id}
          onBackground={(id: BoardBackground | undefined) => setMeta({ background: id }, false)}
          canInspect={selection.size > 0}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((o) => !o)}
          onExport={(f) => void doExport(f)}
          selectionCount={selection.size}
          onUndo={() => host.post({ type: 'undo' })}
          onRedo={() => host.post({ type: 'redo' })}
          codeOpen={codeOpen}
          codeSync={codeSync}
          onToggleCode={() => setCodeOpen((o) => !o)}
          driftCount={serious.length}
          driftSeverity={worstSeverity(serious)}
        />
      )}
      {agentWorking && !invalid && (
        <div className="pc-banner pc-banner-agent" role="status">
          <span className="pc-spinner" aria-hidden="true" />
          <span>
            <strong>Your AI is changing this board.</strong> It unlocks when the AI finishes.
          </span>
          <button className="pc-btn pc-btn-small" onClick={() => host.post({ type: 'takeOver' })}>
            Take over
          </button>
        </div>
      )}
      {status.kind === 'invalid' && (
        <div className="pc-banner" role="alert">
          <strong>This whiteboard file is not valid, so the board is read-only.</strong> Your file
          has not been changed.
          <ul>
            {status.errors.slice(0, 5).map((e, i) => (
              <li key={i}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
          <button className="pc-btn pc-btn-small" onClick={() => host.post({ type: 'openAsText' })}>
            Open as JSON to fix it
          </button>
        </div>
      )}
      <main className="pc-main">
        {scene && (
          <Canvas
            ref={canvas}
            scene={scene}
            sketch={settings.sketch}
            readOnly={readOnly}
            tool={tool}
            onToolChange={setTool}
            selection={selection}
            onSelectionChange={setSelection}
            onChange={onChange}
            onGestureChange={onGestureChange}
            onOpenCode={(nodeId) => host.post({ type: 'openCode', nodeId })}
            onStepDiff={(stepId) => host.post({ type: 'openStepDiff', stepId })}
            onOpenVerification={(stepId) => host.post({ type: 'openVerification', stepId })}
            drift={drift}
            shapeStyle={shapeStyle}
            initialCamera={host.getState<SavedState>()?.camera}
            onCameraChange={onCameraChange}
            textBar={!inspectorOpen}
          />
        )}
        {scene && scene.elements.length === 0 && (
          <div className="pc-empty-hint">
            <p>
              <strong>An empty board.</strong> Draw anything with the tools below.
            </p>
            <p className="pc-muted">
              Or ask your AI, e.g. <em>“draw the login flow on the whiteboard”</em>. Changes show up
              here as it makes them.
            </p>
          </div>
        )}
        {scene && inspectorOpen && (
          <Inspector
            key={[...selection].join(',')}
            scene={scene}
            selection={selection}
            readOnly={readOnly}
            onChange={(next) => onChange(next, true)}
            onOpenCode={(nodeId) => host.post({ type: 'openCode', nodeId })}
            onStepDiff={(stepId) => host.post({ type: 'openStepDiff', stepId })}
            drift={drift}
            codeInfo={codeInfo}
            scannedAt={code?.scannedAt}
            codeOff={codeSync === 'off'}
            onRequestCodeInfo={requestCodeInfo}
            onAskAi={askAi}
            onVerifyStep={(stepId) => host.post({ type: 'verifyStep', stepId })}
            onOpenVerification={(stepId) => host.post({ type: 'openVerification', stepId })}
          />
        )}
        {scene && codeOpen && !invalid && (
          <CodePanel
            state={code}
            busy={busy ?? (agentWorking ? 'Your AI is changing this board…' : undefined)}
            hasSteps={scene.elements.some((e) => e.kind === 'step')}
            planStatus={scene.meta.status}
            mode={codeSync}
            onMode={(m) => setMeta({ codeSync: m === 'auto' ? undefined : m })}
            onPlanStatus={(status) => setMeta({ status })}
            onSync={() => host.post({ type: 'syncFromCode' })}
            onCheck={() => host.post({ type: 'checkDrift' })}
            onAskAi={(request) => askAi(request, [...selection])}
            onSelect={selectAndReveal}
            onClose={() => setCodeOpen(false)}
          />
        )}
        <div className="pc-dock" ref={dockRef}>
          <ZoomControls
            zoom={zoom}
            onZoomOut={() => canvas.current?.zoomBy(1 / 1.2)}
            onZoomIn={() => canvas.current?.zoomBy(1.2)}
            onReset={() => canvas.current?.resetZoom()}
            onFit={() => canvas.current?.fit()}
          />
          <ToolPalette
            tool={tool}
            onTool={setTool}
            readOnly={readOnly}
            style={shapeStyle}
            onStyle={setShapeStyle}
          />
        </div>
      </main>
    </div>
  );
}
