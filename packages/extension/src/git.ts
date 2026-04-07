import * as path from 'node:path';
import * as vscode from 'vscode';

// Minimal typings for the built-in git extension API (extensions/git/src/api/git.d.ts).
interface GitRepository {
  readonly rootUri: vscode.Uri;
}
interface GitAPI {
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

async function gitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.enabled ? exports.getAPI(1) : undefined;
}

/** Opens a HEAD ↔ working tree diff for each file. Files outside a git repo just open. */
export async function openDiffs(files: vscode.Uri[]): Promise<void> {
  const api = await gitApi();
  for (const file of files) {
    const repo = api?.getRepository(file);
    if (!api || !repo) {
      await vscode.window.showTextDocument(file, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
      continue;
    }
    const title = `${path.basename(file.fsPath)} (HEAD ↔ Working Tree)`;
    await vscode.commands.executeCommand('vscode.diff', api.toGitUri(file, 'HEAD'), file, title, {
      preview: files.length === 1,
      viewColumn: vscode.ViewColumn.One,
    });
  }
}
