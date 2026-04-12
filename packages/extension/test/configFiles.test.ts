import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RULE_MARKER,
  appendCodexConfig,
  appendRule,
  claudeCodeEntry,
  clineEntry,
  codexToml,
  cursorEntry,
  serverCommand,
  upsertServerConfig,
  vscodeEntry,
} from '../src/configFiles';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-whiteboard-cfg-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const linux = { platform: 'linux' as const, hasNode: true, execPath: '/usr/share/code/code' };
const bundled = serverCommand('bundled', '/ext/mcp-server.js', linux);

describe('MCP config entries', () => {
  it('Claude Code: plain stdio entry, CLAUDE_PROJECT_DIR supplies the root', () => {
    expect(claudeCodeEntry(bundled)).toEqual({ command: 'node', args: ['/ext/mcp-server.js'] });
    expect(claudeCodeEntry(serverCommand('npx', '', linux), 'plans')).toEqual({
      command: 'npx',
      args: ['-y', 'agentic-whiteboard-mcp'],
      env: { AGENTIC_WHITEBOARD_PLANS_FOLDER: 'plans' },
    });
  });

  it('VS Code and Cursor use ${workspaceFolder}; Cline gets an absolute root', () => {
    expect(vscodeEntry(bundled)).toMatchObject({
      type: 'stdio',
      env: { AGENTIC_WHITEBOARD_ROOT: '${workspaceFolder}' },
    });
    expect(cursorEntry(bundled).env.AGENTIC_WHITEBOARD_ROOT).toBe('${workspaceFolder}');
    expect(clineEntry(bundled, '/repo')).toMatchObject({
      env: { AGENTIC_WHITEBOARD_ROOT: '/repo' },
      disabled: false,
      autoApprove: [],
    });
  });
});

describe('server command', () => {
  it('wraps npx in cmd /c on Windows, where agents cannot spawn npx.cmd directly', () => {
    expect(serverCommand('npx', '', { ...linux, platform: 'win32' })).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'agentic-whiteboard-mcp'],
    });
  });

  it("runs the bundled server with VS Code's runtime when Node.js is not installed", () => {
    const cmd = serverCommand('bundled', '/ext/mcp-server.js', { ...linux, hasNode: false });
    expect(cmd).toEqual({
      command: '/usr/share/code/code',
      args: ['/ext/mcp-server.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(claudeCodeEntry(cmd).env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(cursorEntry(cmd).env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
    expect(codexToml(cmd, '/repo')).toContain('ELECTRON_RUN_AS_NODE = "1"');
  });
});

describe('upsertServerConfig', () => {
  it('creates a new file', async () => {
    const file = path.join(dir, '.vscode', 'mcp.json');
    expect(await upsertServerConfig(file, 'servers', vscodeEntry(bundled))).toBe('created');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).servers['agentic-whiteboard'].command).toBe(
      'node',
    );
  });

  it('keeps other servers and comments', async () => {
    const file = path.join(dir, 'mcp.json');
    await fs.writeFile(
      file,
      '{\n  // my servers\n  "servers": {\n    "other": { "type": "stdio", "command": "x" },\n  },\n}\n',
    );
    expect(await upsertServerConfig(file, 'servers', vscodeEntry(bundled))).toBe('updated');
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('// my servers');
    expect(text).toContain('"other"');
    expect(text).toContain('"agentic-whiteboard"');
  });

  it('refuses to touch a broken file', async () => {
    const file = path.join(dir, '.mcp.json');
    await fs.writeFile(file, '{ "mcpServers": ');
    await expect(upsertServerConfig(file, 'mcpServers', claudeCodeEntry(bundled))).rejects.toThrow(
      /left unchanged/,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('{ "mcpServers": ');
  });
});

describe('appendRule', () => {
  it('appends once', async () => {
    const file = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(file, '# Project\nSome rules.');
    expect(await appendRule(file)).toBe(true);
    expect(await appendRule(file)).toBe(false);
    const text = await fs.readFile(file, 'utf8');
    expect(text.split(RULE_MARKER)).toHaveLength(2);
    expect(text.startsWith('# Project\nSome rules.\n\n## Agentic Whiteboard whiteboard')).toBe(
      true,
    );
  });
});

describe('OpenAI Codex config', () => {
  it('writes a TOML section with escaped Windows paths, once', async () => {
    const toml = codexToml(
      serverCommand('bundled', 'C:\\ext\\mcp-server.js', { ...linux, platform: 'win32' }),
      'C:\\repo',
    );
    expect(toml).toBe(
      '[mcp_servers."agentic-whiteboard"]\n' +
        'command = "node"\n' +
        'args = ["C:\\\\ext\\\\mcp-server.js"]\n' +
        'env = { AGENTIC_WHITEBOARD_ROOT = "C:\\\\repo" }\n',
    );
    const file = path.join(dir, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'model = "gpt-5"\n');
    expect(await appendCodexConfig(file, toml)).toBe('added');
    expect(await appendCodexConfig(file, toml)).toBe('exists');
    expect(await fs.readFile(file, 'utf8')).toBe('model = "gpt-5"\n\n' + toml);
  });
});
