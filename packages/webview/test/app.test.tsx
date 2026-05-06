// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostToWebview, Plan, WebviewToHost } from '@agentic-whiteboard/shared';
import { App } from '../src/App';
import type { Host } from '../src/host';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const plan = (): Plan =>
  JSON.parse(
    readFileSync(
      join(process.cwd(), 'packages/shared/test/fixtures/stripe-payments.plan.json'),
      'utf8',
    ),
  );
const settings = { theme: 'light' as const, sketch: true };

function fakeHost() {
  const posted: WebviewToHost[] = [];
  let listener: ((m: HostToWebview) => void) | undefined;
  const host: Host = {
    inVsCode: true,
    post: (m) => posted.push(m),
    onMessage: (fn) => ((listener = fn), () => (listener = undefined)),
    getState: () => undefined,
    setState: () => {},
  };
  return { host, posted, send: (m: HostToWebview) => act(() => listener?.(m)) };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function pointer(type: string, target: Element, init: MouseEventInit = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  target.dispatchEvent(ev);
}

describe('App', () => {
  it('renders the plan, its custom shapes and the toolbar', async () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    expect(posted[0]).toEqual({ type: 'ready' });
    send({ type: 'load', plan: plan(), settings });
    const text = container.textContent ?? '';
    expect(text).toContain('Add Stripe payments');
    expect(text).not.toContain('Approve');
    expect(text).toContain('PaymentService');
    expect(text).toContain('CONSTRAINT');
    expect(container.querySelectorAll('.pc-step')).toHaveLength(7);
    expect(container.querySelectorAll('.pc-node')).toHaveLength(9);
    expect(container.querySelectorAll('.pc-arrow')).toHaveLength(7);
  });

  it('adding a note from the top bar creates a sticky note', async () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    const before = plan().comments.length;
    const add = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Add note'),
    )!;
    act(() => add.click());
    // The note's text editor opens on the next frame.
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const editor = container.querySelector('textarea')!;
    expect(editor).toBeTruthy();
    act(() => {
      editor.value = 'check rate limits';
      editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    const edit = posted.filter((m) => m.type === 'edit').at(-1);
    expect(edit?.type === 'edit' && edit.plan.comments.length).toBe(before + 1);
  });

  it('selecting a step and pressing Delete removes it from the plan', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    const step = container.querySelector('[data-id="s6"]')!;
    act(() => {
      pointer('pointerdown', step);
      pointer('pointerup', step);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    const edit = posted.filter((m) => m.type === 'edit').at(-1);
    expect(edit?.type === 'edit' && edit.plan.steps.map((s) => s.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's7',
    ]);
  });

  it('shows a read-only banner for an invalid file and never posts edits', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    send({ type: 'invalid', errors: ['Malformed JSON: Unexpected token'], settings });
    expect(container.textContent).toContain('not valid');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })));
    expect(posted.filter((m) => m.type === 'edit')).toHaveLength(0);
  });

  it('asks the host to lay out elements that have no position', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    delete p.layout.s3;
    send({ type: 'load', plan: p, settings });
    expect(posted).toContainEqual({ type: 'relayout', force: false });
  });

  it('renders a 250-node plan', () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    for (let i = 0; i < 250; i++) {
      p.nodes.push({ id: `n${i}`, kind: 'component', label: `Node ${i}`, changeType: 'new' });
      p.layout[`n${i}`] = { x: (i % 20) * 240, y: 600 + Math.floor(i / 20) * 120, w: 200, h: 72 };
    }
    const t = performance.now();
    send({ type: 'load', plan: p, settings });
    expect(container.querySelectorAll('.pc-node')).toHaveLength(259);
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('opens the properties panel only from the Properties button', () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    const node = container.querySelector('.pc-node')!.closest('[data-id]')!;
    act(() => {
      pointer('pointerdown', node);
      pointer('pointerup', node);
    });
    expect(container.querySelector('.pc-inspector')).toBeNull();
    const props = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Properties'),
    )!;
    expect(props.disabled).toBe(false);
    act(() => props.click());
    expect(container.querySelector('.pc-inspector')).not.toBeNull();
  });

  it('blocks selected elements and offers to unblock the group', () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    const first = container.querySelector('[data-id="api"]')!;
    const second = container.querySelector('[data-id="web"]')!;
    act(() => {
      pointer('pointerdown', first);
      pointer('pointerup', first);
      pointer('pointerdown', second, { shiftKey: true });
      pointer('pointerup', second, { shiftKey: true });
    });
    const props = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Properties'),
    )!;
    act(() => props.click());
    const block = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Block')!;
    expect(block).toBeTruthy();
    act(() => block.click());
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Unblock'),
    ).toBeTruthy();
  });

  it('pans to elements an AI adds out of view', async () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    const world = () => container.querySelector('.pc-world')!.getAttribute('transform');
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    const before = world();
    const p = plan();
    p.revision += 1;
    p.nodes.push({ id: 'far', kind: 'component', label: 'Far away', changeType: 'new' });
    p.layout.far = { x: 6000, y: 6000, w: 200, h: 72 };
    send({ type: 'load', plan: p, settings });
    await act(() => new Promise<void>((r) => setTimeout(r, 700)));
    expect(world()).not.toBe(before);
  });

  it('changes the board background from the top bar and switches to the light palette', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings: { ...settings, theme: 'dark' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
    const open = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Background'),
    )!;
    act(() => open.click());
    const white = [...container.querySelectorAll('.pc-bg-option')].find(
      (b) => b.textContent === 'White',
    ) as HTMLButtonElement;
    act(() => white.click());
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--pc-bg')).toBe('#ffffff');
    const edit = posted.filter((m) => m.type === 'edit').at(-1);
    expect(edit?.type === 'edit' && edit.plan.background).toBe('white');
  });

  it('routed arrows have no fill (an unfilled polyline would paint a black wedge)', () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    const e = p.edges[0]!;
    const a = p.layout[e.from]!;
    const b = p.layout[e.to]!;
    e.route = {
      points: [
        { x: a.x + a.w, y: a.y },
        { x: a.x + a.w + 20, y: a.y },
        { x: a.x + a.w + 20, y: b.y + 200 },
        { x: b.x, y: b.y + 200 },
      ],
      from: a,
      to: b,
    };
    send({ type: 'load', plan: p, settings });
    const lines = container.querySelectorAll<SVGPolylineElement>(`[data-id="${e.id}"] polyline`);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.style.fill).toBe('none');
  });

  it('shows a text bar for selected text and applies a size from it', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    p.freeform = {
      shapes: [{ id: 'txt', type: 'text', text: 'Hello', x: 0, y: -300, w: 60, h: 24 }],
    };
    send({ type: 'load', plan: p, settings });
    expect(container.querySelector('.pc-text-bar')).toBeNull();
    const t = container.querySelector('[data-id="txt"]')!;
    act(() => {
      pointer('pointerdown', t);
      pointer('pointerup', t);
    });
    const bar = container.querySelector('.pc-text-bar')!;
    expect(bar).not.toBeNull();
    const large = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'L')!;
    act(() => large.click());
    const edit = posted.filter((m) => m.type === 'edit').at(-1);
    const shape =
      edit?.type === 'edit' &&
      (edit.plan.freeform as { shapes: { fontSize?: number; h: number }[] }).shapes[0];
    expect(shape && shape.fontSize).toBe(24);
    expect(shape && shape.h).toBeGreaterThan(24);
  });

  function selectNode(id: string) {
    const node = container.querySelector(`[data-id="${id}"]`)!;
    act(() => {
      pointer('pointerdown', node);
      pointer('pointerup', node);
    });
  }
  function clickButton(text: string) {
    const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes(text))!;
    act(() => b.click());
  }

  it('exports only the selection when something is selected', async () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    selectNode('api');
    clickButton('Export');
    expect(container.textContent).toContain('Only the 1 selected item');
    clickButton('SVG image');
    await act(() => Promise.resolve());
    const out = posted.find((m) => m.type === 'export');
    expect(out?.type === 'export' && out.selection).toBe(true);
    const svg = out?.type === 'export' ? out.data : '';
    expect(svg).toContain('Orders API');
    expect(svg).not.toContain('Checkout page');
  });

  it('exports the whole board with nothing selected', async () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    clickButton('Export');
    expect(container.textContent).toContain('The whole board');
    clickButton('SVG image');
    await act(() => Promise.resolve());
    const out = posted.find((m) => m.type === 'export');
    expect(out?.type === 'export' && out.selection).toBe(false);
    expect(out?.type === 'export' ? out.data : '').toContain('Checkout page');
  });

  it('a label typed in Properties reaches the board, even when the canvas is clicked right after', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    selectNode('api');
    clickButton('Properties');
    const panel = container.querySelector('.pc-inspector')!;
    expect(panel.textContent).not.toMatch(/Kind|Change|Risk/);
    const input = panel.querySelector<HTMLInputElement>('input[aria-label="Label"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Gateway');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Click empty canvas: deselects and closes the panel without blurring the input.
    const svg = container.querySelector('svg.pc-canvas, .pc-canvas-wrap svg')!;
    act(() => {
      pointer('pointerdown', svg);
      pointer('pointerup', svg);
    });
    expect(container.querySelector('.pc-inspector')).toBeNull();
    const edit = posted.filter((m) => m.type === 'edit').at(-1);
    expect(edit?.type === 'edit' && edit.plan.nodes.find((n) => n.id === 'api')!.label).toBe(
      'Gateway',
    );
    expect(container.querySelector('[data-id="api"]')!.textContent).toContain('Gateway');
  });

  /** Screen point of a world point, from the canvas camera transform. */
  function toScreen(x: number, y: number) {
    const t = container.querySelector('.pc-world')!.getAttribute('transform')!;
    const [, tx, ty, z] = /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/
      .exec(t)!
      .map(Number);
    return { clientX: x * z! + tx!, clientY: y * z! + ty! };
  }

  it('double-clicking a box edits its text, even though the svg is the event target', () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    send({ type: 'load', plan: p, settings });
    const r = p.layout.api!;
    const svg = container.querySelector('.pc-canvas-wrap svg')!;
    // Browsers retarget dblclick to the svg because it holds pointer capture.
    act(() => {
      svg.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, ...toScreen(r.x + r.w / 2, r.y + r.h / 2) }),
      );
    });
    const editor = container.querySelector<HTMLTextAreaElement>('textarea.pc-text-editor')!;
    expect(editor).not.toBeNull();
    expect(editor.value).toBe('Orders API');
  });

  it('the text bar sets the font size of a diagram box and grows it to fit', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    send({ type: 'load', plan: p, settings });
    selectNode('api');
    const bar = container.querySelector('.pc-text-bar')!;
    expect(bar).not.toBeNull();
    const xl = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'XL')!;
    act(() => xl.click());
    const edit = posted.filter((m) => m.type === 'edit').at(-1);
    const api = edit?.type === 'edit' ? edit.plan : undefined;
    expect(api?.nodes.find((n) => n.id === 'api')!.fontSize).toBe(36);
    expect(api!.layout.api!.h).toBeGreaterThan(p.layout.api!.h);
  });
});

describe('code sync', () => {
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;
  const select = (id: string, shiftKey = false) => {
    const el = container.querySelector(`[data-id="${id}"]`)!;
    act(() => {
      pointer('pointerdown', el, { shiftKey });
      pointer('pointerup', el, { shiftKey });
    });
  };
  const drift = {
    linked: true,
    scannedAt: '2026-11-01T10:00:00.000Z',
    commit: 'abc1234',
    drift: [
      {
        kind: 'missing' as const,
        severity: 'error' as const,
        targetId: 'payments-file',
        message: '"payments.ts" points to server/src/payments/payments.ts, which no longer exists.',
      },
      {
        kind: 'edge-unbacked' as const,
        severity: 'warning' as const,
        targetId: 'e-web-api',
        message: 'Arrow "Checkout page" -> "Orders API": no import.',
      },
      {
        kind: 'unmapped' as const,
        severity: 'info' as const,
        message: '3 files in lib are not on the diagram.',
      },
    ],
  };

  it('marks drifted boxes and arrows, counts drift on the Code button, and lists it in the panel', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    send({ type: 'code', state: drift });

    expect(container.querySelectorAll('.pc-drift-outline')).toHaveLength(1);
    expect(container.querySelector('.pc-drift')!.textContent).toContain('⚠ missing');
    expect(container.querySelector('.pc-drift-error')).not.toBeNull();
    expect(
      container.querySelector('[stroke-dasharray], .pc-arrow [style*="dasharray"]'),
    ).not.toBeNull();
    expect(button('Code').querySelector('.pc-badge')!.textContent).toBe('2'); // info is not counted

    act(() => button('Code').click());
    const panel = container.querySelector('.pc-code-panel')!;
    expect(panel.textContent).toContain('abc1234');
    // Problems are listed; the note (an expected difference) waits behind a toggle.
    expect(panel.querySelectorAll('.pc-drift-item')).toHaveLength(2);
    act(() => button('1 note').click());
    expect(panel.querySelectorAll('.pc-drift-item')).toHaveLength(3);
    act(() => (panel.querySelector('.pc-linklike') as HTMLButtonElement).click());
    act(() => button('Properties').click());
    expect(container.querySelector('.pc-inspector:not(.pc-code-panel)')!.textContent).toContain(
      'which no longer exists',
    );

    act(() => button('Sync from code').click());
    act(() => button('Explain & fix drift').click());
    expect(posted).toContainEqual({ type: 'syncFromCode' });
    expect(posted).toContainEqual({ type: 'askAi', request: 'fix-drift', ids: ['payments-file'] });
  });

  it('offers to generate from code when nothing is linked', () => {
    const { host, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    send({ type: 'code', state: { linked: false, drift: [] } });
    act(() => button('Code').click());
    expect(button('Generate from code')).toBeTruthy();
    expect(button('Code').querySelector('.pc-badge')).toBeNull();
  });

  it('shows what the code says about a box and opens its code', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    send({ type: 'code', state: { linked: true, drift: [], scannedAt: 'x' } });
    select('routes');
    act(() => button('Properties').click());
    expect(posted).toContainEqual({ type: 'codeInfo', nodeId: 'routes' });
    send({
      type: 'codeInfo',
      nodeId: 'routes',
      info: {
        exists: true,
        files: 1,
        exports: ['ordersRouter'],
        routes: ['POST /orders'],
        models: [],
        packages: ['express'],
        tests: ['server/test/orders.test.ts'],
        owners: [{ name: 'Sam', commits: 12 }],
        commits: [{ hash: 'f00ba12', author: 'Sam', date: '2026-10-30', subject: 'Add refunds' }],
      },
    });
    const text = container.querySelector('.pc-inspector')!.textContent!;
    for (const want of [
      'Sam (12)',
      'Add refunds',
      'POST /orders',
      'server/test/orders.test.ts',
      'express',
    ])
      expect(text).toContain(want);
    act(() => button('Open code').click());
    expect(posted).toContainEqual({ type: 'openCode', nodeId: 'routes' });
  });

  it('shows a step’s verification on its card and verifies from Properties', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    const p = plan();
    p.steps[0]!.verification = {
      status: 'failed',
      at: new Date().toISOString(),
      command: 'npm test',
      exitCode: 1,
      files: ['server/src/payments/payments.ts'],
      reasons: ['`npm test` exited with code 1.'],
      diffStat: ' server/src/payments/payments.ts | 4 ++--',
    };
    send({ type: 'load', plan: p, settings });
    expect(container.querySelector(`[data-id="${p.steps[0]!.id}"]`)!.textContent).toContain(
      '✕ tests failed',
    );
    select(p.steps[0]!.id);
    act(() => button('Properties').click());
    const text = container.querySelector('.pc-inspector')!.textContent!;
    expect(text).toContain('$ npm test -> exit 1');
    expect(text).toContain('payments.ts | 4 ++--');
    act(() => button('Verify again').click());
    act(() => button('Diff & output').click());
    expect(posted).toContainEqual({ type: 'verifyStep', stepId: p.steps[0]!.id });
    expect(posted).toContainEqual({ type: 'openVerification', stepId: p.steps[0]!.id });
  });

  it('hands a selected flow to the AI to implement', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    select('web');
    select('api', true);
    act(() => button('Properties').click());
    act(() => button('Ask AI to implement this flow').click());
    expect(posted).toContainEqual({ type: 'askAi', request: 'implement', ids: ['web', 'api'] });
  });
});

describe('plan controls', () => {
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;
  const lastEdit = (posted: WebviewToHost[]) =>
    [...posted]
      .reverse()
      .find((m): m is Extract<WebviewToHost, { type: 'edit' }> => m.type === 'edit')!;

  it('sets the plan status from the Code panel', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    act(() => button('Code').click());
    const select = container.querySelector('select[aria-label="Plan status"]') as HTMLSelectElement;
    expect(select.value).toBe('awaiting_approval');
    act(() => {
      select.value = 'in_progress';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(lastEdit(posted).plan.status).toBe('in_progress');
  });
});

describe('code sync toggle', () => {
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;
  const lastEdit = (posted: WebviewToHost[]) =>
    [...posted]
      .reverse()
      .find((m): m is Extract<WebviewToHost, { type: 'edit' }> => m.type === 'edit')!;
  const drifted = {
    linked: true,
    drift: [
      {
        kind: 'missing' as const,
        severity: 'error' as const,
        targetId: 'payments-file',
        message: 'gone',
      },
    ],
  };

  it('switches a board to a plain whiteboard and hides everything about code', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: plan(), settings });
    send({ type: 'code', state: drifted });
    expect(container.querySelector('.pc-drift-outline')).not.toBeNull();

    act(() => button('Code').click());
    const off = [...container.querySelectorAll('.pc-segment')].find(
      (b) => b.textContent === 'Off',
    ) as HTMLButtonElement;
    act(() => off.click());
    expect(lastEdit(posted).plan.codeSync).toBe('off');

    // The board now says it is off, even before the host's next drift check arrives.
    expect(container.querySelector('.pc-drift-outline')).toBeNull();
    expect(button('Code').querySelector('.pc-badge')).toBeNull();
    expect(button('Code').querySelector('.pc-mode-off')).not.toBeNull();
    const panel = container.querySelector('.pc-code-panel')!;
    expect(panel.textContent).toContain('plain whiteboard');
    expect(panel.textContent).not.toContain('Sync from code');

    // Back to auto clears the setting.
    const auto = [...container.querySelectorAll('.pc-segment')].find(
      (b) => b.textContent === 'Auto',
    ) as HTMLButtonElement;
    act(() => auto.click());
    expect(lastEdit(posted).plan.codeSync).toBeUndefined();
  });

  it('opens an off board without drift, code facts or verification', () => {
    const { host, posted, send } = fakeHost();
    act(() => root.render(<App host={host} />));
    send({ type: 'load', plan: { ...plan(), codeSync: 'off' }, settings });
    send({ type: 'code', state: { linked: true, drift: [], off: true } });
    const el = container.querySelector('[data-id="routes"]')!;
    act(() => {
      pointer('pointerdown', el);
      pointer('pointerup', el);
    });
    act(() => button('Properties').click());
    expect(posted.some((m) => m.type === 'codeInfo')).toBe(false);
    expect(container.querySelector('.pc-inspector')!.textContent).toContain('Open code');
  });
});
