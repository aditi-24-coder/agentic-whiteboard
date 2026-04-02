import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  RULE_MARKER,
  appendCodexConfig,
  appendRule,
  claudeCodeEntry,
  clineEntry,
  codexToml,
  cursorEntry,
  plansEnv as plansEnvFor,
  serverCommand,
  upsertServerConfig,
  vscodeEntry,
  type Launch,
  type Runtime,
} from './configFiles';
import { config, pickWorkspaceFolder, plansFolderName } from './planFiles';

const plansEnv = () => plansEnvFor(plansFolderName());

/** Whether `node` runs from the PATH, which agents use to start the bundled server. */
function hasNode(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('node', ['--version'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err)),
  );
}

async function detectRuntime(): Promise<Runtime> {
  return { platform: process.platform, hasNode: await hasNode(), execPath: process.execPath };
}

async function askLaunch(rt: Runtime): Promise<Launch | undefined> {
  const windows = rt.platform === 'win32';
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'Bundled server',
        description: rt.hasNode
          ? 'Node.js + the copy shipped with this extension'
          : "VS Code's runtime + the copy shipped with this extension",
        detail:
          (rt.hasNode
            ? 'Works offline.'
            : 'Works offline, without Node.js (none was found on your PATH).') +
          ' The path is specific to this machine, so keep the config file out of git if teammates use it.',
        launch: 'bundled' as const,
      },
      {
        label: 'npx agentic-whiteboard-mcp',
        description: windows ? 'via cmd /c, for Windows' : 'portable',
        detail:
          (rt.hasNode
            ? 'Needs Node.js and network access the first time.'
            : 'Needs Node.js (not found on your PATH: install it first) and network access the first time.') +
          (windows
            ? ' Written as "cmd /c npx …", which agents on Windows need; teammates on macOS or Linux need "npx" instead.'
            : ' The same config works on every macOS and Linux machine.'),
        launch: 'npx' as const,
      },
    ],
    { placeHolder: 'How should the agent start the Agentic Whiteboard MCP server?' },
  );
  return pick?.launch;
}

async function offerRule(root: string, fileName: string) {
  const file = path.join(root, fileName);
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  if (existing.includes(RULE_MARKER)) return;
  const choice = await vscode.window.showInformationMessage(
    `Add a short Agentic Whiteboard note to ${fileName}? It tells the agent to use the whiteboard tools when you ask it to draw.`,
    'Add Rule',
    'Not Now',
  );
  if (choice === 'Add Rule') {
    await appendRule(file);
    void vscode.window.showInformationMessage(`Added the Agentic Whiteboard rule to ${fileName}.`);
  }
}

/** Shows a config snippet to paste: JSON, or TOML when given a string. */
async function showSnippet(title: string, instructions: string[], snippet: unknown) {
  const toml = typeof snippet === 'string';
  const text = toml ? snippet : JSON.stringify(snippet, null, 2);
  const c = toml ? '#' : '//';
  await vscode.env.clipboard.writeText(text);
  const doc = await vscode.workspace.openTextDocument({
    language: toml ? 'toml' : 'jsonc',
    content: `${c} ${title}\n${instructions.map((l) => `${c} ${l}`).join('\n')}\n${c} (This snippet is already on your clipboard.)\n${text}\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

type Target = 'claude' | 'vscode' | 'codex' | 'cline' | 'cursor' | 'copy';

export async function setupAgentIntegration(
  serverPath: string,
  providerRegistered: boolean,
  preset?: Target,
): Promise<void> {
  const target =
    preset ??
    (
      await vscode.window.showQuickPick(
        [
          { label: 'Claude Code', description: 'writes .mcp.json', target: 'claude' as const },
          {
            label: 'VS Code / GitHub Copilot',
            description: 'writes .vscode/mcp.json',
            target: 'vscode' as const,
          },
          {
            label: 'OpenAI Codex',
            description: 'adds to ~/.codex/config.toml or shows the config',
            target: 'codex' as const,
          },
          { label: 'Cline', description: 'shows the config to paste', target: 'cline' as const },
          {
            label: 'Cursor',
            description: 'writes .cursor/mcp.json or shows the config',
            target: 'cursor' as const,
          },
          {
            label: 'Copy config',
            description: 'generic mcpServers JSON to the clipboard',
            target: 'copy' as const,
          },
        ],
        { placeHolder: 'Which AI should draw on your Agentic Whiteboard whiteboards?' },
      )
    )?.target;
  if (!target) return;

  const folder = await pickWorkspaceFolder();
  if (!folder) return;
  const root = folder.uri.fsPath;
  const rt = await detectRuntime();

  try {
    switch (target) {
      case 'claude': {
        const launch = await askLaunch(rt);
        if (!launch) return;
        const result = await upsertServerConfig(
          path.join(root, '.mcp.json'),
          'mcpServers',
          claudeCodeEntry(serverCommand(launch, serverPath, rt), plansFolderName()),
        );
        void vscode.window.showInformationMessage(
          `Agentic Whiteboard ${result === 'created' ? 'added to a new' : 'added to'} .mcp.json. Restart Claude Code in this folder and approve the "agentic-whiteboard" server when asked.`,
        );
        await offerRule(root, 'CLAUDE.md');
        break;
      }
      case 'vscode': {
        if (providerRegistered && config().get<boolean>('registerMcpServer', true)) {
          const choice = await vscode.window.showInformationMessage(
            'Agentic Whiteboard is already registered with VS Code automatically, so Copilot agent mode can use it now. Write .vscode/mcp.json as well (e.g. for teammates without this extension)? You would see the tools twice.',
            'Keep Automatic Only',
            'Write .vscode/mcp.json',
          );
          if (choice !== 'Write .vscode/mcp.json') {
            await offerRule(root, 'AGENTS.md');
            return;
          }
        }
        const launch = await askLaunch(rt);
        if (!launch) return;
        await upsertServerConfig(
          path.join(root, '.vscode', 'mcp.json'),
          'servers',
          vscodeEntry(serverCommand(launch, serverPath, rt), plansFolderName()),
        );
        void vscode.window.showInformationMessage(
          'Agentic Whiteboard added to .vscode/mcp.json. Start it from the MCP Servers view or the file\'s "Start" code lens.',
        );
        await offerRule(root, 'AGENTS.md');
        break;
      }
      case 'cursor': {
        const launch = await askLaunch(rt);
        if (!launch) return;
        const entry = cursorEntry(serverCommand(launch, serverPath, rt), plansFolderName());
        const choice = await vscode.window.showInformationMessage(
          'Cursor reads project MCP servers from .cursor/mcp.json (or ~/.cursor/mcp.json for all projects).',
          'Write .cursor/mcp.json',
          'Show Snippet',
        );
        if (choice === 'Write .cursor/mcp.json') {
          await upsertServerConfig(path.join(root, '.cursor', 'mcp.json'), 'mcpServers', entry);
          void vscode.window.showInformationMessage(
            'Agentic Whiteboard added to .cursor/mcp.json. Enable it in Cursor Settings -> MCP.',
          );
        } else if (choice === 'Show Snippet') {
          await showSnippet(
            'Agentic Whiteboard for Cursor',
            ['Merge into .cursor/mcp.json (project) or ~/.cursor/mcp.json (global).'],
            { mcpServers: { 'agentic-whiteboard': entry } },
          );
        } else return;
        await offerRule(root, 'AGENTS.md');
        break;
      }
      case 'codex': {
        const launch = await askLaunch(rt);
        if (!launch) return;
        const section = codexToml(serverCommand(launch, serverPath, rt), root, plansFolderName());
        const file = path.join(os.homedir(), '.codex', 'config.toml');
        const choice = await vscode.window.showInformationMessage(
          'Codex reads MCP servers from ~/.codex/config.toml. The entry points AGENTIC_WHITEBOARD_ROOT at this folder.',
          'Add to config.toml',
          'Show Snippet',
        );
        if (choice === 'Add to config.toml') {
          if ((await appendCodexConfig(file, section)) === 'exists') {
            await showSnippet(
              'Agentic Whiteboard for OpenAI Codex',
              [
                `${file} already has a [mcp_servers.agentic-whiteboard] section.`,
                'Replace it with the one below to point it at this folder.',
              ],
              section,
            );
          } else {
            void vscode.window.showInformationMessage(
              'Agentic Whiteboard added to ~/.codex/config.toml. Restart Codex; "agentic-whiteboard" shows up under /mcp.',
            );
          }
        } else if (choice === 'Show Snippet') {
          await showSnippet(
            'Agentic Whiteboard for OpenAI Codex',
            [`Add to ${file}, then restart Codex.`],
            section,
          );
        } else return;
        await offerRule(root, 'AGENTS.md');
        break;
      }
      case 'cline': {
        const launch = await askLaunch(rt);
        if (!launch) return;
        await showSnippet(
          'Agentic Whiteboard for Cline',
          [
            'In Cline: click the MCP Servers icon -> Configure tab -> "Configure MCP Servers".',
            'That opens cline_mcp_settings.json. Merge the "agentic-whiteboard" entry below into its "mcpServers".',
            'Cline settings are global, so AGENTIC_WHITEBOARD_ROOT points at this folder. Change it per project if needed.',
          ],
          {
            mcpServers: {
              'agentic-whiteboard': clineEntry(
                serverCommand(launch, serverPath, rt),
                root,
                plansFolderName(),
              ),
            },
          },
        );
        await offerRule(root, 'AGENTS.md');
        break;
      }
      case 'copy': {
        const launch = await askLaunch(rt);
        if (!launch) return;
        const cmd = serverCommand(launch, serverPath, rt);
        await vscode.env.clipboard.writeText(
          JSON.stringify(
            {
              mcpServers: {
                'agentic-whiteboard': {
                  ...cmd,
                  env: { ...cmd.env, AGENTIC_WHITEBOARD_ROOT: root, ...plansEnv() },
                },
              },
            },
            null,
            2,
          ),
        );
        void vscode.window.showInformationMessage(
          'Agentic Whiteboard MCP config copied to the clipboard.',
        );
        break;
      }
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Agentic Whiteboard setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
