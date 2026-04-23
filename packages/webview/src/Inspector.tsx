import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  StepStatusSchema,
  type AskAiRequest,
  type CodeInfo,
  type ColorName,
  type DriftItem,
  type FillStyle,
  type FreeformShape,
} from '@agentic-whiteboard/shared';
import type { ShapeStyleState } from './canvas/Canvas';
import { DriftList, NodeCodeSection, VerificationSection } from './CodePanel';
import { isBlocked, isStylableText, mapElements, setBlocked, setTextStyle } from './canvas/ops';
import { textStyleOf } from './canvas/textStyle';
import type { Scene, SceneElement } from './canvas/types';
import { StylePicker, TextStyleControls } from './Toolbar';

interface InspectorProps {
  scene: Scene;
  selection: ReadonlySet<string>;
  readOnly: boolean;
  onChange(scene: Scene): void;
  onOpenCode(nodeId: string): void;
  onStepDiff(stepId: string): void;
  drift: ReadonlyMap<string, readonly DriftItem[]>;
  codeInfo: ReadonlyMap<string, CodeInfo>;
  scannedAt: string | undefined;
  /** Code sync is off on this board: no drift, code facts or verification. */
  codeOff: boolean;
  onRequestCodeInfo(nodeId: string): void;
  onAskAi(request: AskAiRequest, ids: string[]): void;
  onVerifyStep(stepId: string): void;
  onOpenVerification(stepId: string): void;
}

/**
 * Text input that updates the board shortly after typing stops, on Enter and on blur. Anything
 * still pending is saved when the field goes away: clicking the canvas deselects (closing the
 * panel) without the input ever losing focus, because the canvas keeps focus where it is.
 */
function TextField({
  label,
  value,
  onCommit,
  placeholder,
  multiline,
  mono,
}: {
  label: string;
  value: string;
  onCommit(v: string): void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const v = pending.current;
    pending.current = undefined;
    if (v !== undefined) commitRef.current(v);
  }, []);
  // Save on unmount, i.e. when the panel closes or shows another element.
  useEffect(() => flush, [flush]);
  // Follow changes from elsewhere (canvas, undo, the AI) unless the user is typing here.
  useEffect(() => {
    if (document.activeElement !== input.current || pending.current === undefined) setDraft(value);
  }, [value]);

  const onEdit = (v: string) => {
    setDraft(v);
    pending.current = v === value ? undefined : v;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const common = {
    ref: input,
    value: draft,
    placeholder,
    className: `pc-input ${mono ? 'pc-mono' : ''}`,
    'aria-label': label,
    onBlur: flush,
  };
  return (
    <label className="pc-field">
      <span className="pc-field-label">{label}</span>
      {multiline ? (
        <textarea
          {...common}
          rows={3}
          onChange={(e) => onEdit(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) flush();
          }}
        />
      ) : (
        <input
          {...common}
          onChange={(e) => onEdit(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') flush();
          }}
        />
      )}
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  labels,
}: {
  label: string;
  value: T | '';
  options: readonly T[];
  onChange(v: T | ''): void;
  labels?: Partial<Record<T | '', string>>;
}) {
  return (
    <label className="pc-field">
      <span className="pc-field-label">{label}</span>
      <select
        className="pc-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T | '')}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o.replace('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="pc-inspector" aria-label={title}>
      <h2 className="pc-inspector-title">{title}</h2>
      {children}
    </aside>
  );
}

function BlockActions({
  scene,
  ids,
  onChange,
}: {
  scene: Scene;
  ids: readonly string[];
  onChange(scene: Scene): void;
}) {
  const elements = scene.elements.filter((el) => ids.includes(el.id));
  if (!elements.length || elements.length !== ids.length) return null;
  const allBlocked = elements.every(isBlocked);
  const allUnblocked = elements.every((el) => !isBlocked(el));
  return (
    <div className="pc-field">
      <span className="pc-field-label">Selection</span>
      {allUnblocked && (
        <button
          className="pc-btn pc-btn-small"
          onClick={() => onChange(setBlocked(scene, new Set(ids), true))}
        >
          Block
        </button>
      )}
      {allBlocked && (
        <button
          className="pc-btn pc-btn-small"
          onClick={() => onChange(setBlocked(scene, new Set(ids), false))}
        >
          Unblock
        </button>
      )}
    </div>
  );
}

export function Inspector({
  scene,
  selection,
  readOnly,
  onChange,
  onOpenCode,
  onStepDiff,
  drift,
  codeInfo,
  scannedAt,
  codeOff,
  onRequestCodeInfo,
  onAskAi,
  onVerifyStep,
  onOpenVerification,
}: InspectorProps) {
  if (readOnly || selection.size === 0) return null;
  const ids = [...selection];
  const els = ids
    .map((id) => scene.elements.find((e) => e.id === id))
    .filter((e): e is SceneElement => !!e);

  // Several free-form shapes: shared style controls.
  const shapes = els.filter(
    (e): e is Extract<SceneElement, { kind: 'shape' }> =>
      e.kind === 'shape' && e.data.type !== 'frame',
  );
  if (ids.length > 1) {
    // Boxes, arrows and steps: a flow the AI can implement.
    const flow = ids.filter(
      (id) =>
        scene.edges.some((e) => e.id === id) ||
        els.some((e) => e.id === id && (e.kind === 'node' || e.kind === 'step')),
    );
    if (!shapes.length && !flow.length) return null;
    return (
      <Section title={shapes.length ? `${shapes.length} shapes` : `${flow.length} selected`}>
        <BlockActions scene={scene} ids={ids} onChange={onChange} />
        {shapes.length > 0 && (
          <ShapeStyle shapes={shapes} first={shapes[0]!.data} scene={scene} onChange={onChange} />
        )}
        {flow.length > 0 && (
          <>
            <p className="pc-muted">
              Hand this part of the plan to your AI agent. It implements it and verifies each step.
            </p>
            <button className="pc-btn pc-btn-small" onClick={() => onAskAi('implement', flow)}>
              Ask AI to implement this flow
            </button>
          </>
        )}
      </Section>
    );
  }

  const id = ids[0]!;
  const edge = scene.edges.find((e) => e.id === id);
  if (edge) {
    const label = (nid: string) =>
      scene.elements.find((e) => e.id === nid && e.kind === 'node')?.data;
    const from = label(edge.from) as { label?: string } | undefined;
    const to = label(edge.to) as { label?: string } | undefined;
    return (
      <Section title="Data flow">
        <p className="pc-muted">
          {from?.label ?? edge.from} {'->'} {to?.label ?? edge.to}
        </p>
        <TextField
          label="Label"
          value={edge.label ?? ''}
          placeholder="e.g. HTTP, events"
          onCommit={(v) =>
            onChange({
              ...scene,
              edges: scene.edges.map((e) => (e.id === id ? { ...e, label: v || undefined } : e)),
            })
          }
        />
        {edge.origin === 'code' && <p className="pc-muted">Mirrors an import in the code.</p>}
        <DriftList items={drift.get(id) ?? []} />
      </Section>
    );
  }

  const el = els[0];
  if (!el) return null;
  const update = (fn: (el: SceneElement) => SceneElement) =>
    onChange(mapElements(scene, new Set([id]), fn));

  switch (el.kind) {
    case 'node': {
      const n = el.data;
      const set = (patch: Partial<typeof n>) =>
        update((e) =>
          e.kind === 'node'
            ? {
                ...e,
                data: Object.fromEntries(
                  Object.entries({ ...e.data, ...patch }).filter(
                    ([, v]) => v !== undefined && v !== '',
                  ),
                ) as typeof n,
              }
            : e,
        );
      return (
        <Section
          title={
            n.kind === 'file' ? 'File' : n.kind === 'external' ? 'External system' : 'Component'
          }
        >
          <BlockActions scene={scene} ids={[el.id]} onChange={onChange} />
          <TextField label="Label" value={n.label} onCommit={(label) => set({ label })} />
          <TextControls scene={scene} ids={[el.id]} onChange={onChange} />
          <NodeCodeSection
            node={n}
            info={codeInfo.get(n.id)}
            scannedAt={scannedAt}
            codeOff={codeOff}
            drift={drift.get(n.id) ?? []}
            edges={{
              out: scene.edges.filter((e) => e.from === n.id).map((e) => labelOf(scene, e.to)),
              in: scene.edges.filter((e) => e.to === n.id).map((e) => labelOf(scene, e.from)),
            }}
            onRequestInfo={() => onRequestCodeInfo(n.id)}
            onOpenCode={() => onOpenCode(n.id)}
            onAskAi={(request) => onAskAi(request, [n.id])}
            fields={
              <>
                <TextField
                  label={n.kind === 'external' ? 'Path (optional)' : 'Path (file or folder)'}
                  value={n.path ?? ''}
                  mono
                  placeholder="src/…"
                  onCommit={(path) => set({ path: path || undefined })}
                />
                {n.kind === 'external' ? (
                  <TextField
                    label="Package"
                    value={n.package ?? ''}
                    mono
                    placeholder="e.g. stripe"
                    onCommit={(pkg) => set({ package: pkg || undefined, packages: undefined })}
                  />
                ) : (
                  <TextField
                    label="Symbol"
                    value={n.symbol ?? ''}
                    mono
                    placeholder="e.g. PaymentService"
                    onCommit={(symbol) => set({ symbol: symbol || undefined })}
                  />
                )}
              </>
            }
          />
        </Section>
      );
    }
    case 'step': {
      const s = el.data;
      const set = (patch: Partial<typeof s>) =>
        update((e) => (e.kind === 'step' ? { ...e, data: { ...e.data, ...patch } } : e));
      const nodes = scene.elements.filter(
        (e): e is Extract<SceneElement, { kind: 'node' }> => e.kind === 'node',
      );
      return (
        <Section title={`Step ${s.order}`}>
          <BlockActions scene={scene} ids={[el.id]} onChange={onChange} />
          <TextField label="Title" value={s.title} onCommit={(title) => set({ title })} />
          <TextField
            label="Detail"
            value={s.detail ?? ''}
            multiline
            onCommit={(detail) => set({ detail: detail || undefined })}
          />
          <label className="pc-field">
            <span className="pc-field-label">Order</span>
            <input
              className="pc-input"
              type="number"
              key={s.order}
              defaultValue={s.order}
              step={1}
              onBlur={(e) =>
                Number(e.currentTarget.value) !== s.order &&
                set({ order: Number(e.currentTarget.value) })
              }
            />
          </label>
          <SelectField
            label="Status"
            value={s.status}
            options={StepStatusSchema.options}
            onChange={(status) => status && set({ status })}
          />
          <TextField
            label="Note"
            value={s.note ?? ''}
            onCommit={(note) => set({ note: note || undefined })}
          />
          {s.status === 'done' && (
            <button className="pc-btn pc-btn-small" onClick={() => onStepDiff(s.id)}>
              Show changes
            </button>
          )}
          {!codeOff && (
            <VerificationSection
              step={s}
              onVerify={() => onVerifyStep(s.id)}
              onOpen={() => onOpenVerification(s.id)}
            />
          )}
          {nodes.length > 0 && (
            <fieldset className="pc-field">
              <legend className="pc-field-label">Touches</legend>
              <div className="pc-checklist">
                {nodes.map((n) => (
                  <label key={n.id} className="pc-check">
                    <input
                      type="checkbox"
                      checked={s.nodeIds.includes(n.id)}
                      onChange={(e) =>
                        set({
                          nodeIds: e.target.checked
                            ? [...s.nodeIds, n.id]
                            : s.nodeIds.filter((x) => x !== n.id),
                        })
                      }
                    />
                    {n.data.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </Section>
      );
    }
    case 'constraint': {
      const c = el.data;
      return (
        <Section title="Constraint">
          <BlockActions scene={scene} ids={[el.id]} onChange={onChange} />
          <TextField
            label="Rule"
            value={c.text}
            multiline
            onCommit={(text) =>
              update((e) => (e.kind === 'constraint' ? { ...e, data: { ...e.data, text } } : e))
            }
          />
          <TextField
            label="Scope (paths or node ids, comma-separated)"
            value={(c.scope ?? []).join(', ')}
            mono
            onCommit={(v) => {
              const scope = v
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean);
              update((e) =>
                e.kind === 'constraint'
                  ? { ...e, data: { ...e.data, scope: scope.length ? scope : undefined } }
                  : e,
              );
            }}
          />
          <p className="pc-muted">Written by {c.author === 'user' ? 'you' : 'the agent'}.</p>
        </Section>
      );
    }
    case 'comment': {
      const c = el.data;
      const targets = scene.elements.filter((e) => e.kind === 'node' || e.kind === 'step');
      return (
        <Section title="Note">
          <BlockActions scene={scene} ids={[el.id]} onChange={onChange} />
          <TextField
            label="Text"
            value={c.text}
            multiline
            onCommit={(text) =>
              update((e) => (e.kind === 'comment' ? { ...e, data: { ...e.data, text } } : e))
            }
          />
          <TextControls scene={scene} ids={[el.id]} onChange={onChange} />
          <label className="pc-field">
            <span className="pc-field-label">Attached to</span>
            <select
              className="pc-select"
              value={c.attachedTo ?? ''}
              onChange={(ev) =>
                update((e) => {
                  if (e.kind !== 'comment') return e;
                  const { attachedTo: _old, ...data } = e.data;
                  return {
                    ...e,
                    data: ev.target.value ? { ...data, attachedTo: ev.target.value } : data,
                  };
                })
              }
            >
              <option value="">nothing</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'node' ? t.data.label : `Step ${t.data.order}: ${t.data.title}`}
                </option>
              ))}
            </select>
          </label>
        </Section>
      );
    }
    case 'shape':
      if (el.data.type === 'frame') {
        const label = el.data.label;
        return (
          <Section title="Frame">
            <BlockActions scene={scene} ids={[el.id]} onChange={onChange} />
            <TextField
              label="Label"
              value={label}
              onCommit={(v) =>
                update((e) =>
                  e.kind === 'shape' && e.data.type === 'frame'
                    ? { ...e, data: { ...e.data, label: v } }
                    : e,
                )
              }
            />
          </Section>
        );
      }
      return (
        <Section title="Shape">
          <BlockActions scene={scene} ids={[el.id]} onChange={onChange} />
          <ShapeStyle shapes={[el]} first={el.data} scene={scene} onChange={onChange} />
        </Section>
      );
  }
}

function labelOf(scene: Scene, id: string): string {
  const el = scene.elements.find((e) => e.id === id);
  return el?.kind === 'node' ? el.data.label.split('\n')[0]! : id;
}

function ShapeStyle({
  shapes,
  first,
  scene,
  onChange,
}: {
  shapes: Extract<SceneElement, { kind: 'shape' }>[];
  first: FreeformShape;
  scene: Scene;
  onChange(s: Scene): void;
}) {
  const current: ShapeStyleState = {
    color: first.color ?? 'default',
    fill: first.fill ?? 'none',
    strokeWidth: first.strokeWidth ?? 2,
  };
  const apply = (s: ShapeStyleState) =>
    onChange(
      mapElements(scene, new Set(shapes.map((x) => x.id)), (e) =>
        e.kind === 'shape'
          ? {
              ...e,
              data: {
                ...e.data,
                color: s.color as ColorName,
                fill: s.fill as FillStyle,
                strokeWidth: s.strokeWidth,
              },
            }
          : e,
      ),
    );
  return (
    <>
      <StylePicker style={current} onStyle={apply} />
      <TextControls scene={scene} ids={shapes.map((x) => x.id)} onChange={onChange} />
    </>
  );
}

/** Text size, bold and alignment for the given elements, when all of them hold styleable text. */
function TextControls({
  scene,
  ids,
  onChange,
}: {
  scene: Scene;
  ids: readonly string[];
  onChange(s: Scene): void;
}) {
  const els = scene.elements.filter((e) => ids.includes(e.id));
  const value = els[0] && textStyleOf(els[0]);
  if (!value || els.length !== ids.length || !els.every(isStylableText)) return null;
  return (
    <>
      <div className="pc-field-label">Text</div>
      <TextStyleControls
        value={value}
        onChange={(patch) => onChange(setTextStyle(scene, new Set(ids), patch))}
      />
    </>
  );
}
