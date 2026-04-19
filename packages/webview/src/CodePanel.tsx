import { useEffect, useState, type ReactNode } from 'react';
import {
  PlanStatusSchema,
  type AskAiRequest,
  type CodeInfo,
  type CodeState,
  type CodeSyncMode,
  type DriftItem,
  type PlanNode,
  type PlanStatus,
  type Step,
} from '@agentic-whiteboard/shared';
import { VERIFICATION } from './canvas/shapes';

export const MODES: Record<CodeSyncMode, { label: string; hint: string }> = {
  auto: { label: 'Auto', hint: 'Checked against the code when boxes link to files.' },
  on: { label: 'On', hint: 'A plan or architecture board: always checked against the code.' },
  off: { label: 'Off', hint: 'A plain whiteboard for sketching and explaining. Never checked.' },
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
const SEVERITY_ICON = { error: '✕', warning: '⚠', info: 'ℹ' } as const;

function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Re-renders every 30s, so "checked just now" does not stay "just now" for an hour. */
function useClock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
}

export function DriftList({
  items,
  onSelect,
  empty,
  collapseNotes = false,
}: {
  items: readonly DriftItem[];
  onSelect?(id: string): void;
  empty?: string;
  /** Show notes (info) only on request: they are expected differences, not problems. */
  collapseNotes?: boolean;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const sorted = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const notes = sorted.filter((d) => d.severity === 'info');
  const problems = sorted.filter((d) => d.severity !== 'info');
  const shown = collapseNotes && !notesOpen ? problems : sorted;
  return (
    <>
      {!problems.length && empty && <p className="pc-muted pc-drift-ok">✓ {empty}</p>}
      {shown.length > 0 && (
        <ul className="pc-drift-list">
          {shown.map((d, i) => (
            <li key={i} className={`pc-drift-item pc-drift-${d.severity}`}>
              <span className="pc-drift-icon" aria-label={d.severity}>
                {SEVERITY_ICON[d.severity]}
              </span>
              {d.targetId && onSelect ? (
                <button className="pc-linklike" onClick={() => onSelect(d.targetId!)}>
                  {d.message}
                </button>
              ) : (
                <span>{d.message}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {collapseNotes && notes.length > 0 && (
        <button
          className="pc-linklike pc-notes-toggle"
          aria-expanded={notesOpen}
          onClick={() => setNotesOpen((o) => !o)}
        >
          {notesOpen ? 'Hide notes' : `${notes.length} note${notes.length === 1 ? '' : 's'} ▸`}
        </button>
      )}
    </>
  );
}

/** The board's link to the code: sync state, drift, and the actions that act on the code. */
export function CodePanel({
  state,
  busy,
  hasSteps,
  planStatus,
  onPlanStatus,
  mode,
  onMode,
  onSync,
  onCheck,
  onAskAi,
  onSelect,
  onClose,
}: {
  state: CodeState | undefined;
  busy: string | undefined;
  hasSteps: boolean;
  planStatus: PlanStatus;
  onPlanStatus(status: PlanStatus): void;
  mode: CodeSyncMode;
  onMode(mode: CodeSyncMode): void;
  onSync(): void;
  onCheck(): void;
  onAskAi(request: AskAiRequest): void;
  onSelect(id: string): void;
  onClose(): void;
}) {
  useClock();
  const drift = state?.drift ?? [];
  const head = (
    <>
      <div className="pc-code-head">
        <h2 className="pc-inspector-title">Code</h2>
        <button className="pc-icon-btn pc-icon-btn-small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="pc-field">
        <span className="pc-field-label">Code sync</span>
        <div className="pc-segmented" role="radiogroup" aria-label="Code sync">
          {(Object.keys(MODES) as CodeSyncMode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={`pc-segment ${mode === m ? 'pc-segment-active' : ''}`}
              disabled={!!busy}
              onClick={() => mode !== m && onMode(m)}
            >
              {MODES[m].label}
            </button>
          ))}
        </div>
        <span className="pc-muted pc-hint">{MODES[mode].hint}</span>
      </div>
    </>
  );
  if (mode === 'off')
    return (
      <aside className="pc-inspector pc-code-panel" aria-label="Code">
        {head}
        {busy && <p className="pc-busy">{busy}</p>}
        <p className="pc-muted">
          This board is a plain whiteboard: draw and explain freely. Nothing on it is compared with
          the code, and your AI is told not to link it to files.
        </p>
      </aside>
    );
  return (
    <aside className="pc-inspector pc-code-panel" aria-label="Code">
      {head}
      {busy && <p className="pc-busy">{busy}</p>}
      {state?.disabled ? (
        <p className="pc-muted">
          Drift detection is off (setting agentic-whiteboard.driftDetection).
        </p>
      ) : !state?.linked ? (
        <p className="pc-muted">
          Nothing on this board is linked to code yet. Generate the architecture from the
          repository, or set a path on any box in Properties.
        </p>
      ) : (
        <p className="pc-muted">
          Checked {timeAgo(state.scannedAt)}
          {state.commit ? (
            <>
              {' '}
              at <code>{state.commit}</code>
            </>
          ) : null}
          .
        </p>
      )}
      <div className="pc-btn-row">
        <button className="pc-btn pc-btn-small" disabled={!!busy} onClick={onSync}>
          {state?.linked ? 'Sync from code' : 'Generate from code'}
        </button>
        {state?.linked && (
          <button className="pc-btn pc-btn-small" disabled={!!busy} onClick={onCheck}>
            Check now
          </button>
        )}
      </div>
      {state?.linked && !state.disabled && (
        <DriftList
          items={drift}
          onSelect={onSelect}
          empty="The diagram matches the code."
          collapseNotes
        />
      )}
      {(hasSteps || state?.linked) && (
        <label className="pc-field">
          <span className="pc-field-label">Plan status</span>
          <select
            className="pc-select"
            value={planStatus}
            aria-label="Plan status"
            disabled={!!busy}
            onChange={(e) => onPlanStatus(e.target.value as PlanStatus)}
          >
            {PlanStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
          <span className="pc-muted pc-hint">
            Approved or in progress: changes outside the plan and unbuilt boxes are flagged.
          </span>
        </label>
      )}
      <div className="pc-field-label pc-section-label">Ask your AI</div>
      <div className="pc-btn-row">
        <button className="pc-btn pc-btn-small" disabled={!!busy} onClick={() => onAskAi('sync')}>
          Update diagram from code
        </button>
        {drift.length > 0 && (
          <button
            className="pc-btn pc-btn-small"
            disabled={!!busy}
            onClick={() => onAskAi('fix-drift')}
          >
            Explain &amp; fix drift
          </button>
        )}
        {hasSteps && (
          <button
            className="pc-btn pc-btn-small"
            disabled={!!busy}
            onClick={() => onAskAi('implement')}
          >
            Implement the plan
          </button>
        )}
      </div>
    </aside>
  );
}

function Facts({
  label,
  items,
  mono,
}: {
  label: string;
  items: readonly string[];
  mono?: boolean;
}) {
  if (!items.length) return null;
  const shown = items.slice(0, 8);
  return (
    <div className="pc-facts">
      <div className="pc-field-label">{label}</div>
      <ul className={mono ? 'pc-mono' : undefined}>
        {shown.map((x) => (
          <li key={x}>{x}</li>
        ))}
        {items.length > shown.length && (
          <li className="pc-muted">and {items.length - shown.length} more</li>
        )}
      </ul>
    </div>
  );
}

/** What a box stands for in the code, and how it differs from the diagram. */
export function NodeCodeSection({
  node,
  info,
  drift,
  edges,
  onRequestInfo,
  onOpenCode,
  onAskAi,
  fields,
  scannedAt,
  codeOff = false,
}: {
  node: PlanNode;
  info: CodeInfo | undefined;
  /** When the code was last scanned; a new scan asks for fresh facts. */
  scannedAt: string | undefined;
  /** Code sync is off: the path only opens files; no facts, no drift. */
  codeOff?: boolean;
  drift: readonly DriftItem[];
  /** Labels of boxes this one points to and that point to it. */
  edges: { out: string[]; in: string[] };
  onRequestInfo(): void;
  onOpenCode(): void;
  onAskAi(request: AskAiRequest): void;
  /** The editable link fields (path, symbol, package). */
  fields: ReactNode;
}) {
  const linked = !!(node.path || node.package);
  const key = `${node.path ?? ''}|${node.package ?? ''}|${scannedAt ?? ''}`;
  const [requested, setRequested] = useState('');
  useEffect(() => {
    if (linked && !codeOff && requested !== key) {
      setRequested(key);
      onRequestInfo();
    }
  }, [linked, codeOff, key, requested, onRequestInfo]);

  return (
    <>
      <div className="pc-field-label pc-section-label">Code</div>
      {fields}
      {linked && (
        <button className="pc-btn pc-btn-small" onClick={onOpenCode}>
          {node.symbol ? `Go to ${node.symbol}` : node.path ? 'Open code' : 'Show usages'}
        </button>
      )}
      {node.summary && <p className="pc-muted">{node.summary}</p>}
      {!codeOff && drift.length > 0 && (
        <>
          <DriftList items={drift} />
          <button className="pc-btn pc-btn-small" onClick={() => onAskAi('fix-drift')}>
            Ask AI to explain &amp; fix
          </button>
        </>
      )}
      {linked && !codeOff && !info && <p className="pc-muted">Reading the code…</p>}
      {!codeOff && info && (
        <div className="pc-code-info">
          {!info.exists && (
            <p className="pc-muted">
              {node.changeType === 'new' ? 'Not implemented yet.' : 'No code found.'}
            </p>
          )}
          {info.exists && (
            <p className="pc-muted">
              {node.package
                ? `Imported by ${info.files} file${info.files === 1 ? '' : 's'}.`
                : `${info.files} source file${info.files === 1 ? '' : 's'}.`}
            </p>
          )}
          {info.owners.length > 0 && (
            <p className="pc-muted">
              Owners: {info.owners.map((o) => `${o.name} (${o.commits})`).join(', ')}
            </p>
          )}
          {info.commits.length > 0 && (
            <div className="pc-facts">
              <div className="pc-field-label">Recent commits</div>
              <ul>
                {info.commits.map((c) => (
                  <li key={c.hash} title={`${c.author}, ${c.date}`}>
                    <code>{c.hash}</code> {c.subject}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Facts label="Routes" items={info.routes} mono />
          <Facts label="Models" items={info.models} />
          <Facts label="Exports" items={info.exports} mono />
          <Facts label="Tests" items={info.tests} mono />
          <Facts label="Packages" items={info.packages} mono />
        </div>
      )}
      <Facts label="Depends on" items={edges.out} />
      <Facts label="Used by" items={edges.in} />
    </>
  );
}

/** Evidence that a step was done: command, result, diff. */
export function VerificationSection({
  step,
  onVerify,
  onOpen,
}: {
  step: Step;
  onVerify(): void;
  onOpen(): void;
}) {
  useClock();
  const v = step.verification;
  return (
    <>
      <div className="pc-field-label pc-section-label">Verification</div>
      {v ? (
        <div className={`pc-verification pc-verification-${v.status}`}>
          <strong>{VERIFICATION[v.status].label}</strong>{' '}
          <span className="pc-muted">
            {timeAgo(v.at)}
            {v.commit ? ` at ${v.commit}` : ''}
          </span>
          {v.command && (
            <p className="pc-mono">
              $ {v.command} {'->'} exit {v.exitCode}
            </p>
          )}
          {v.reasons.length > 0 && (
            <ul className="pc-reasons">
              {v.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {v.diffStat && <pre className="pc-pre">{v.diffStat}</pre>}
        </div>
      ) : (
        <p className="pc-muted">
          Not verified yet. Verifying runs your tests and attaches the diff of the files this step
          touches.
        </p>
      )}
      <div className="pc-btn-row">
        <button className="pc-btn pc-btn-small" onClick={onVerify}>
          {v ? 'Verify again' : 'Verify step'}
        </button>
        {v && (
          <button className="pc-btn pc-btn-small" onClick={onOpen}>
            Diff &amp; output
          </button>
        )}
      </div>
    </>
  );
}
