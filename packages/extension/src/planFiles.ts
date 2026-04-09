import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  WHITEBOARD_EXT,
  blankBoard,
  boardBaseName,
  slugify,
  uniqueId,
} from '@agentic-whiteboard/shared';
import { createPlanFile } from '@agentic-whiteboard/shared/node';

export const VIEW_TYPE = 'agentic-whiteboard.board';

export function config() {
  return vscode.workspace.getConfiguration('agentic-whiteboard');
}

/** Legacy folder for `.plan.json` boards; still read, and passed to the MCP server. */
export function plansFolderName(): string {
  return config().get<string>('plansFolder') || '.agentic-whiteboard';
}

/** The repo root a board belongs to: its workspace folder, or the folder it sits in. */
export function rootForPlan(planUri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(planUri);
  if (folder) return folder.uri.fsPath;
  const dir = path.dirname(planUri.fsPath);
  return path.basename(dir) === plansFolderName() ? path.dirname(dir) : dir;
}

const EXCLUDE = '**/{node_modules,.git,dist,out,build,coverage,target,.next,.venv,venv}/**';

/** Board files in the workspace, newest first. */
export async function listAllBoards(): Promise<{ uri: vscode.Uri; mtime: number }[]> {
  const uris = await vscode.workspace.findFiles(
    `**/{*${WHITEBOARD_EXT},*.plan.json}`,
    EXCLUDE,
    500,
  );
  const stats = await Promise.all(
    uris.map(async (uri) => ({
      uri,
      mtime: await vscode.workspace.fs.stat(uri).then(
        (s) => s.mtime,
        () => 0,
      ),
    })),
  );
  return stats.sort((a, b) => b.mtime - a.mtime);
}

export async function openBoard(
  uri: vscode.Uri,
  column: vscode.ViewColumn = vscode.ViewColumn.Active,
  preserveFocus = false,
) {
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
    viewColumn: column,
    preserveFocus,
  });
}

export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  if (!folders.length) {
    const choice = await vscode.window.showErrorMessage(
      'Agentic Whiteboard needs an open folder to store whiteboards in.',
      'Open Folder…',
    );
    if (choice) await vscode.commands.executeCommand('vscode.openFolder');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Workspace folder for the whiteboard',
  });
}

/** Paths created by this extension recently, so the auto-open watcher does not open them twice. */
export const recentlyCreated = new Set<string>();

/**
 * Creates `<name>.whiteboard` and opens it in the current editor group. `target` is the folder
 * (or a file in the folder) clicked in the Explorer; otherwise the workspace root.
 */
export async function newBoard(target?: vscode.Uri): Promise<vscode.Uri | undefined> {
  let dir: string | undefined;
  if (target?.scheme === 'file') {
    const stat = await vscode.workspace.fs.stat(target).then(
      (s) => s,
      () => undefined,
    );
    dir = stat?.type === vscode.FileType.Directory ? target.fsPath : path.dirname(target.fsPath);
  } else {
    dir = (await pickWorkspaceFolder())?.uri.fsPath;
  }
  if (!dir) return undefined;
  const title = await vscode.window.showInputBox({
    prompt: 'Whiteboard name',
    placeHolder: 'e.g. Checkout flow',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!title) return undefined;
  const taken = new Set(
    (
      await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)).then(
        (entries) => entries.map(([n]) => n),
        () => [] as string[],
      )
    )
      .filter((n) => n.endsWith(WHITEBOARD_EXT))
      .map(boardBaseName),
  );
  const id = uniqueId(slugify(title), taken);
  const file = path.join(dir, `${id}${WHITEBOARD_EXT}`);
  recentlyCreated.add(file);
  setTimeout(() => recentlyCreated.delete(file), 10_000);
  await createPlanFile(file, blankBoard(id, title.trim()));
  const uri = vscode.Uri.file(file);
  await openBoard(uri);
  return uri;
}

export async function openLatestBoard(): Promise<void> {
  const [latest] = await listAllBoards();
  if (!latest) {
    const choice = await vscode.window.showInformationMessage(
      `No whiteboards yet. Create one, or add any file ending in ${WHITEBOARD_EXT}.`,
      'New Whiteboard',
      'Set Up AI Integration',
    );
    if (choice === 'New Whiteboard')
      await vscode.commands.executeCommand('agentic-whiteboard.newBoard');
    if (choice === 'Set Up AI Integration')
      await vscode.commands.executeCommand('agentic-whiteboard.setupAgent');
    return;
  }
  await openBoard(latest.uri);
}
