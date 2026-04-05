import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

// Agent MCP config formats. No `vscode` import, so this module is unit-tested with vitest.

export const RULE_MARKER = '## Agentic Whiteboard whiteboard';
export const RULE_TEXT = `${RULE_MARKER}

This project uses Agentic Whiteboard whiteboards (\`*.whiteboard\` files, shown live in VS Code). When I ask
you to draw, sketch, diagram or change something on the whiteboard, use the \`agentic-whiteboard\` MCP tools:
\`read_whiteboard\` first when I refer to things already on it, \`draw_diagram\` for boxes and arrows,
\`add_shapes\` for notes, text, frames and shapes, and \`update_elements\` / \`remove_elements\` for edits.
Keep diagrams clean (no hand-placed boxes, few arrows) and finish with \`tidy_layout\`, which routes
every arrow around the boxes and unlocks the board for me.
`;

export type Launch = 'bundled' | 'npx';

export interface ServerCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Where the agent will start the server. */
export interface Runtime {
  platform: NodeJS.Platform;
  /** `node` is on the PATH. */
  hasNode: boolean;
  /** VS Code's own executable, which runs JavaScript with ELECTRON_RUN_AS_NODE. */
  execPath: string;
}

export function serverCommand(launch: Launch, serverPath: string, rt: Runtime): ServerCommand {
  if (launch === 'npx') {
    const args = ['-y', 'agentic-whiteboard-mcp'];
    // npx is a .cmd script on Windows, which agents that spawn without a shell cannot start.
    return rt.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', ...args] }
      : { command: 'npx', args };
  }
  if (rt.hasNode) return { command: 'node', args: [serverPath] };
  // No Node.js installed: run the server with VS Code's own runtime, as Copilot does.
  return { command: rt.execPath, args: [serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function plansEnv(folder: string): Record<string, string> {
  return folder === '.agentic-whiteboard' ? {} : { AGENTIC_WHITEBOARD_PLANS_FOLDER: folder };
}

/** Claude Code reads project MCP servers from `.mcp.json` and sets CLAUDE_PROJECT_DIR for them. */
export function claudeCodeEntry(cmd: ServerCommand, plansFolder = '.agentic-whiteboard') {
  const env = { ...cmd.env, ...plansEnv(plansFolder) };
  return { command: cmd.command, args: cmd.args, ...(Object.keys(env).length ? { env } : {}) };
}

/** VS Code `.vscode/mcp.json` format. */
export function vscodeEntry(cmd: ServerCommand, plansFolder = '.agentic-whiteboard') {
  return {
    type: 'stdio',
    command: cmd.command,
    args: cmd.args,
    env: { ...cmd.env, AGENTIC_WHITEBOARD_ROOT: '${workspaceFolder}', ...plansEnv(plansFolder) },
  };
}

/** Cursor `.cursor/mcp.json` format; Cursor interpolates ${workspaceFolder}. */
export function cursorEntry(cmd: ServerCommand, plansFolder = '.agentic-whiteboard') {
  return {
    command: cmd.command,
    args: cmd.args,
    env: { ...cmd.env, AGENTIC_WHITEBOARD_ROOT: '${workspaceFolder}', ...plansEnv(plansFolder) },
  };
}

/** Cline's settings are global, so the root must be absolute. */
export function clineEntry(cmd: ServerCommand, root: string, plansFolder = '.agentic-whiteboard') {
  return {
    command: cmd.command,
    args: cmd.args,
    env: { ...cmd.env, AGENTIC_WHITEBOARD_ROOT: root, ...plansEnv(plansFolder) },
    disabled: false,
    autoApprove: [] as string[],
  };
}

/** OpenAI Codex `config.toml` section. JSON strings are valid TOML basic strings. */
export function codexToml(
  cmd: ServerCommand,
  root: string,
  plansFolder = '.agentic-whiteboard',
): string {
  const env = { ...cmd.env, AGENTIC_WHITEBOARD_ROOT: root, ...plansEnv(plansFolder) };
  const envText = Object.entries(env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(', ');
  return [
    '[mcp_servers."agentic-whiteboard"]',
    `command = ${JSON.stringify(cmd.command)}`,
    `args = [${cmd.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    `env = { ${envText} }`,
    '',
  ].join('\n');
}

/** Appends the section unless the file already has one (TOML forbids duplicate tables). */
export async function appendCodexConfig(
  file: string,
  section: string,
): Promise<'added' | 'exists'> {
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  if (/^\s*\[mcp_servers\."agentic-whiteboard"\]/m.test(existing)) return 'exists';
  const sep =
    existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, existing + sep + section, 'utf8');
  return 'added';
}

/**
 * Sets `<topKey>.agentic-whiteboard` in a JSON-with-comments file, keeping existing servers and comments.
 * Throws if the file exists but cannot be parsed, rather than overwriting it.
 */
export async function upsertServerConfig(
  file: string,
  topKey: string,
  entry: unknown,
): Promise<'created' | 'updated'> {
  let text = '';
  let existed = true;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existed = false;
  }
  if (!text.trim()) text = '{}';
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const why = errors.length ? printParseErrorCode(errors[0]!.error) : 'not a JSON object';
    throw new Error(`${path.basename(file)} could not be parsed (${why}); it was left unchanged.`);
  }
  const edits = modify(text, [topKey, 'agentic-whiteboard'], entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, applyEdits(text, edits).replace(/\s*$/, '\n'), 'utf8');
  return existed ? 'updated' : 'created';
}

export async function appendRule(file: string): Promise<boolean> {
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  if (existing.includes(RULE_MARKER)) return false;
  const sep =
    existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  await fs.writeFile(file, existing + sep + RULE_TEXT, 'utf8');
  return true;
}
