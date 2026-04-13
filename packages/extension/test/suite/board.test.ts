import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Plan } from '@agentic-whiteboard/shared';
import { recordAgentActivity, withPlanLock } from '@agentic-whiteboard/shared/node';

const workspace = process.env.AGENTIC_WHITEBOARD_TEST_WORKSPACE!;
const file = path.join(workspace, '.agentic-whiteboard', 'stripe-payments.plan.json');
const uri = vscode.Uri.file(file);

interface BoardInfo {
  uri: string;
  revision?: number;
  posted: number;
  agentWorking: boolean;
}

async function boards(): Promise<BoardInfo[]> {
  return vscode.commands.executeCommand<BoardInfo[]>('agentic-whiteboard._test.boards');
}

async function board(): Promise<BoardInfo> {
  const b = (await boards()).find((x) => x.uri === uri.toString());
  assert.ok(b, 'board is open');
  return b;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const doc = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())!;
const docPlan = (): Plan => JSON.parse(doc().getText());
/** Writes like an agent does: under the plan lock, via temp file + rename (retrying Windows sharing errors). */
async function agentWrite(target: string, text: string) {
  await withPlanLock(target, async () => {
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text);
    for (let i = 0; ; i++) {
      try {
        await fs.rename(tmp, target);
        return;
      } catch (err) {
        if (i > 40) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  });
}
const diskPlan = async (): Promise<Plan> => JSON.parse(await fs.readFile(file, 'utf8'));

describe('Agentic Whiteboard board', () => {
  before(async () => {
    const ext = vscode.extensions.all.find((e) => e.id.endsWith('.agentic-whiteboard'));
    await ext?.activate();
    void vscode.commands.executeCommand('vscode.openWith', uri, 'agentic-whiteboard.board');
    try {
      await waitFor('board to open', async () => (await boards()).length > 0, 20_000);
    } catch (err) {
      const tabs = vscode.window.tabGroups.all.flatMap((g) =>
        g.tabs.map((t) => `${t.label}:${t.input?.constructor.name}`),
      );
      console.log('extension active:', ext?.isActive, 'tabs:', tabs);
      throw err;
    }
  });

  it('opens *.plan.json in the custom editor and the webview loads the plan', async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputCustom, 'active tab is a custom editor');
    assert.equal((tab.input as vscode.TabInputCustom).viewType, 'agentic-whiteboard.board');
    // The host only posts once the webview script has run and said "ready".
    const b = await waitFor('webview ready', async () => {
      const x = await board();
      return x.posted > 0 && x;
    });
    assert.equal(b.revision, 1);
  });

  it('round-trips a webview edit into the document and saves it to disk', async () => {
    const plan = docPlan();
    plan.steps = plan.steps.filter((s) => s.id !== 's6');
    plan.constraints.push({ id: 'k-user', text: "don't touch auth", author: 'user' });
    plan.layout['k-user'] = { x: 0, y: -400, w: 220, h: 110 };
    await vscode.commands.executeCommand(
      'agentic-whiteboard._test.webviewEdit',
      uri.toString(),
      plan,
      plan.revision,
    );
    const after = docPlan();
    assert.equal(after.revision, 2);
    assert.ok(!after.steps.some((s) => s.id === 's6'));
    assert.ok(!doc().isDirty, 'saved');
    const disk = await diskPlan();
    assert.equal(disk.revision, 2);
    assert.ok(disk.constraints.some((c) => c.id === 'k-user'));
  });

  it('shows an agent write on disk (live step status) within about a second', async () => {
    const plan = await diskPlan();
    plan.status = 'in_progress';
    plan.steps[0]!.status = 'done';
    plan.revision += 1;
    const before = (await board()).posted;
    const started = Date.now();
    await agentWrite(file, JSON.stringify(plan, null, 2) + '\n');
    await waitFor('board reload', async () => {
      const b = await board();
      return b.revision === plan.revision && b.posted > before;
    });
    const ms = Date.now() - started;
    console.log(`      reload latency: ${ms} ms`);
    assert.ok(ms < 2500, `reload took ${ms} ms`);
    // The board shows the disk version first; VS Code reloads the document itself shortly after.
    // Wait for that too, so the next test starts from a document that matches the disk.
    await waitFor('document reload', async () => docPlan().steps[0]!.status === 'done');
  });

  it('merges a stale webview edit with a newer agent write instead of overwriting it', async () => {
    const stale = docPlan();
    const agent = structuredClone(stale);
    agent.steps[1]!.status = 'in_progress';
    agent.revision += 1;
    await agentWrite(file, JSON.stringify(agent, null, 2) + '\n');
    await waitFor('agent write loaded', async () => docPlan().revision === agent.revision);

    // The user's edit was based on the older revision.
    stale.comments.push({ id: 'c-user', text: 'use idempotency keys' });
    stale.layout['c-user'] = { x: 0, y: 900, w: 200, h: 110 };
    await vscode.commands.executeCommand(
      'agentic-whiteboard._test.webviewEdit',
      uri.toString(),
      stale,
      stale.revision,
    );
    const merged = docPlan();
    assert.equal(merged.steps[1]!.status, 'in_progress', 'agent change kept');
    assert.ok(
      merged.comments.some((c) => c.id === 'c-user'),
      'user change kept',
    );
    assert.equal(merged.revision, agent.revision + 1);
  });

  it('locks the board while an agent works on it and unlocks it when the agent is done', async () => {
    await recordAgentActivity(file, { writing: true });
    await waitFor('board locked', async () => (await board()).agentWorking);
    await recordAgentActivity(file, {});
    assert.equal((await board()).agentWorking, true, 'stays locked between tool calls');
    await recordAgentActivity(file, { done: true });
    await waitFor('board unlocked', async () => !(await board()).agentWorking);
  });

  it('never overwrites a malformed file', async () => {
    const good = await fs.readFile(file, 'utf8');
    await agentWrite(file, '{ "id": "broken", ');
    await waitFor('invalid text loaded', async () =>
      doc().getText().startsWith('{ "id": "broken"'),
    );
    const plan = JSON.parse(good) as Plan;
    await vscode.commands.executeCommand(
      'agentic-whiteboard._test.webviewEdit',
      uri.toString(),
      plan,
      plan.revision,
    );
    assert.equal(await fs.readFile(file, 'utf8'), '{ "id": "broken", ');
    await agentWrite(file, good);
    await waitFor('restored', async () => doc().getText() === good);
  });

  it('auto-opens a new plan that an agent creates', async () => {
    const created = path.join(workspace, '.agentic-whiteboard', 'agent-made.plan.json');
    const plan = { ...(await diskPlan()), id: 'agent-made', title: 'Agent made', revision: 1 };
    await agentWrite(created, JSON.stringify(plan, null, 2));
    await waitFor(
      'auto-open',
      async () => (await boards()).some((b) => b.uri === vscode.Uri.file(created).toString()),
      15_000,
    );
  });

  it('opens an empty .whiteboard file as a blank board and saves it', async () => {
    const blank = path.join(workspace, 'sketch notes.whiteboard');
    await fs.writeFile(blank, '');
    const blankUri = vscode.Uri.file(blank);
    await vscode.commands.executeCommand('vscode.open', blankUri);
    await waitFor('custom editor', async () =>
      (await boards()).some((b) => b.uri === blankUri.toString()),
    );
    const saved = await waitFor('blank board on disk', async () => {
      const text = await fs.readFile(blank, 'utf8');
      return text.trim() ? (JSON.parse(text) as Plan) : undefined;
    });
    assert.equal(saved.title, 'sketch notes');
    assert.equal(saved.id, 'sketch-notes');
    assert.deepEqual(saved.nodes, []);
  });

  it('saves an edit made just before the board is closed', async () => {
    const quick = path.join(workspace, 'quick-close.whiteboard');
    await fs.writeFile(quick, '');
    const quickUri = vscode.Uri.file(quick);
    await vscode.commands.executeCommand('vscode.open', quickUri);
    const saved = await waitFor('blank board on disk', async () => {
      const text = await fs.readFile(quick, 'utf8');
      return text.trim() ? (JSON.parse(text) as Plan) : undefined;
    });
    await waitFor(
      'board loaded',
      async () =>
        (await boards()).find((b) => b.uri === quickUri.toString())?.revision === saved.revision,
    );
    const edited = { ...saved, title: 'Renamed just before closing' };
    // A debounced edit, as a drag or a rename sends, then close before the debounce fires.
    await vscode.commands.executeCommand(
      'agentic-whiteboard._test.webviewEdit',
      quickUri.toString(),
      edited,
      saved.revision,
      false,
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const after = await waitFor('edit on disk', async () => {
      const p = JSON.parse(await fs.readFile(quick, 'utf8')) as Plan;
      return p.title === edited.title ? p : undefined;
    });
    assert.ok(after.revision > saved.revision);
  });

  it('auto-opens a whiteboard that an agent creates', async () => {
    const created = path.join(workspace, 'agent-board.whiteboard');
    const plan = { version: 1, revision: 1, id: 'agent-board', title: 'Agent board' };
    await agentWrite(created, JSON.stringify(plan, null, 2));
    await waitFor(
      'auto-open',
      async () => (await boards()).some((b) => b.uri === vscode.Uri.file(created).toString()),
      15_000,
    );
  });

  it('registers its commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of [
      'agentic-whiteboard.newBoard',
      'agentic-whiteboard.openLatest',
      'agentic-whiteboard.setupAgent',
      'agentic-whiteboard.openAsText',
      'agentic-whiteboard.generateArchitecture',
      'agentic-whiteboard.checkDrift',
      'agentic-whiteboard.verifyStep',
      'agentic-whiteboard.askAiSync',
    ])
      assert.ok(all.includes(c), c);
  });

  it('generates the architecture from the code and shows drift as the code changes', async () => {
    const write = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
      await fs.writeFile(path.join(workspace, rel), text);
    };
    await write(
      'src/orders/routes.ts',
      "import { pay } from '../payments/pay';\nexport const r = pay;",
    );
    await write('src/orders/model.ts', 'export const Order = 1;');
    await write('src/payments/pay.ts', "import Stripe from 'stripe';\nexport const pay = Stripe;");
    await write('src/payments/refund.ts', "import { pay } from './pay';\nexport const x = pay;");
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.commands.executeCommand('agentic-whiteboard.generateArchitecture');
    const arch = path.join(workspace, 'architecture.whiteboard');
    const generated = await waitFor('the generated board', async () => {
      const plan = JSON.parse(await fs.readFile(arch, 'utf8').catch(() => '{}')) as Partial<Plan>;
      return plan.nodes?.some((n) => n.id === 'code-src-payments') && plan;
    });
    assert.ok(generated.codebase, 'board records when it was synced');
    assert.deepEqual(
      generated.edges?.map((e) => `${e.from}->${e.to}`),
      ['code-src-orders->code-src-payments', 'code-src-payments->sys-stripe'],
    );

    const archUri = vscode.Uri.file(arch).toString();
    const code = () =>
      vscode.commands.executeCommand<{ linked: boolean; drift: { kind: string }[] } | undefined>(
        'agentic-whiteboard._test.code',
        archUri,
      );
    await waitFor('a clean drift check', async () => (await code())?.linked);
    assert.deepEqual((await code())!.drift, []);

    // The payments code moves from Stripe to Adyen: the board notices on its own.
    await write(
      'src/payments/pay.ts',
      "import { Client } from '@adyen/api-library';\nexport const pay = Client;",
    );
    const drift = await waitFor(
      'drift after the code changed',
      async () => {
        const kinds = (await code())?.drift.map((d) => d.kind) ?? [];
        return kinds.includes('deps-changed') && kinds;
      },
      20_000,
    );
    assert.ok(drift.includes('package-unused'), drift.join());
  });
});
