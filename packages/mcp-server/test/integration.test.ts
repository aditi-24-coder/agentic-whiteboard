import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPlan, writePlanAtomic } from '@agentic-whiteboard/shared/node';

// Spawns the built server (npm run build -w agentic-whiteboard-mcp) over stdio, like a real agent would.
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join('\n');

describe.skipIf(!existsSync(serverPath))('stdio integration', () => {
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-whiteboard-int-'));
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        env: { ...process.env, AGENTIC_WHITEBOARD_ROOT: root } as Record<string, string>,
      }),
    );
  });
  afterAll(async () => {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists the whiteboard tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_shapes',
        'check_drift',
        'clear_whiteboard',
        'create_whiteboard',
        'draw_diagram',
        'generate_architecture',
        'list_whiteboards',
        'read_whiteboard',
        'remove_elements',
        'tidy_layout',
        'update_elements',
        'verify_step',
      ].sort(),
    );
  });

  it('draws on a board the user edits in between', async () => {
    const created = await client.callTool({
      name: 'create_whiteboard',
      arguments: { name: 'Login flow' },
    });
    expect(text(created)).toContain('login-flow.whiteboard');
    const file = path.join(root, 'login-flow.whiteboard');

    await client.callTool({
      name: 'draw_diagram',
      arguments: {
        nodes: [
          { id: 'ui', label: 'Login page' },
          { id: 'api', label: 'Auth API' },
        ],
        edges: [{ from: 'ui', to: 'api', label: 'POST /login' }],
      },
    });

    // The user adds a sticky note on the board.
    const plan = await readPlan(file);
    plan.comments.push({ id: 'c1', text: 'add 2FA later' });
    plan.layout.c1 = { x: 0, y: 300, w: 200, h: 110 };
    plan.revision += 1;
    await writePlanAtomic(file, plan);

    const board = text(await client.callTool({ name: 'read_whiteboard', arguments: {} }));
    expect(board).toContain('- ui [component] "Login page"');
    expect(board).toContain('- c1 "add 2FA later"');

    await client.callTool({
      name: 'update_elements',
      arguments: { updates: [{ id: 'api', text: 'Auth service' }] },
    });
    const after = await readPlan(file);
    expect(after.nodes.find((n) => n.id === 'api')!.label).toBe('Auth service');
    expect(after.comments.map((c) => c.id)).toEqual(['c1']);
  });

  it('returns tool errors as isError results', async () => {
    const res = (await client.callTool({
      name: 'read_whiteboard',
      arguments: { board: 'missing' },
    })) as TextResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No whiteboard "missing"');
  });
});
