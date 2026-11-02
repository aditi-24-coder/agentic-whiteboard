import { useEffect, useRef, useState } from 'react';
import {
  BOARD_BACKGROUNDS,
  FONT_SIZES,
  type BoardBackground,
  type ColorName,
  type FillStyle,
  type FontSizeName,
  type TextAlign,
  type TextStyle,
} from '@agentic-whiteboard/shared';
import type { ShapeStyleState, Tool } from './canvas/Canvas';
import { Icon, type IconName } from './icons';

export interface TopBarProps {
  title: string;
  readOnly: boolean;
  onRename(title: string): void;
  onRelayout(): void;
  onAddNote(): void;
  /** The board's background; undefined follows the VS Code theme. */
  background: BoardBackground | undefined;
  onBackground(id: BoardBackground | undefined): void;
  canInspect: boolean;
  inspectorOpen: boolean;
  onToggleInspector(): void;
  onExport(format: 'png' | 'svg'): void;
  /** Exports cover only the selection when something is selected. */
  selectionCount: number;
  onUndo(): void;
  onRedo(): void;
  codeOpen: boolean;
  onToggleCode(): void;
  /** Drift items needing attention, shown as a badge on the Code button. */
  driftCount: number;
  driftSeverity?: 'error' | 'warning' | 'info';
  /** The board's code sync mode, shown on the Code button. */
  codeSync: 'auto' | 'on' | 'off';
}

export function TopBar(p: TopBarProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);

  return (
    <header className="pc-topbar">
      <div className="pc-title-group">
        {editingTitle ? (
          <input
            className="pc-title-input"
            autoFocus
            defaultValue={p.title}
            aria-label="Whiteboard title"
            onBlur={(e) => {
              setEditingTitle(false);
              if (e.currentTarget.value.trim() && e.currentTarget.value !== p.title)
                p.onRename(e.currentTarget.value.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <h1
            className="pc-title"
            title="Double-click to rename"
            onDoubleClick={() => !p.readOnly && setEditingTitle(true)}
          >
            {p.title}
          </h1>
        )}
      </div>
      <div className="pc-actions">
        <button
          className={`pc-btn pc-btn-ghost ${p.codeOpen ? 'pc-btn-active' : ''}`}
          disabled={p.readOnly}
          onClick={p.onToggleCode}
          aria-pressed={p.codeOpen}
          title={
            p.codeSync === 'off'
              ? 'Code sync is off: a plain whiteboard, never compared with the code'
              : p.driftCount
                ? `The diagram and the code disagree in ${p.driftCount} place${p.driftCount === 1 ? '' : 's'}`
                : `Code sync: ${p.codeSync}. Generate, sync and check the board against the code`
          }
        >
          <Icon name="code" size={16} />
          <span className="pc-btn-label">Code</span>
          {p.codeSync !== 'auto' && (
            <span className={`pc-mode pc-mode-${p.codeSync}`}>{p.codeSync}</span>
          )}
          {p.codeSync !== 'off' && p.driftCount > 0 && (
            <span className={`pc-badge pc-badge-${p.driftSeverity ?? 'warning'}`}>
              {p.driftCount}
            </span>
          )}
        </button>
        <button
          className={`pc-btn pc-btn-ghost ${p.inspectorOpen ? 'pc-btn-active' : ''}`}
          disabled={p.readOnly || !p.canInspect}
          onClick={p.onToggleInspector}
          aria-pressed={p.inspectorOpen}
          title={p.canInspect ? 'Show the properties of the selection' : 'Select something first'}
        >
          <Icon name="sliders" size={16} />
          <span className="pc-btn-label">Properties</span>
        </button>
        <button
          className="pc-btn pc-btn-ghost"
          disabled={p.readOnly}
          onClick={p.onAddNote}
          title="Add a sticky note (S)"
        >
          <Icon name="sticky" size={16} />
          <span className="pc-btn-label">Add note</span>
        </button>
        <button
          className="pc-btn pc-btn-ghost"
          disabled={p.readOnly}
          onClick={p.onRelayout}
          title="Re-arrange the diagram boxes automatically"
        >
          <Icon name="layout" size={16} />
          <span className="pc-btn-label">Re-layout</span>
        </button>
        <div className="pc-popover-anchor">
          <button
            className={`pc-btn pc-btn-ghost ${bgOpen ? 'pc-btn-active' : ''}`}
            disabled={p.readOnly}
            onClick={() => setBgOpen((o) => !o)}
            aria-expanded={bgOpen}
            title="Board background"
          >
            <span
              className="pc-bg-dot"
              style={{
                background: p.background ? BOARD_BACKGROUNDS[p.background].color : 'var(--pc-bg)',
              }}
            />
            <span className="pc-btn-label">Background</span>
          </button>
          {bgOpen && (
            <Popover onClose={() => setBgOpen(false)}>
              <div className="pc-field-label">Board background</div>
              <div className="pc-bg-grid" role="group" aria-label="Board background">
                <button
                  className={`pc-bg-option ${!p.background ? 'pc-bg-option-active' : ''}`}
                  aria-pressed={!p.background}
                  onClick={() => p.onBackground(undefined)}
                >
                  <span className="pc-bg-swatch pc-bg-swatch-auto" />
                  Match VS Code
                </button>
                {(Object.keys(BOARD_BACKGROUNDS) as BoardBackground[]).map((id) => (
                  <button
                    key={id}
                    className={`pc-bg-option ${p.background === id ? 'pc-bg-option-active' : ''}`}
                    aria-pressed={p.background === id}
                    onClick={() => p.onBackground(id)}
                  >
                    <span
                      className="pc-bg-swatch"
                      style={{ background: BOARD_BACKGROUNDS[id].color }}
                    />
                    {BOARD_BACKGROUNDS[id].label}
                  </button>
                ))}
              </div>
            </Popover>
          )}
        </div>
        <div className="pc-popover-anchor">
          <button
            className="pc-btn pc-btn-ghost"
            onClick={() => setExportOpen((o) => !o)}
            aria-expanded={exportOpen}
            title={
              p.selectionCount ? 'Export the selection as an image' : 'Export the board as an image'
            }
          >
            <Icon name="export" size={16} />
            <span className="pc-btn-label">Export</span>
          </button>
          {exportOpen && (
            <Popover onClose={() => setExportOpen(false)} narrow>
              <div className="pc-menu-note">
                {p.selectionCount
                  ? `Only the ${p.selectionCount} selected item${p.selectionCount === 1 ? '' : 's'}`
                  : 'The whole board'}
              </div>
              <button
                className="pc-menu-item"
                onClick={() => (setExportOpen(false), p.onExport('png'))}
              >
                PNG image
              </button>
              <button
                className="pc-menu-item"
                onClick={() => (setExportOpen(false), p.onExport('svg'))}
              >
                SVG image
              </button>
            </Popover>
          )}
        </div>
        <span className="pc-sep" />
        <button
          className="pc-icon-btn"
          disabled={p.readOnly}
          onClick={p.onUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          <Icon name="undo" />
        </button>
        <button
          className="pc-icon-btn"
          disabled={p.readOnly}
          onClick={p.onRedo}
          title="Redo (Ctrl+Y)"
          aria-label="Redo"
        >
          <Icon name="redo" />
        </button>
      </div>
    </header>
  );
}

function Popover({
  children,
  onClose,
  narrow,
  above,
}: {
  children: React.ReactNode;
  onClose(): void;
  narrow?: boolean;
  /** Open upwards, for controls at the bottom of the board. */
  above?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`pc-popover ${narrow ? 'pc-popover-narrow' : ''} ${above ? 'pc-popover-above' : ''}`}
      role="dialog"
    >
      {children}
    </div>
  );
}

interface ToolDef {
  tool: Tool;
  label: string;
  key: string;
  icon: IconName;
}

/** Tools in groups: navigate, draw, diagram. Sticky notes come from Add note in the top bar. */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { tool: 'select', label: 'Select', key: 'V', icon: 'select' },
    { tool: 'hand', label: 'Pan', key: 'H', icon: 'hand' },
  ],
  [
    { tool: 'pen', label: 'Draw', key: 'P', icon: 'pen' },
    { tool: 'rect', label: 'Rectangle', key: 'R', icon: 'rect' },
    { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: 'ellipse' },
    { tool: 'diamond', label: 'Diamond', key: 'D', icon: 'diamond' },
    { tool: 'arrow', label: 'Arrow (drag between boxes to connect them)', key: 'A', icon: 'arrow' },
    { tool: 'line', label: 'Line', key: 'L', icon: 'line' },
    { tool: 'text', label: 'Text', key: 'T', icon: 'text' },
  ],
  [
    { tool: 'component', label: 'Diagram box', key: 'B', icon: 'box' },
    { tool: 'file', label: 'File card', key: 'I', icon: 'file' },
    { tool: 'frame', label: 'Frame', key: 'F', icon: 'frame' },
  ],
];

const COLORS: ColorName[] = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'violet',
  'grey',
];

const swatch = (c: ColorName) => `var(--pc-${c === 'default' ? 'ink' : c})`;

export function ToolPalette({
  tool,
  onTool,
  readOnly,
  style,
  onStyle,
}: {
  tool: Tool;
  onTool(t: Tool): void;
  readOnly: boolean;
  style: ShapeStyleState;
  onStyle(s: ShapeStyleState): void;
}) {
  const [styleOpen, setStyleOpen] = useState(false);
  const groups = readOnly ? TOOL_GROUPS.slice(0, 1) : TOOL_GROUPS;
  return (
    <div className="pc-palette" role="toolbar" aria-label="Tools">
      {groups.map((group, i) => (
        <div className="pc-tool-group" key={i}>
          {group.map((t) => (
            <button
              key={t.tool}
              className={`pc-tool ${tool === t.tool ? 'pc-tool-active' : ''}`}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.tool}
              onClick={() => onTool(t.tool)}
            >
              <Icon name={t.icon} />
            </button>
          ))}
        </div>
      ))}
      {!readOnly && (
        <div className="pc-tool-group pc-popover-anchor">
          <button
            className={`pc-tool pc-style-btn ${styleOpen ? 'pc-tool-active' : ''}`}
            title="Color, fill, text size and stroke (applies to the selection and new shapes)"
            aria-label="Style"
            aria-expanded={styleOpen}
            onClick={() => setStyleOpen((o) => !o)}
          >
            <span className="pc-style-dot" style={{ background: swatch(style.color) }} />
            <Icon name="chevron" size={12} />
          </button>
          {styleOpen && (
            <Popover onClose={() => setStyleOpen(false)} above>
              <StylePicker style={style} onStyle={onStyle} forNewShapes />
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

export function StylePicker({
  style,
  onStyle,
  forNewShapes,
}: {
  style: ShapeStyleState;
  onStyle(s: ShapeStyleState): void;
  /** In the palette: also offer the text size used for new text and shapes. */
  forNewShapes?: boolean;
}) {
  const fills: { value: FillStyle; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'hachure', label: 'Sketch' },
    { value: 'solid', label: 'Solid' },
  ];
  const strokes = [
    { value: 1, label: 'Thin' },
    { value: 2, label: 'Medium' },
    { value: 4, label: 'Bold' },
  ];
  const fontPx = style.fontSize ?? FONT_SIZES.M;
  return (
    <div className="pc-style-picker">
      <div className="pc-field-label">Color</div>
      <div className="pc-swatches">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`pc-swatch ${style.color === c ? 'pc-swatch-active' : ''}`}
            style={{ background: swatch(c) }}
            title={c}
            aria-label={`Color ${c}`}
            aria-pressed={style.color === c}
            onClick={() => onStyle({ ...style, color: c })}
          />
        ))}
      </div>
      <div className="pc-field-label">Fill</div>
      <div className="pc-segmented" role="group" aria-label="Fill">
        {fills.map((f) => (
          <button
            key={f.value}
            className={style.fill === f.value ? 'pc-seg-active' : ''}
            aria-pressed={style.fill === f.value}
            onClick={() => onStyle({ ...style, fill: f.value })}
          >
            {f.label}
          </button>
        ))}
      </div>
      {forNewShapes && (
        <>
          <div className="pc-field-label">Text size</div>
          <div className="pc-text-controls">
            <div className="pc-segmented" role="group" aria-label="Text size for new text">
              {(Object.entries(FONT_SIZES) as [FontSizeName, number][]).map(([n, px]) => (
                <button
                  key={n}
                  className={fontPx === px ? 'pc-seg-active' : ''}
                  aria-pressed={fontPx === px}
                  title={`${px}px`}
                  onClick={() => onStyle({ ...style, fontSize: px })}
                >
                  {n}
                </button>
              ))}
            </div>
            <FontSizeInput value={fontPx} onChange={(px) => onStyle({ ...style, fontSize: px })} />
          </div>
        </>
      )}
      <div className="pc-field-label">Stroke</div>
      <div className="pc-segmented" role="group" aria-label="Stroke width">
        {strokes.map((w) => (
          <button
            key={w.value}
            className={style.strokeWidth === w.value ? 'pc-seg-active' : ''}
            aria-pressed={style.strokeWidth === w.value}
            onClick={() => onStyle({ ...style, strokeWidth: w.value })}
          >
            {w.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ZoomControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
}: {
  zoom: number;
  onZoomOut(): void;
  onZoomIn(): void;
  onReset(): void;
  onFit(): void;
}) {
  const percent = Math.round(zoom * 100);
  return (
    <div className="pc-zoom" role="group" aria-label="Zoom">
      <button
        className="pc-icon-btn"
        onClick={onZoomOut}
        title="Zoom out (-)"
        aria-label="Zoom out"
      >
        <Icon name="minus" size={16} />
      </button>
      <button
        className="pc-zoom-level"
        onClick={onReset}
        title="Reset to 100% (Shift+0)"
        aria-label={`Zoom ${percent}%, click to reset to 100%`}
      >
        {percent}%
      </button>
      <button className="pc-icon-btn" onClick={onZoomIn} title="Zoom in (+)" aria-label="Zoom in">
        <Icon name="plus" size={16} />
      </button>
      <span className="pc-sep" />
      <button
        className="pc-icon-btn"
        onClick={onFit}
        title="Zoom to fit (Shift+1)"
        aria-label="Zoom to fit"
      >
        <Icon name="fit" size={16} />
      </button>
    </div>
  );
}

const ALIGNS: { value: TextAlign; icon: IconName; label: string }[] = [
  { value: 'left', icon: 'alignLeft', label: 'Align left' },
  { value: 'center', icon: 'alignCenter', label: 'Align centre' },
  { value: 'right', icon: 'alignRight', label: 'Align right' },
];

/**
 * Text size, bold and alignment for the selected text. `value` is the effective style of the
 * first selected shape (defaults filled in), so the active buttons always reflect what is drawn.
 */
/** A px text size field; commits on Enter or blur. */
function FontSizeInput({ value, onChange }: { value: number; onChange(px: number): void }) {
  return (
    <label className="pc-font-size" title="Text size in px">
      <input
        key={value}
        type="number"
        min={8}
        max={200}
        defaultValue={value}
        aria-label="Text size in px"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const n = Math.round(Number(e.currentTarget.value));
          if (n >= 8 && n <= 200 && n !== value) onChange(n);
        }}
      />
      px
    </label>
  );
}

export function TextStyleControls({
  value,
  onChange,
  showSize = true,
}: {
  value: Required<TextStyle>;
  onChange(patch: TextStyle): void;
  /** Off where the style picker already offers the size. */
  showSize?: boolean;
}) {
  const sizes = Object.entries(FONT_SIZES) as [FontSizeName, number][];
  return (
    <div className="pc-text-controls">
      {showSize && (
        <>
          <div className="pc-segmented" role="group" aria-label="Text size">
            {sizes.map(([n, px]) => (
              <button
                key={n}
                className={value.fontSize === px ? 'pc-seg-active' : ''}
                aria-pressed={value.fontSize === px}
                title={`${px}px`}
                onClick={() => onChange({ fontSize: px })}
              >
                {n}
              </button>
            ))}
          </div>
          <FontSizeInput value={value.fontSize} onChange={(px) => onChange({ fontSize: px })} />
        </>
      )}
      <button
        className={`pc-tool ${value.bold ? 'pc-tool-active' : ''}`}
        aria-pressed={value.bold}
        aria-label="Bold"
        title="Bold (Ctrl+B)"
        onClick={() => onChange({ bold: !value.bold })}
      >
        <Icon name="bold" size={16} />
      </button>
      <div className="pc-tool-group pc-align-group" role="group" aria-label="Alignment">
        {ALIGNS.map((a) => (
          <button
            key={a.value}
            className={`pc-tool ${value.align === a.value ? 'pc-tool-active' : ''}`}
            aria-pressed={value.align === a.value}
            aria-label={a.label}
            title={a.label}
            onClick={() => onChange({ align: a.value })}
          >
            <Icon name={a.icon} size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}
