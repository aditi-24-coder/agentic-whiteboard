import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { config, plansFolderName } from './planFiles';

/**
 * The bundled server is copied to global storage so that agent configs point at a path that
 * survives extension updates (the extension's own folder name includes its version).
 */
export async function provisionServer(context: vscode.ExtensionContext): Promise<string> {
  const source = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
  const dir = context.globalStorageUri.fsPath;
  const target = path.join(dir, 'mcp-server.js');
  await fs.mkdir(dir, { recursive: true });
  const [src, dst] = await Promise.all([
    fs.readFile(source),
    fs.readFile(target).catch(() => undefined),
  ]);
  if (!dst || !src.equals(dst)) {
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, src);
    try {
      await fs.rename(tmp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      await fs.rm(target, { force: true });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  return target;
}

/**
 * Registers the server with VS Code's MCP support (Copilot agent mode) when the API exists.
 * Runs under VS Code's own Node.js (ELECTRON_RUN_AS_NODE), so no Node install is needed.
 */
export function registerMcpDefinitionProvider(
  context: vscode.ExtensionContext,
  serverPath: string,
): vscode.Disposable | undefined {
  const lm = vscode.lm as Partial<typeof vscode.lm> | undefined;
  if (
    typeof lm?.registerMcpServerDefinitionProvider !== 'function' ||
    typeof vscode.McpStdioServerDefinition !== 'function'
  ) {
    return undefined;
  }
  const changed = new vscode.EventEmitter<void>();
  const version = String(
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.0',
  );
  const registration = lm.registerMcpServerDefinitionProvider('agentic-whiteboard.mcp', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      if (!config().get<boolean>('registerMcpServer', true)) return [];
      const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
      const env: Record<string, string> = {
        ELECTRON_RUN_AS_NODE: '1',
        AGENTIC_WHITEBOARD_PLANS_FOLDER: plansFolderName(),
      };
      if (folder) env.AGENTIC_WHITEBOARD_ROOT = folder.uri.fsPath;
      return [
        new vscode.McpStdioServerDefinition(
          'Agentic Whiteboard',
          process.execPath,
          [serverPath],
          env,
          version,
        ),
      ];
    },
  });
  const listeners = [
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('agentic-whiteboard.registerMcpServer') ||
        e.affectsConfiguration('agentic-whiteboard.plansFolder')
      )
        changed.fire();
    }),
  ];
  return vscode.Disposable.from(registration, changed, ...listeners);
}
