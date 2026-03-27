import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFreeform } from '@agentic-whiteboard/shared';
import {
  AGENT_IDLE_MS,
  isAgentWorking,
  readAgentActivity,
  readPlan,
  recordActiveBoard,
} from '@agentic-whiteboard/shared/node';
import * as tools from '../src/tools.js';
import type { Workspace } from '../src/workspace.js';

let root: string;
let ws: Workspace;
const board = (name = 'whiteboard') => path.join(root, `${name}.whiteboard`);
const shapes = async (file = board()) =>
  parseFreeform((await readPlan(file)).freeform).freeform.shapes;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-whiteboard-mcp-'));
  ws = { root: async () => root, plansFolder: '.agentic-whiteboard' };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const diagram = {
  nodes: [
    { id: 'web', label: 'Web app' },
    { label: 'Auth Service' },
    { id: 'db', label: 'Postgres', kind: 'external' as const },
  ],
  edges: [
    { from: 'web', to: 'Auth Service', label: 'login' },
    { from: 'auth-service', to: 'db' },
  ],
};

describe('drawing without a board', () => {
  it('creates whiteboard.whiteboard and lays out the diagram', async () => {
    const out = await tools.drawDiagram(ws, diagram);
    expect(out.text).toContain('New box ids: web, auth-service, db');
    const plan = await readPlan(board());
    expect(plan.edges.map((e) => [e.from, e.to, e.label])).toEqual([
      ['web', 'auth-service', 'login'],
      ['auth-service', 'db', undefined],
    ]);
    expect(Object.keys(plan.layout).sort()).toEqual(['auth-service', 'db', 'web']);
    expect(plan.status).toBe('drafting');
  });

  it('read_whiteboard on an empty workspace explains what to do', async () => {
    await expect(tools.readWhiteboard(ws, {})).rejects.toThrow(/create_whiteboard/);
  });
});

describe('board resolution', () => {
  it('refuses boards and folders outside the workspace', async () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.whiteboard`);
    await fs.writeFile(outside, '');
    try {
      await expect(tools.readWhiteboard(ws, { board: outside })).rejects.toThrow(
        /outside the workspace/,
      );
      await expect(tools.readWhiteboard(ws, { board: '../x.whiteboard' })).rejects.toThrow(
        /outside the workspace/,
      );
      await expect(tools.createWhiteboard(ws, { name: 'Escape', folder: '..' })).rejects.toThrow(
        /outside the workspace/,
      );
      expect(await fs.readFile(outside, 'utf8')).toBe('');
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('turns an empty .whiteboard file the user just created into a blank board', async () => {
    await fs.mkdir(path.join(root, 'docs'));
    const file = path.join(root, 'docs', 'system design.whiteboard');
    await fs.writeFile(file, '');
    const out = await tools.readWhiteboard(ws, {});
    expect(out.text).toContain('Whiteboard "system design" (docs/system design.whiteboard)');
    expect(out.text).toContain('The board is empty.');
    expect((await readPlan(file)).id).toBe('system-design');
  });

  it('finds boards by path, file name and title', async () => {
    await tools.createWhiteboard(ws, { name: 'Checkout flow', folder: 'docs' });
    await tools.createWhiteboard(ws, { name: 'Other' });
    for (const ref of [
      'docs/checkout-flow.whiteboard',
      'docs/checkout-flow',
      'checkout-flow',
      'Checkout flow',
    ])
      expect((await tools.readWhiteboard(ws, { board: ref })).text).toContain('"Checkout flow"');
    await expect(tools.readWhiteboard(ws, { board: 'nope' })).rejects.toThrow(
      /Known boards: .*checkout-flow.whiteboard/,
    );
  });

  it('prefers the board the user focused in VS Code over the newest one', async () => {
    await tools.createWhiteboard(ws, { name: 'Focused' });
    await new Promise((r) => setTimeout(r, 20));
    await tools.createWhiteboard(ws, { name: 'Newer' });
    await recordActiveBoard(board('focused'));
    await tools.addShapes(ws, { shapes: [{ type: 'rect', text: 'hi' }] });
    expect(await shapes(board('focused'))).toHaveLength(1);
    expect(await shapes(board('newer'))).toHaveLength(0);
  });

  it('lists boards, skipping node_modules', async () => {
    await tools.createWhiteboard(ws, { name: 'Main' });
    await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'x', 'dep.whiteboard'), '');
    const out = await tools.listWhiteboards(ws);
    expect(out.text).toContain('"Main" (main.whiteboard): empty');
    expect(out.text).not.toContain('dep.whiteboard');
  });
});

describe('add_shapes', () => {
  it('places shapes in free space and binds arrows to them', async () => {
    await tools.drawDiagram(ws, diagram);
    const out = await tools.addShapes(ws, {
      shapes: [
        { type: 'ellipse', id: 'start', text: 'Start', color: 'green' },
        { type: 'sticky', text: 'Remember rate limits' },
        { type: 'arrow', from: 'start', to: 'web', text: 'opens' },
        { type: 'text', text: 'Title', x: 10, y: -100, fontSize: 32 },
      ],
    });
    expect(out.text).toContain('Added 4 shapes (start, note, arrow, text)');
    const plan = await readPlan(board());
    const list = parseFreeform(plan.freeform).freeform.shapes;
    const start = list.find((s) => s.id === 'start')!;
    const diagramBottom = Math.max(
      ...['web', 'auth-service', 'db'].map((id) => plan.layout[id]!.y + plan.layout[id]!.h),
    );
    expect(start.y).toBeGreaterThan(diagramBottom);
    expect(start.color).toBe('green');
    const arrow = list.find((s) => s.type === 'arrow');
    expect(arrow).toMatchObject({
      start: { bindTo: 'start' },
      end: { bindTo: 'web' },
      label: 'opens',
      head: 'arrow',
    });
    expect(plan.comments).toEqual([{ id: 'note', text: 'Remember rate limits' }]);
    expect(list.find((s) => s.id === 'text')).toMatchObject({ x: 10, y: -100, fontSize: 32 });
  });

  it('rejects arrows to unknown elements without writing anything', async () => {
    await tools.addShapes(ws, { shapes: [{ type: 'rect', id: 'a' }] });
    await expect(
      tools.addShapes(ws, {
        shapes: [
          { type: 'rect', id: 'b' },
          { type: 'arrow', from: 'a', to: 'zzz' },
        ],
      }),
    ).rejects.toThrow(/no element "zzz"/);
    expect((await shapes()).map((s) => s.id)).toEqual(['a']);
  });
});

describe('update, remove, clear', () => {
  it('updates text, color and position of any element', async () => {
    await tools.drawDiagram(ws, diagram);
    await tools.addShapes(ws, {
      shapes: [
        { type: 'rect', id: 'box', text: 'old' },
        { type: 'sticky', id: 'n1', text: 'x' },
      ],
    });
    await tools.updateElements(ws, {
      updates: [
        { id: 'web', text: 'Website', x: 500 },
        { id: 'box', text: 'new', color: 'red', fill: 'solid', y: 999 },
        { id: 'n1', text: 'y' },
      ],
      title: 'Renamed',
    });
    const plan = await readPlan(board());
    expect(plan.title).toBe('Renamed');
    expect(plan.nodes.find((n) => n.id === 'web')!.label).toBe('Website');
    expect(plan.layout.web!.x).toBe(500);
    expect(parseFreeform(plan.freeform).freeform.shapes[0]).toMatchObject({
      text: 'new',
      color: 'red',
      fill: 'solid',
      y: 999,
    });
    expect(plan.comments[0]!.text).toBe('y');
    await expect(
      tools.updateElements(ws, { updates: [{ id: 'ghost', text: 'x' }] }),
    ).rejects.toThrow(/No element "ghost"/);
  });

  it('styles text: size, bold and alignment on text and boxes', async () => {
    await tools.addShapes(ws, {
      shapes: [
        { type: 'text', id: 't', text: 'Title', fontSize: 36, bold: true },
        { type: 'rect', id: 'r', text: 'Box', align: 'left' },
      ],
    });
    const [t, r] = await shapes();
    expect(t).toMatchObject({ fontSize: 36, bold: true });
    expect(t!.h).toBeGreaterThan(36);
    expect(r).toMatchObject({ align: 'left' });
    expect('fontSize' in r!).toBe(false);
    await tools.updateElements(ws, {
      updates: [{ id: 't', fontSize: 14, bold: false, align: 'center' }],
    });
    const [small] = await shapes();
    expect(small).toMatchObject({ fontSize: 14, bold: false, align: 'center' });
    expect(small!.h).toBeLessThan(36);
    expect((await tools.readWhiteboard(ws, {})).text).toContain('[text] "Title" at');
    expect((await tools.readWhiteboard(ws, {})).text).toContain('14px, center aligned');
    await tools.addShapes(ws, { shapes: [{ type: 'arrow', id: 'a', from: 't', to: 'r' }] });
    await expect(
      tools.updateElements(ws, { updates: [{ id: 'a', fontSize: 20 }] }),
    ).rejects.toThrow(/text size, bold and align apply to/);
  });

  it('styles the text of diagram boxes and sticky notes', async () => {
    await tools.drawDiagram(ws, diagram);
    await tools.addShapes(ws, { shapes: [{ type: 'sticky', id: 'n', text: 'remember' }] });
    const before = (await readPlan(board())).layout.web!.h;
    await tools.updateElements(ws, {
      updates: [
        { id: 'web', fontSize: 36, bold: false },
        { id: 'n', fontSize: 24, align: 'center' },
      ],
    });
    const plan = await readPlan(board());
    expect(plan.nodes.find((x) => x.id === 'web')).toMatchObject({ fontSize: 36, bold: false });
    expect(plan.layout.web!.h).toBeGreaterThan(before);
    expect(plan.comments[0]).toMatchObject({ fontSize: 24, align: 'center' });
  });

  it('sets and resets the board background', async () => {
    await tools.createWhiteboard(ws, { name: 'Whiteboard' });
    const out = await tools.updateElements(ws, { updates: [], background: 'white' });
    expect(out.text).toContain('Updated the background');
    expect((await readPlan(board())).background).toBe('white');
    await tools.updateElements(ws, { updates: [], background: 'auto' });
    expect((await readPlan(board())).background).toBeUndefined();
    await expect(tools.updateElements(ws, { updates: [] })).rejects.toThrow(/Nothing to update/);
  });

  it('removing a box removes its arrows; clear empties the board', async () => {
    await tools.drawDiagram(ws, diagram);
    await tools.addShapes(ws, {
      shapes: [
        { type: 'rect', id: 'r' },
        { type: 'arrow', from: 'r', to: 'db' },
      ],
    });
    await tools.removeElements(ws, { ids: ['db'] });
    let plan = await readPlan(board());
    expect(plan.nodes.map((n) => n.id)).toEqual(['web', 'auth-service']);
    expect(plan.edges.map((e) => e.to)).toEqual(['auth-service']);
    expect((await shapes()).map((s) => s.id)).toEqual(['r']);
    await expect(tools.removeElements(ws, { ids: ['nope'] })).rejects.toThrow(
      /Nothing was removed/,
    );

    await tools.clearWhiteboard(ws, {});
    plan = await readPlan(board());
    expect(plan.nodes).toEqual([]);
    expect(await shapes()).toEqual([]);
  });

  it('read_whiteboard describes every element with ids', async () => {
    await tools.drawDiagram(ws, diagram);
    await tools.addShapes(ws, {
      shapes: [
        { type: 'frame', id: 'f', text: 'Backend' },
        { type: 'arrow', from: 'f', to: 'web' },
      ],
    });
    const out = (await tools.readWhiteboard(ws, {})).text;
    expect(out).toContain('- web [component] "Web app" at (');
    expect(out).toContain('- e-web-auth-service: web -> auth-service "login"');
    expect(out).toContain('- f [frame] "Backend"');
    expect(out).toContain('[arrow] f (f) -> web (Web app)');
  });
});

describe('code sync', () => {
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  beforeEach(async () => {
    await write(
      'server/orders/routes.ts',
      "import { pay } from '../payments/pay';\nexport const r = pay;",
    );
    await write('server/orders/model.ts', 'export const Order = 1;');
    await write(
      'server/payments/pay.ts',
      "import Stripe from 'stripe';\nexport const pay = Stripe;",
    );
    await write(
      'server/payments/refund.ts',
      "import { pay } from './pay';\nexport const refund = pay;",
    );
  });

  it('generates a linked architecture, then re-syncs without losing user edits', async () => {
    const out = await tools.generateArchitecture(ws, {});
    expect(out.text).toMatch(/Added 3 boxes/);
    let plan = await readPlan(board());
    expect(plan.title).toBe('Architecture');
    expect(plan.codebase?.scannedAt).toBeTruthy();
    expect(plan.codeSync).toBe('on');
    expect(plan.nodes.map((n) => [n.id, n.label, n.path ?? n.package])).toEqual([
      ['code-server-orders', 'Orders', 'server/orders'],
      ['code-server-payments', 'Payments', 'server/payments'],
      ['sys-stripe', 'Stripe', 'stripe'],
    ]);
    expect(plan.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'code-server-orders->code-server-payments',
      'code-server-payments->sys-stripe',
    ]);
    // Laid out as one graph: every arrow has a route around the boxes.
    expect(plan.edges.every((e) => e.route)).toBe(true);

    await tools.updateElements(ws, {
      updates: [{ id: 'code-server-payments', text: 'Payment service' }],
    });
    await tools.drawDiagram(ws, { nodes: [{ id: 'web', label: 'Web app' }], edges: [] });
    await write(
      'server/payments/pay.ts',
      "import { Client } from '@adyen/api-library';\nexport const pay = Client;",
    );

    const drift = await tools.checkDrift(ws, {});
    expect(drift.text).toMatch(
      /deps-changed \(code-server-payments\).*now imports @adyen\/api-library/,
    );
    expect(drift.text).toMatch(/package-unused \(sys-stripe\)/);

    // Outdated generated boxes go without asking; the user's name and box stay.
    const resync = await tools.generateArchitecture(ws, {});
    expect(resync.text).toMatch(/removed 1 outdated \(sys-stripe\)/);
    plan = await readPlan(board());
    expect(plan.nodes.find((n) => n.id === 'code-server-payments')!.label).toBe('Payment service');
    expect(plan.nodes.some((n) => n.id === 'web')).toBe(true);
    expect(plan.nodes.find((n) => n.id === 'sys-adyen')!.label).toBe('Adyen');
    expect((await tools.checkDrift(ws, {})).text).toContain('No drift');
  });

  it('links boxes to code with draw_diagram and update_elements, and shows it in read_whiteboard', async () => {
    await tools.drawDiagram(ws, {
      nodes: [
        { id: 'pay', label: 'Payments', path: 'server\\payments\\pay.ts', symbol: 'pay' },
        { id: 'psp', label: 'Stripe', kind: 'external', package: 'stripe' },
      ],
      edges: [{ from: 'pay', to: 'psp' }],
      steps: [{ title: 'Add refunds', nodes: ['Payments'] }],
    });
    await tools.updateElements(ws, { updates: [{ id: 'psp', package: 'stripe-node' }] });
    const text = (await tools.readWhiteboard(ws, {})).text;
    expect(text).toContain('pay [component] "Payments"');
    expect(text).toContain('-> server/payments/pay.ts#pay');
    expect(text).toContain('(package stripe-node)');
    expect(text).toMatch(/step-add-refunds #1 "Add refunds" \[pending\] touches pay/);
    await expect(
      tools.updateElements(ws, { updates: [{ id: 'step-add-refunds', path: 'x' }] }),
    ).rejects.toThrow(/not a diagram box/);
    expect((await tools.checkDrift(ws, {})).text).toMatch(
      /no code in server\/payments\/pay.ts imports "stripe-node"/,
    );
  });

  it('verifies a step and attaches the evidence', async () => {
    await tools.drawDiagram(ws, {
      nodes: [{ id: 'pay', label: 'Payments', path: 'server/payments' }],
      edges: [],
      steps: [{ id: 's1', title: 'Refunds', nodes: ['pay'] }],
    });
    const ok = await tools.verifyStep(ws, { step: 'Refunds', command: 'node -e "0"' });
    expect(ok.text).toMatch(/Step "Refunds" is VERIFIED/);
    let step = (await readPlan(board())).steps[0]!;
    expect(step.status).toBe('done');
    expect(step.verification).toMatchObject({
      status: 'verified',
      command: 'node -e "0"',
      exitCode: 0,
    });

    const bad = await tools.verifyStep(ws, {
      step: 's1',
      command: 'node -e "console.log(\'boom\');process.exit(2)"',
    });
    expect(bad.text).toMatch(/FAILED[\s\S]*exit code 2[\s\S]*boom/);
    step = (await readPlan(board())).steps[0]!;
    expect(step.status).toBe('failed');
    await expect(tools.verifyStep(ws, { step: 'nope' })).rejects.toThrow(/Steps: s1 \("Refunds"\)/);
  });

  it('says there is nothing to check on a board without code links', async () => {
    await tools.drawDiagram(ws, diagram);
    expect((await tools.checkDrift(ws, {})).text).toMatch(/no boxes linked to code/);
  });
});

describe('plan -> implement -> verify -> change: the board follows the code', () => {
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  const drift = async () => (await tools.checkDrift(ws, {})).text;

  it('plans a login flow, implements and verifies it, then flags each later architecture change', async () => {
    // 1. Plan: the files do not exist yet.
    const planned = await tools.drawDiagram(ws, {
      nodes: [
        { id: 'form', label: 'Login form', kind: 'file', path: 'src/ui/login-form.ts' },
        { id: 'auth', label: 'Auth service', path: 'src/auth' },
        { id: 'store', label: 'Session store', path: 'src/session' },
        { id: 'idp', label: 'Auth0', kind: 'external', package: 'auth0' },
        { id: 'docs', label: 'Notes' },
      ],
      edges: [
        { from: 'form', to: 'auth' },
        { from: 'auth', to: 'store' },
        { from: 'auth', to: 'idp' },
      ],
      steps: [
        { id: 's1', title: 'Auth service and session', nodes: ['auth', 'store', 'idp'] },
        { id: 's2', title: 'Login form', nodes: ['form'] },
      ],
    });
    expect(planned.text).toMatch(/"Notes" has no path/);
    expect(planned.text).toMatch(/Planned as new \(no code yet\): form, auth, store/);
    let plan = await readPlan(board());
    expect(plan.nodes.find((n) => n.id === 'auth')!.changeType).toBe('new');
    // A plan that has not started is not drift, even though nothing is built.
    expect(await drift()).toContain('No drift');
    await tools.updateElements(ws, { status: 'approved' });
    expect(await drift()).toMatch(/not-implemented \(auth\)/);

    // 2. Implement step 1 and verify it.
    await write('src/session/store.ts', 'export const sessions = new Map();');
    await write(
      'src/auth/service.ts',
      "import { WebAuth } from 'auth0';\nimport { sessions } from '../session/store';\nexport const login = () => { new WebAuth(); sessions.clear(); };",
    );
    const v1 = await tools.verifyStep(ws, { step: 's1', command: 'node -e "0"' });
    expect(v1.text).toMatch(/VERIFIED[\s\S]*Plan status: in_progress[\s\S]*now the baseline/);
    plan = await readPlan(board());
    expect(plan.nodes.find((n) => n.id === 'auth')!.deps).toEqual(['auth0']);
    expect(plan.edges.find((e) => e.id === 'e-auth-store')!.imported).toBe(true);
    expect(plan.codebase?.links).toEqual(['auth->store']);

    // Step 2.
    await write(
      'src/ui/login-form.ts',
      "import { login } from '../auth/service';\nexport const submit = login;",
    );
    const v2 = await tools.verifyStep(ws, { step: 's2', command: 'node -e "0"' });
    expect(v2.text).toMatch(/VERIFIED[\s\S]*Plan status: done/);
    expect(await drift()).toContain('No drift');

    // 3. Change the code: swap the identity provider, drop the session import, and make the
    // session store call back into auth (a new dependency the diagram does not show).
    await write(
      'src/auth/service.ts',
      "import { Clerk } from '@clerk/backend';\nexport const login = () => new Clerk();",
    );
    await write(
      'src/session/store.ts',
      "import { login } from '../auth/service';\nexport const sessions = new Map([[1, login]]);",
    );
    const report = await drift();
    expect(report).toMatch(
      /\[warning\] deps-changed \(auth\): "Auth service" now imports @clerk\/backend and no longer imports auth0/,
    );
    expect(report).toMatch(/\[warning\] package-unused \(idp\)/);
    expect(report).toMatch(
      /\[warning\] edge-unbacked \(e-auth-store\): .*the import behind it is gone/,
    );
    expect(report).toMatch(
      /\[warning\] edge-missing \(store\): "Session store" now imports "Auth service"/,
    );

    // A built box whose file is deleted is missing, not "not implemented".
    await fs.rm(path.join(root, 'src/ui/login-form.ts'));
    expect(await drift()).toMatch(/\[error\] missing \(form\)/);
  });

  it('syncing from code reuses the planned boxes instead of drawing duplicates', async () => {
    await write(
      'src/auth/service.ts',
      "import { sessions } from '../session/store';\nexport const a = sessions;",
    );
    await write('src/auth/tokens.ts', 'export const t = 1;');
    await write('src/session/store.ts', 'export const sessions = 1;');
    await write('src/session/cookie.ts', 'export const c = 1;');
    await tools.drawDiagram(ws, {
      nodes: [
        { id: 'auth', label: 'Auth service', path: 'src/auth' },
        { id: 'store', label: 'Session store', path: 'src/session' },
      ],
      edges: [{ from: 'auth', to: 'store', label: 'reads' }],
    });
    const out = await tools.generateArchitecture(ws, {});
    expect(out.text).toMatch(/kept as drawn: 2 boxes linked to the code/);
    const plan = await readPlan(board());
    expect(plan.nodes.map((n) => n.id)).toEqual(['auth', 'store']);
    expect(plan.nodes.find((n) => n.id === 'auth')!.label).toBe('Auth service');
    // The hand-drawn arrow already shows the import, so no second arrow is added.
    expect(plan.edges.map((e) => [e.id, e.label, e.imported])).toEqual([
      ['e-auth-store', 'reads', true],
    ]);
    expect(await drift()).toContain('No drift');
  });

  it('sets a box’s change type and the plan status with update_elements', async () => {
    await write('src/a.ts', 'export const a = 1;');
    await tools.drawDiagram(ws, { nodes: [{ id: 'a', label: 'A', path: 'src/a.ts' }], edges: [] });
    expect((await readPlan(board())).nodes[0]!.changeType).toBe('unchanged');
    await tools.updateElements(ws, {
      updates: [{ id: 'a', changeType: 'modify' }],
      status: 'in_progress',
    });
    const plan = await readPlan(board());
    expect(plan.nodes[0]!.changeType).toBe('modify');
    expect(plan.status).toBe('in_progress');
  });
});

describe('paths from agents', () => {
  it('stores absolute paths inside the workspace as repo-relative', async () => {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;');
    await tools.drawDiagram(ws, {
      nodes: [{ id: 'a', label: 'A', path: path.join(root, 'src', 'a.ts') }],
      edges: [],
    });
    await tools.updateElements(ws, {
      updates: [{ id: 'a', path: path.join(root, 'src') + path.sep }],
    });
    const node = (await readPlan(board())).nodes[0]!;
    expect(node.path).toBe('src');
    expect(node.changeType).toBe('unchanged'); // it existed, so it is not planned as new
  });
});

describe('code sync off: a plain whiteboard', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), "import Stripe from 'stripe';");
    await tools.createWhiteboard(ws, { name: 'Team explainer' });
    await tools.updateElements(ws, { board: 'Team explainer', codeSync: 'off' });
  });
  const explainer = 'Team explainer';

  it('tells the agent, keeps drawn boxes as sketches, and refuses code actions', async () => {
    const read = (await tools.readWhiteboard(ws, { board: explainer })).text;
    expect(read).toMatch(/Code sync: OFF\. This is a plain whiteboard/);

    const drawn = await tools.drawDiagram(ws, {
      board: explainer,
      nodes: [
        { id: 'pay', label: 'Payments', path: 'src/payments.ts' },
        { id: 'psp', label: 'Stripe', kind: 'external', package: 'stripe' },
        { id: 'idea', label: 'Idea' },
      ],
      edges: [{ from: 'pay', to: 'psp' }],
    });
    expect(drawn.text).toMatch(/links only open files on click/);
    expect(drawn.text).not.toMatch(/has no path|Planned as new/);
    const plan = await readPlan(path.join(root, 'team-explainer.whiteboard'));
    expect(plan.codeSync).toBe('off');
    // Not a plan: nothing is "new", though src/payments.ts does not exist.
    expect(plan.nodes.find((n) => n.id === 'pay')!.changeType).toBe('unchanged');

    expect((await tools.checkDrift(ws, { board: explainer })).text).toMatch(/Code sync is off/);
    await expect(tools.generateArchitecture(ws, { board: explainer })).rejects.toThrow(
      /Code sync is off/,
    );
    await tools.drawDiagram(ws, {
      board: explainer,
      nodes: [],
      edges: [],
      steps: [{ id: 's', title: 'S', nodes: [] }],
    });
    await expect(tools.verifyStep(ws, { board: explainer, step: 's' })).rejects.toThrow(
      /Code sync is off/,
    );
  });

  it('switches between modes with update_elements; auto clears the setting', async () => {
    const file = path.join(root, 'team-explainer.whiteboard');
    await tools.updateElements(ws, { board: explainer, codeSync: 'on' });
    expect((await readPlan(file)).codeSync).toBe('on');
    expect((await tools.readWhiteboard(ws, { board: explainer })).text).toMatch(/Code sync: ON/);
    await tools.updateElements(ws, { board: explainer, codeSync: 'auto' });
    expect((await readPlan(file)).codeSync).toBeUndefined();
  });

  it('refuses to fill the off board by default, and marks a new generated board as on', async () => {
    // With no board named, the most recent one (the explainer) is used: it stays untouched.
    await expect(tools.generateArchitecture(ws, {})).rejects.toThrow(/use another board/);
    await tools.createWhiteboard(ws, { name: 'Architecture' });
    await tools.generateArchitecture(ws, { board: 'Architecture' });
    expect((await readPlan(path.join(root, 'architecture.whiteboard'))).codeSync).toBe('on');
  });
});

describe('verify_step with long and cancelled test runs', () => {
  beforeEach(async () => {
    await tools.drawDiagram(ws, {
      nodes: [],
      edges: [],
      steps: [{ id: 's', title: 'S', nodes: [] }],
    });
  });

  it('sends progress while the command runs', async () => {
    const beats: number[] = [];
    await tools.verifyStep(
      ws,
      { step: 's', command: 'node -e "setTimeout(() => {}, 5600)"' },
      { heartbeat: (ms) => beats.push(ms) },
    );
    expect(beats.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('stops the command when the client cancels, and attaches nothing', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    await expect(
      tools.verifyStep(
        ws,
        { step: 's', command: 'node -e "setTimeout(() => {}, 10000)"' },
        { signal: abort.signal },
      ),
    ).rejects.toThrow(/cancelled; nothing was attached/);
    expect((await readPlan(board())).steps[0]!.verification).toBeUndefined();
  }, 15_000);
});

describe('tidy_layout and the board lock', () => {
  it('locks the board while drawing, and tidy_layout routes every arrow and unlocks it', async () => {
    const out = await tools.drawDiagram(ws, diagram);
    expect(out.text).toContain('tidy_layout');
    expect(isAgentWorking(await readAgentActivity(board()))).toBe(true);

    // Moving a box by hand leaves its arrows on stale routes.
    const moved = await tools.updateElements(ws, { updates: [{ id: 'db', x: -500, y: 400 }] });
    expect(moved.text).toContain('tidy_layout');

    const tidied = await tools.tidyLayout(ws, {});
    expect(tidied.text).toContain('unlocked');
    expect(isAgentWorking(await readAgentActivity(board()))).toBe(false);
    const plan = await readPlan(board());
    for (const e of plan.edges) {
      expect(e.route?.from).toEqual(plan.layout[e.from]);
      expect(e.route?.to).toEqual(plan.layout[e.to]);
    }
  });

  it('treats an agent as done once it has been idle for a while', () => {
    const now = Date.now();
    expect(isAgentWorking(undefined, now)).toBe(false);
    expect(isAgentWorking({ at: now - 1000, writing: false, done: false }, now)).toBe(true);
    expect(isAgentWorking({ at: now - AGENT_IDLE_MS - 1, writing: false, done: false }, now)).toBe(
      false,
    );
    expect(isAgentWorking({ at: now - 1000, writing: false, done: true }, now)).toBe(false);
    // A long write (a scan, a test run) keeps the lock past the idle time.
    expect(isAgentWorking({ at: now - AGENT_IDLE_MS - 1, writing: true, done: false }, now)).toBe(
      true,
    );
  });
});
