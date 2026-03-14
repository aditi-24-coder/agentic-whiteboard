import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PlanSchema,
  applyArchitecture,
  architectureFromScan,
  detectDrift,
  formatDrift,
  moduleKeys,
  nodePackages,
  isCodeSynced,
  recordBaseline,
  syncBoardWithCode,
  type CodeScan,
  type Plan,
} from '../src/index.js';
import {
  VerificationCancelled,
  attachVerification,
  gitChangedFiles,
  gitDiff,
  isTestPath,
  parseJsonc,
  runCommand,
  scanRepo,
  verifyStep,
} from '../src/node.js';

let root: string;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'echo ok' } }),
  'src/orders/routes.ts': [
    "import express from 'express';",
    "import { PaymentService } from '../payments/payments.js';",
    "import type { Order } from '../db/models';",
    'const router = express.Router();',
    "router.post('/orders', (req, res) => new PaymentService().charge());",
    "router.get('/orders/:id', () => {});",
    'export default router;',
  ].join('\n'),
  'src/payments/payments.ts': [
    "import Stripe from 'stripe';",
    "import { readFile } from 'node:fs';",
    '// import Adyen from "adyen"; (a comment, not an import)',
    'export class PaymentService { charge() {} }',
    'export const VERSION = 1;',
  ].join('\n'),
  'src/payments/payments.test.ts': "import { PaymentService } from './payments';\n",
  'src/db/models.ts': [
    "import mongoose from 'mongoose';",
    "export const Order = mongoose.model('Order', new mongoose.Schema({}));",
  ].join('\n'),
  'billing/models.py': [
    'import os',
    'from sqlalchemy.orm import DeclarativeBase as Base',
    'class Invoice(Base):',
    '    pass',
  ].join('\n'),
  'billing/api.py': [
    'from fastapi import FastAPI',
    'from .models import Invoice',
    'app = FastAPI()',
    '@app.get("/invoices")',
    'def list_invoices():',
    '    return []',
  ].join('\n'),
  'README.md': '# shop\n',
};

async function write(rel: string, text: string) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-whiteboard-code-'));
  for (const [rel, text] of Object.entries(FILES)) await write(rel, text);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const fileOf = (scan: CodeScan, p: string) => scan.files.find((f) => f.path === p)!;

/** A board generated from the code, as generate_architecture makes it. */
function boardFromCode(scan: CodeScan, patch: Partial<Plan> = {}): Plan {
  const arch = architectureFromScan(scan);
  const blank = PlanSchema.parse({ id: 'arch', title: 'Architecture' });
  return { ...applyArchitecture(blank, arch, { scannedAt: scan.scannedAt }).plan, ...patch };
}

describe('scanRepo', () => {
  it('resolves imports, packages, exports, routes and models', async () => {
    const scan = await scanRepo(root);
    expect(scan.paths).toContain('README.md');
    const routes = fileOf(scan, 'src/orders/routes.ts');
    expect(routes.imports).toEqual(['src/db/models.ts', 'src/payments/payments.ts']);
    expect(routes.packages).toEqual(['express']);
    expect(routes.routes).toEqual(['POST /orders', 'GET /orders/:id']);

    const payments = fileOf(scan, 'src/payments/payments.ts');
    expect(payments.packages).toEqual(['stripe']); // node builtins and comments are skipped
    expect(payments.exports).toEqual(['PaymentService', 'VERSION']);
    expect(fileOf(scan, 'src/payments/payments.test.ts').test).toBe(true);
    expect(fileOf(scan, 'src/db/models.ts').models).toEqual(['Order']);

    const api = fileOf(scan, 'billing/api.py');
    expect(api.imports).toEqual(['billing/models.py']);
    expect(api.packages).toEqual(['fastapi']);
    expect(api.routes).toEqual(['GET /invoices']);
    expect(fileOf(scan, 'billing/models.py').models).toEqual(['Invoice']);
    expect(fileOf(scan, 'billing/models.py').packages).toEqual(['sqlalchemy']); // not "os"
  });

  it('resolves monorepo workspace packages to their source', async () => {
    await write(
      'packages/core/package.json',
      JSON.stringify({
        name: '@shop/core',
        exports: { '.': './src/index.ts', './node': './src/node.ts' },
      }),
    );
    await write('packages/core/src/index.ts', 'export const a = 1;');
    await write('packages/core/src/node.ts', 'export const b = 1;');
    await write(
      'packages/app/src/main.ts',
      "import { a } from '@shop/core';\nimport { b } from '@shop/core/node';",
    );
    const scan = await scanRepo(root);
    expect(fileOf(scan, 'packages/app/src/main.ts').imports).toEqual([
      'packages/core/src/index.ts',
      'packages/core/src/node.ts',
    ]);
    expect(fileOf(scan, 'packages/app/src/main.ts').packages).toEqual([]);
  });

  it('recognises test files by name and folder', () => {
    for (const p of ['a.test.ts', 'src/__tests__/x.js', 'test/x.ts', 'test_api.py', 'h_test.go'])
      expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/testing.ts', 'contest.py', 'latest/x.ts'])
      expect(isTestPath(p), p).toBe(false);
  });
});

describe('architectureFromScan', () => {
  it('draws the parts, the systems they talk to and one arrow per relationship, not libraries', async () => {
    const { nodes, edges } = architectureFromScan(await scanRepo(root));
    expect(nodes.map((n) => `${n.id} "${n.label}" ${n.path ?? nodePackages(n).join('+')}`)).toEqual(
      [
        'code-billing "Billing" billing',
        'code-src-db "DB" src/db/models.ts',
        'code-src-orders "Orders" src/orders/routes.ts',
        'code-src-payments "Payments" src/payments/payments.ts',
        // billing's SQLAlchemy is not folded into MongoDB: different code uses them.
        'sys-database "Database" sqlalchemy',
        'sys-mongodb "MongoDB" mongoose',
        'sys-stripe "Stripe" stripe',
      ],
    );
    // express and fastapi are libraries: no boxes.
    expect(nodes.every((n) => n.kind !== 'external' || n.role)).toBe(true);
    expect(nodes.find((n) => n.id === 'code-src-orders')).toMatchObject({ role: 'api' });
    expect(edges.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      'code-src-orders -> code-src-db',
      'code-src-orders -> code-src-payments',
      'code-billing -> sys-database',
      'code-src-db -> sys-mongodb',
      'code-src-payments -> sys-stripe',
    ]);
  });

  it('keeps shared helpers as a box without arrows into it', async () => {
    await write('src/utils/format.ts', 'export const f = 1;');
    await write('src/orders/more.ts', "import { f } from '../utils/format';");
    await write('src/payments/more.ts', "import { f } from '../utils/format';");
    const { nodes, edges } = architectureFromScan(await scanRepo(root));
    expect(nodes.find((n) => n.id === 'code-src-utils')).toMatchObject({
      role: 'shared',
      summary: 'shared, used by 2',
    });
    expect(edges.some((e) => e.to === 'code-src-utils')).toBe(false);
  });

  it('uses the packages of a monorepo as its parts', async () => {
    await write('packages/api/package.json', JSON.stringify({ name: '@shop/api' }));
    await write('packages/api/src/server.ts', "import pg from 'pg';\nexport const s = pg;");
    await write('packages/api/src/routes/a.ts', "import { s } from '../server';");
    await write('packages/web/package.json', JSON.stringify({ name: '@shop/web' }));
    await write('packages/web/src/app.tsx', "import { s } from '@shop/api';");
    const { nodes, edges } = architectureFromScan(await scanRepo(root), { folder: 'packages' });
    expect(nodes.map((n) => n.label)).toEqual(['API', 'Web', 'PostgreSQL']);
    expect(edges.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      'code-packages-web -> code-packages-api',
      'code-packages-api -> sys-postgresql',
    ]);
  });

  it('merges an ORM into the database the same code uses', async () => {
    await write(
      'src/db/client.ts',
      "import { PrismaClient } from '@prisma/client';\nimport { Pool } from 'pg';",
    );
    const { nodes } = architectureFromScan(await scanRepo(root), { folder: 'src' });
    expect(nodes.filter((n) => n.kind === 'external').map((n) => n.label)).toEqual([
      'MongoDB',
      'PostgreSQL',
      'Stripe',
    ]);
    expect(nodePackages(nodes.find((n) => n.label === 'PostgreSQL')!)).toEqual([
      '@prisma/client',
      'pg',
    ]);
  });

  it('stays an overview however big the repo is', async () => {
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 3; j++)
        await write(`src/features/f${i}/sub${j}/index.ts`, `export const x${i}${j} = 1;`);
    const { nodes } = architectureFromScan(await scanRepo(root));
    expect(nodes.filter((n) => n.kind !== 'external').length).toBeLessThanOrEqual(12);
  });

  it('collapses folders upwards until the module limit is met', () => {
    const keys = moduleKeys(['a/b/c/x.ts', 'a/b/d/y.ts', 'a/e/z.ts', 'f.ts'], 3);
    expect([...new Set(keys.values())].sort()).toEqual(['.', 'a/b', 'a/e']);
  });
});

describe('applyArchitecture', () => {
  it('re-syncs a generated board: keeps names and positions, removes what is gone', async () => {
    const scan = await scanRepo(root);
    let plan = boardFromCode(scan);
    const payments = plan.nodes.find((n) => n.id === 'code-src-payments')!;
    payments.label = 'Payments (renamed by me)';
    plan.nodes.push({
      id: 'mine',
      kind: 'component',
      label: 'Hand drawn',
      changeType: 'unchanged',
    });
    plan.layout[payments.id] = { x: 5, y: 5, w: 100, h: 50 };

    await fs.rm(path.join(root, 'billing'), { recursive: true });
    const later = architectureFromScan(await scanRepo(root));
    const kept = applyArchitecture(plan, later, { scannedAt: 'later', prune: false });
    expect(kept.stale).toEqual(['code-billing', 'sys-database']);

    const res = applyArchitecture(plan, later, { scannedAt: 'later' });
    plan = res.plan;
    expect(res.mode).toBe('generate');
    // Outdated generated boxes go by default: the billing folder and the database only it used.
    expect(res.removed).toEqual(['code-billing', 'sys-database']);
    expect(plan.nodes.find((n) => n.id === payments.id)!.label).toBe('Payments (renamed by me)');
    expect(plan.layout[payments.id]).toEqual({ x: 5, y: 5, w: 100, h: 50 });
    expect(plan.nodes.some((n) => n.id === 'mine')).toBe(true);
  });

  it('links a hand-drawn architecture instead of redrawing it', async () => {
    const scan = await scanRepo(root);
    const drawn = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [
        { id: 'web', kind: 'component', label: 'Web app' },
        { id: 'api', kind: 'component', label: 'Orders API', path: 'src/orders/routes.ts' },
        { id: 'pay', kind: 'component', label: 'Payment service', path: 'src/payments' },
        { id: 'store', kind: 'external', label: 'Mongo store (orders)' },
        // Left over from the old, file-level generator.
        {
          id: 'ext-express',
          kind: 'external',
          label: 'express',
          package: 'express',
          origin: 'code',
        },
      ],
      edges: [
        { id: 'e1', from: 'web', to: 'api', label: 'HTTPS' },
        { id: 'e2', from: 'api', to: 'pay' },
        { id: 'old', from: 'api', to: 'ext-express', origin: 'code' },
      ],
    });
    const res = applyArchitecture(drawn, architectureFromScan(scan), { scannedAt: 'now', scan });
    expect(res.mode).toBe('link');
    // The drawing stays: no module boxes added; the old generated box and its arrow are gone.
    expect(res.plan.nodes.map((n) => n.id)).toEqual(['web', 'api', 'pay', 'store', 'sys-stripe']);
    expect(res.removed).toEqual(['ext-express']);
    // "Mongo store" is recognised as MongoDB and linked, so drift is checked for it too.
    expect(nodePackages(res.plan.nodes.find((n) => n.id === 'store')!)).toEqual(['mongoose']);
    expect(res.plan.edges.map((e) => `${e.from}->${e.to}${e.label ? ` ${e.label}` : ''}`)).toEqual([
      'web->api HTTPS',
      'api->pay',
      'pay->sys-stripe',
    ]);
  });

  it('links a drawn system box by name when code on the drawing uses it', async () => {
    const scan = await scanRepo(root);
    const drawn = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [
        { id: 'pay', kind: 'component', label: 'Payments', path: 'src/payments' },
        { id: 'psp', kind: 'external', label: 'Stripe (cards)' },
      ],
    });
    const res = applyArchitecture(drawn, architectureFromScan(scan), { scannedAt: 'now', scan });
    expect(res.plan.nodes.map((n) => n.id)).toEqual(['pay', 'psp']);
    expect(res.plan.nodes[1]).toMatchObject({ label: 'Stripe (cards)', packages: ['stripe'] });
    expect(res.plan.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['pay->psp']);
  });
});

describe('detectDrift', () => {
  it('finds nothing on a board freshly generated from the code', async () => {
    const scan = await scanRepo(root);
    expect(formatDrift(detectDrift(boardFromCode(scan), scan))).toBe(
      'No drift: the diagram matches the code.',
    );
  });

  it('notices when payments switch from Stripe to Adyen', async () => {
    const plan = boardFromCode(await scanRepo(root));
    await write(
      'src/payments/payments.ts',
      "import { Client } from '@adyen/api-library';\nexport class PaymentService {}",
    );
    const drift = detectDrift(plan, await scanRepo(root));
    const kinds = drift.map((d) => `${d.kind}:${d.targetId}`);
    const payments = plan.nodes.find((n) => n.path === 'src/payments/payments.ts')!.id;
    const stripe = plan.nodes.find((n) => n.package === 'stripe')!.id;
    expect(kinds).toContain(`deps-changed:${payments}`);
    expect(kinds).toContain(`package-unused:${stripe}`);
    expect(kinds).toContain(`edge-unbacked:e-${payments}-${stripe}`);
    expect(drift.find((d) => d.kind === 'deps-changed')!.message).toMatch(
      /now imports @adyen\/api-library and no longer imports stripe/,
    );
  });

  it('suggests where a moved file went, and flags deleted ones', async () => {
    const plan = boardFromCode(await scanRepo(root));
    await fs.mkdir(path.join(root, 'src/data'));
    await fs.rename(path.join(root, 'src/db/models.ts'), path.join(root, 'src/data/models.ts'));
    await fs.rm(path.join(root, 'src/orders/routes.ts'));
    const drift = detectDrift(plan, await scanRepo(root));
    expect(drift.find((d) => d.kind === 'renamed')).toMatchObject({
      suggestion: 'src/data/models.ts',
      severity: 'warning',
    });
    expect(drift.find((d) => d.kind === 'missing')).toMatchObject({
      files: ['src/orders/routes.ts'],
      severity: 'error',
    });
  });

  it('flags imports with no arrow and code with no box', async () => {
    const plan = boardFromCode(await scanRepo(root));
    await write(
      'src/db/audit.ts',
      "import router from '../orders/routes';\nexport const x = router;",
    );
    await write('src/notify/email.ts', 'export const send = () => {};');
    const drift = detectDrift(plan, await scanRepo(root));
    expect(
      drift.some((d) => d.kind === 'unmapped' && d.files?.includes('src/notify/email.ts')),
    ).toBe(true);
    // src/db is a single-file box (models.ts), so audit.ts is also unmapped rather than an edge.
    expect(drift.some((d) => d.kind === 'unmapped' && d.files?.includes('src/db/audit.ts'))).toBe(
      true,
    );
  });

  it('flags planned boxes with no code once the plan is underway, and unplanned changes', async () => {
    const scan = await scanRepo(root);
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'Refunds',
      status: 'in_progress',
      nodes: [
        {
          id: 'refunds',
          kind: 'file',
          label: 'Refunds',
          path: 'src/payments/refunds.ts',
          changeType: 'new',
        },
        {
          id: 'pay',
          kind: 'file',
          label: 'Payments',
          path: 'src/payments/payments.ts',
          changeType: 'modify',
        },
      ],
      steps: [{ id: 's1', order: 1, title: 'Add refunds', nodeIds: ['refunds', 'pay'] }],
    });
    const drift = detectDrift(plan, scan, {
      changedFiles: ['src/payments/payments.ts', 'src/orders/routes.ts', 'arch.whiteboard'],
    });
    expect(drift.find((d) => d.kind === 'not-implemented')).toMatchObject({ targetId: 'refunds' });
    expect(drift.find((d) => d.kind === 'unplanned-change')).toMatchObject({
      files: ['src/orders/routes.ts'],
    });
    // A draft plan is still just a plan: nothing is overdue.
    expect(detectDrift({ ...plan, status: 'drafting' }, scan)).toEqual([]);
  });

  it('only warns softly about hand-drawn arrows with no import (they may be HTTP calls)', async () => {
    const scan = await scanRepo(root);
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [
        { id: 'db', kind: 'file', label: 'DB', path: 'src/db/models.ts' },
        { id: 'bill', kind: 'component', label: 'Billing', path: 'billing' },
      ],
      edges: [{ id: 'e1', from: 'db', to: 'bill', label: 'HTTP' }],
    });
    expect(detectDrift(plan, scan)).toEqual([
      expect.objectContaining({ kind: 'edge-unbacked', severity: 'info', targetId: 'e1' }),
    ]);
  });
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('verifyStep', () => {
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  beforeEach(() => {
    sh('init', '-q');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  });

  const plan = () =>
    PlanSchema.parse({
      id: 'p',
      title: 'p',
      status: 'in_progress',
      nodes: [
        {
          id: 'pay',
          kind: 'file',
          label: 'Payments',
          path: 'src/payments/payments.ts',
          changeType: 'modify',
        },
      ],
      steps: [
        { id: 's1', order: 1, title: 'Change payments', nodeIds: ['pay'], status: 'in_progress' },
      ],
    });

  it('attaches the diff and a passing command, and marks the step done', async () => {
    await write(
      'src/payments/payments.ts',
      "import Stripe from 'stripe';\nexport class PaymentService { refund() {} }",
    );
    const v = await verifyStep(root, plan(), 's1', await scanRepo(root), {
      command: 'node -e "console.log(42)"',
    });
    expect(v).toMatchObject({
      status: 'verified',
      exitCode: 0,
      files: ['src/payments/payments.ts'],
    });
    expect(v.output).toContain('42');
    expect(v.diffStat).toContain('src/payments/payments.ts');
    expect(v.diff).toContain('+export class PaymentService { refund() {} }');
    expect(v.commit).toMatch(/^[0-9a-f]+$/);
    expect(attachVerification(plan(), 's1', v).steps[0]!.status).toBe('done');
  });

  it('fails when the command fails', async () => {
    const v = await verifyStep(root, plan(), 's1', await scanRepo(root), {
      command: 'node -e "process.exit(3)"',
    });
    expect(v).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(attachVerification(plan(), 's1', v).steps[0]!.status).toBe('failed');
  });

  it('is drifted when the command passes but code changed outside the plan', async () => {
    await write('src/orders/routes.ts', 'export default 1;');
    const v = await verifyStep(root, plan(), 's1', await scanRepo(root), {
      command: 'node -e "0"',
    });
    expect(v.status).toBe('drifted');
    expect(v.reasons.join()).toMatch(/outside the approved plan: src\/orders\/routes.ts/);
    // Drifted keeps the step's own status.
    expect(attachVerification(plan(), 's1', v).steps[0]!.status).toBe('in_progress');
  });
});

describe('baseline', () => {
  it('scopes a verified step to its own boxes and keeps the rest of the baseline', async () => {
    const scan = await scanRepo(root);
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [
        { id: 'routes', kind: 'file', label: 'Routes', path: 'src/orders/routes.ts' },
        { id: 'pay', kind: 'file', label: 'Payments', path: 'src/payments/payments.ts' },
        { id: 'db', kind: 'file', label: 'DB', path: 'src/db/models.ts' },
      ],
      edges: [{ id: 'e1', from: 'routes', to: 'pay' }],
      codebase: { scannedAt: 'old', links: ['x->y'] },
    });
    const only = recordBaseline(plan, scan, ['pay']);
    expect(only.nodes.map((n) => n.deps)).toEqual([undefined, ['stripe'], undefined]);
    expect(only.edges[0]!.imported).toBe(true); // touches "pay"
    // routes->db does not involve "pay", so it is not part of this step's baseline.
    expect(only.codebase?.links).toEqual(['routes->pay', 'x->y']);

    const all = recordBaseline(plan, scan);
    expect(all.nodes.every((n) => n.deps)).toBe(true);
    expect(all.codebase?.links).toEqual(['routes->db', 'routes->pay']);
  });

  it('reuses a hand-drawn external system with the same package when syncing', async () => {
    const scan = await scanRepo(root);
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [{ id: 'psp', kind: 'external', label: 'Stripe (payments)', package: 'stripe' }],
    });
    const res = syncBoardWithCode(plan, scan);
    expect(res.plan.nodes.filter((n) => n.package === 'stripe').map((n) => n.id)).toEqual(['psp']);
    expect(res.plan.nodes.find((n) => n.id === 'psp')!.label).toBe('Stripe (payments)');
    expect(res.plan.edges.some((e) => e.to === 'psp' && e.origin === 'code')).toBe(true);
    // Synced and baselined together, so the board matches the code exactly.
    expect(detectDrift(res.plan, scan)).toEqual([]);
  });
});

describe('attachVerification', () => {
  const plan = (status: Plan['status']) =>
    PlanSchema.parse({
      id: 'p',
      title: 'p',
      status,
      steps: [
        { id: 'a', order: 1, title: 'A', status: 'done' },
        { id: 'b', order: 2, title: 'B' },
      ],
    });
  const v = (status: 'verified' | 'failed' | 'drifted') => ({
    status,
    at: 'now',
    files: [],
    reasons: [],
  });

  it('moves the plan to in progress, then to done when every step is done', () => {
    expect(attachVerification(plan('drafting'), 'a', v('verified')).status).toBe('in_progress');
    expect(attachVerification(plan('approved'), 'b', v('verified')).status).toBe('done');
    expect(attachVerification(plan('done'), 'a', v('failed')).status).toBe('in_progress');
    expect(attachVerification(plan('rejected'), 'a', v('drifted')).status).toBe('rejected');
  });
});

describe('scanner edge cases', () => {
  it('resolves tsconfig paths and baseUrl, with comments, "@/*" and relative extends', async () => {
    await write(
      'tsconfig.base.json',
      `{
        // shared settings
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"], "@db": ["src/db/models.ts"], }, /* trailing comma */
        },
      }`,
    );
    await write('tsconfig.json', '{ "extends": "./tsconfig.base" }');
    await write('web/jsconfig.json', '{ "compilerOptions": { "baseUrl": "lib" } }');
    await write('web/lib/util.js', 'export const u = 1;');
    await write(
      'src/app.ts',
      "import { PaymentService } from '@/payments/payments';\nimport { Order } from '@db';\nimport x from 'https://esm.sh/x';\nimport y from 'virtual:pwa';",
    );
    await write('web/page.js', "import { u } from 'util';");
    const scan = await scanRepo(root);
    const app = scan.files.find((f) => f.path === 'src/app.ts')!;
    expect(app.imports).toEqual(['src/db/models.ts', 'src/payments/payments.ts']);
    expect(app.packages).toEqual([]); // no bogus "@", "https:" or "virtual:" packages
    // web/ has its own jsconfig whose baseUrl wins over the root config.
    expect(scan.files.find((f) => f.path === 'web/page.js')!.imports).toEqual(['web/lib/util.js']);
  });

  it('parses JSONC without breaking strings that look like comments', () => {
    expect(parseJsonc('{"a": "x//y", "b": "/* no */", // c\n "c": [1,],}')).toEqual({
      a: 'x//y',
      b: '/* no */',
      c: [1],
    });
  });

  it('resolves Python "from . import mod" and "from .mod import Name"', async () => {
    await write('shop/__init__.py', '');
    await write(
      'shop/views.py',
      'from . import models\nfrom .models import (\n  Item,\n  Cart as C,\n)\n',
    );
    await write('shop/models.py', 'class Item: pass');
    await write('shop/mail.py', 'import smtplib\nfrom email.message import EmailMessage');
    const scan = await scanRepo(root);
    expect(scan.files.find((f) => f.path === 'shop/views.py')!.imports).toEqual([
      'shop/__init__.py',
      'shop/models.py',
    ]);
    expect(scan.files.find((f) => f.path === 'shop/mail.py')!.packages).toEqual([]);
  });

  it('skips tool configs, declarations and bundles', async () => {
    await write('vite.config.ts', "import { defineConfig } from 'vite';");
    await write('.eslintrc.js', "module.exports = require('eslint-config-x');");
    await write('src/types.d.ts', "import 'x';");
    await write('public/app.min.js', "import 'y';");
    const scan = await scanRepo(root);
    const parsed = scan.files.map((f) => f.path);
    for (const p of ['vite.config.ts', '.eslintrc.js', 'src/types.d.ts', 'public/app.min.js'])
      expect(parsed).not.toContain(p);
    expect(architectureFromScan(scan).nodes.some((n) => n.package === 'vite')).toBe(false);
  });

  it('matches a box path whose case differs from the folder', async () => {
    const scan = await scanRepo(root);
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [{ id: 'pay', kind: 'file', label: 'Pay', path: 'SRC/Payments/Payments.ts' }],
    });
    expect(detectDrift(plan, scan)).toEqual([]);
    expect(recordBaseline(plan, scan).nodes[0]!.deps).toEqual(['stripe']);
  });

  it('does not report "outside the plan" for a plan that names no code', async () => {
    const scan = await scanRepo(root);
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'p',
      status: 'in_progress',
      nodes: [{ id: 'a', kind: 'component', label: 'Idea' }],
    });
    expect(detectDrift(plan, scan, { changedFiles: ['src/orders/routes.ts'] })).toEqual([]);
  });
});

describe('runCommand', () => {
  it('keeps multi-byte output intact', async () => {
    const r = await runCommand(root, `node -e "process.stdout.write('✓ héllo 日本')"`);
    expect(r.output).toBe('✓ héllo 日本');
  });

  it('stops the whole process tree when cancelled', async () => {
    const marker = path.join(root, 'still-running.txt');
    const abort = new AbortController();
    // A shell that starts node, which writes a file after 3s unless it is killed.
    const run = runCommand(
      root,
      `node -e "setTimeout(() => require('fs').writeFileSync('still-running.txt', 'x'), 3000)"`,
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 300);
    await run;
    await new Promise((r) => setTimeout(r, 3500));
    await expect(fs.stat(marker)).rejects.toThrow();
  });
});

describe.skipIf(!hasGit)('git edge cases', () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      stdio: 'pipe',
    });
  const commitAll = () => {
    sh(root, 'init', '-q');
    sh(root, 'add', '.');
    sh(root, 'commit', '-qm', 'init');
  };

  it('sees a deleted file as gone before the deletion is staged', async () => {
    commitAll();
    const plan = boardFromCode(await scanRepo(root));
    await fs.rm(path.join(root, 'src/db/models.ts'));
    const drift = detectDrift(plan, await scanRepo(root));
    expect(drift.some((d) => d.kind === 'missing' && d.files?.[0] === 'src/db/models.ts')).toBe(
      true,
    );
  });

  it('reports changed files relative to a workspace folder inside the repo', async () => {
    commitAll();
    await write('src/orders/routes.ts', 'export default 2;');
    await write('billing/api.py', 'x = 1');
    await write('src/new.ts', 'export const n = 1;');
    // The workspace is src/: paths are relative to it, and billing/ is outside it.
    expect(await gitChangedFiles(path.join(root, 'src'))).toEqual(['new.ts', 'orders/routes.ts']);
  });

  it('treats every file as changed in a repository with no commits', async () => {
    sh(root, 'init', '-q');
    sh(root, 'add', 'README.md');
    expect(await gitChangedFiles(root)).toContain('README.md');
  });

  it('diffs many files at once (long command lines are batched)', async () => {
    const files = Array.from({ length: 250 }, (_, i) => `gen/a-much-longer-file-name-${i}.ts`);
    for (const f of files) await write(f, 'export const a = 1;');
    commitAll();
    for (const f of files) await write(f, 'export const a = 2;');
    const diff = await gitDiff(root, files);
    expect(diff.stat).toContain('gen/a-much-longer-file-name-249.ts');
    expect(diff.patch.match(/^diff --git/gm)).toHaveLength(250);
  });

  it('does not attach a cancelled verification', async () => {
    commitAll();
    const plan = PlanSchema.parse({
      id: 'p',
      title: 'p',
      steps: [{ id: 's', order: 1, title: 'S' }],
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    await expect(
      verifyStep(root, plan, 's', await scanRepo(root), {
        command: 'node -e "setTimeout(() => {}, 5000)"',
        signal: abort.signal,
      }),
    ).rejects.toBeInstanceOf(VerificationCancelled);
  });
});

describe('code sync mode', () => {
  const board = (patch: object) => PlanSchema.parse({ id: 'p', title: 'p', ...patch });
  const linked = { nodes: [{ id: 'a', kind: 'file', label: 'A', path: 'src/a.ts' }] };

  it('auto checks boards linked to code, on always, off never', () => {
    expect(isCodeSynced(board({}))).toBe(false);
    expect(isCodeSynced(board(linked))).toBe(true);
    expect(isCodeSynced(board({ codeSync: 'on' }))).toBe(true);
    expect(isCodeSynced(board({ ...linked, codeSync: 'off' }))).toBe(false);
  });

  it('syncing turns a board on, but never overrides a choice', async () => {
    const scan = await scanRepo(root);
    expect(syncBoardWithCode(board({}), scan).plan.codeSync).toBe('on');
    expect(syncBoardWithCode(board({ codeSync: 'off' }), scan).plan.codeSync).toBe('off');
  });
});

describe('architecture of a monorepo whose core package is called shared', () => {
  it('keeps the arrows into it rather than leaving unconnected boxes', async () => {
    await write('packages/shared/package.json', JSON.stringify({ name: '@x/shared' }));
    await write('packages/shared/src/index.ts', 'export const s = 1;');
    await write('packages/app/package.json', JSON.stringify({ name: '@x/app' }));
    await write('packages/app/src/main.ts', "import { s } from '@x/shared';");
    const { edges } = architectureFromScan(await scanRepo(root), { folder: 'packages' });
    expect(edges.map((e) => `${e.from} -> ${e.to}`)).toEqual([
      'code-packages-app -> code-packages-shared',
    ]);
  });
});

describe('linking a drawing whose paths differ in case', () => {
  it('recognises "SRC/Payments" as src/payments instead of adding a duplicate box', async () => {
    const scan = await scanRepo(root);
    const drawn = PlanSchema.parse({
      id: 'p',
      title: 'p',
      nodes: [{ id: 'pay', kind: 'component', label: 'Payments', path: 'SRC/Payments' }],
    });
    const res = applyArchitecture(drawn, architectureFromScan(scan), { scannedAt: 'now', scan });
    expect(res.mode).toBe('link');
    expect(res.updated).toContain('pay');
    expect(res.plan.nodes.filter((n) => n.label === 'Payments').map((n) => n.id)).toEqual(['pay']);
    expect(res.plan.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['pay->sys-stripe']);
  });
});
