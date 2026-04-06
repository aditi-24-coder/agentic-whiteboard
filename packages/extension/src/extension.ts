import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  WHITEBOARD_EXT,
  blankBoard,
  codeSyncMode,
  isCodeSynced,
  parseFreeform,
  sortedSteps,
  type Plan,
} from '@agentic-whiteboard/shared';
import { createPlanFile, recordActiveBoard } from '@agentic-whiteboard/shared/node';
import { setupAgentIntegration } from './agentSetup';
import { BoardEditorProvider, type Board } from './boardEditor';
import { CodeIntel } from './codeSync';
import { provisionServer, registerMcpDefinitionProvider } from './mcp';
import {
  VIEW_TYPE,
  config,
  newBoard,
  openBoard,
  openLatestBoard,
  pickWorkspaceFolder,
  plansFolderName,
  recentlyCreated,
} from './planFiles';
import { PlanStatusBar } from './statusBar';

export interface TestApi {
  provider: BoardEditorProvider;
  serverPath: Promise<string>;
}

export function activate(context: vscode.ExtensionContext): TestApi {
  const intel = new CodeIntel();
  const provider = new BoardEditorProvider(context.extensionUri, intel);
  const statusBar = new PlanStatusBar(provider);
  const serverPath = provisionServer(context);
  let providerRegistered = false;

  context.subscriptions.push(
    BoardEditorProvider.register(context, provider),
    intel,
    statusBar,
    provider.onDidChange((board) => {
      statusBar.refresh();
      // Tell MCP servers (run by any agent) which board the user is looking at.
      if (board?.document.uri.scheme === 'file')
        void recordActiveBoard(board.document.uri.fsPath).catch(() => undefined);
    }),
    vscode.commands.registerCommand('agentic-whiteboard.newBoard', (target?: vscode.Uri) =>
      newBoard(target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand('agentic-whiteboard.openLatest', async () => {
      const active = provider.activeBoard;
      if (active) active.panel.reveal();
      else await openLatestBoard();
    }),
    vscode.commands.registerCommand('agentic-whiteboard.setupAgent', async () =>
      setupAgentIntegration(await serverPath, providerRegistered),
    ),
    vscode.commands.registerCommand(
      'agentic-whiteboard.generateArchitecture',
      (target?: vscode.Uri) =>
        generateArchitecture(provider, target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand('agentic-whiteboard.checkDrift', async () => {
      const board = await requireBoard(provider);
      await board?.checkDrift();
    }),
    vscode.commands.registerCommand('agentic-whiteboard.verifyStep', async () => {
      const board = await requireBoard(provider);
      const steps = sortedSteps(board?.current?.steps ?? []);
      if (!board) return;
      if (!steps.length) {
        void vscode.window.showInformationMessage(
          'Agentic Whiteboard: this board has no steps. Ask your AI to plan the change with steps first.',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        steps.map((s) => ({
          label: `${s.order}. ${s.title}`,
          description: s.verification ? `${s.verification.status}` : s.status.replace('_', ' '),
          id: s.id,
        })),
        { placeHolder: 'Which step should be verified?' },
      );
      if (pick) await board.verifyStep(pick.id);
    }),
    vscode.commands.registerCommand('agentic-whiteboard.askAiSync', async () => {
      const board = await requireBoard(provider);
      await board?.askAi('sync', []);
    }),
    vscode.commands.registerCommand('agentic-whiteboard.openAsText', async () => {
      const board = provider.activeBoard;
      if (board)
        await vscode.commands.executeCommand(
          'vscode.openWith',
          board.document.uri,
          'default',
          vscode.ViewColumn.Beside,
        );
    }),
  );

  serverPath.then(
    (p) => {
      const registration = registerMcpDefinitionProvider(context, p);
      if (registration) {
        providerRegistered = true;
        context.subscriptions.push(registration);
      }
    },
    (err) => console.error('Agentic Whiteboard: could not provision the MCP server', err),
  );

  // Open boards an agent creates (create_whiteboard) beside the editor. Files the user creates
  // in the Explorer are opened by VS Code itself.
  const opening = new Set<string>();
  const onCreate = async (uri: vscode.Uri) => {
    if (recentlyCreated.has(uri.fsPath) || !config().get<boolean>('autoOpen', true)) return;
    if (provider.boardFor(uri) || opening.has(uri.fsPath)) return;
    const stat = await vscode.workspace.fs.stat(uri).then(
      (s) => s,
      () => undefined,
    );
    // An empty file is a user's "New File"; VS Code opens that one in the active group.
    if (!stat?.size) return;
    opening.add(uri.fsPath);
    setTimeout(() => opening.delete(uri.fsPath), 5000);
    await new Promise((r) => setTimeout(r, 300));
    if (!provider.boardFor(uri)) await openBoard(uri, vscode.ViewColumn.Beside, true);
  };
  let legacy: vscode.FileSystemWatcher | undefined;
  const watchLegacy = () => {
    legacy?.dispose();
    legacy = vscode.workspace.createFileSystemWatcher(`**/${plansFolderName()}/*.plan.json`);
    legacy.onDidCreate(onCreate);
  };
  watchLegacy();
  const boards = vscode.workspace.createFileSystemWatcher(`**/*${WHITEBOARD_EXT}`);
  boards.onDidCreate(onCreate);
  context.subscriptions.push(
    boards,
    { dispose: () => legacy?.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentic-whiteboard.plansFolder')) watchLegacy();
    }),
  );
  statusBar.refresh();

  if (context.extensionMode === vscode.ExtensionMode.Test) registerTestCommands(context, provider);
  return { provider, serverPath };
}

async function requireBoard(provider: BoardEditorProvider): Promise<Board | undefined> {
  const board = provider.activeBoard;
  if (!board)
    void vscode.window.showInformationMessage('Agentic Whiteboard: open a whiteboard first.');
  return board;
}

/**
 * Syncs the active board with the code, or, with no board open (or from a folder in the
 * Explorer), creates `architecture.whiteboard` and fills it from the code.
 */
async function generateArchitecture(provider: BoardEditorProvider, target?: vscode.Uri) {
  const board = provider.activeBoard;
  const plan = board?.current;
  if (board && plan && !target) {
    // A board already about the code, or an empty one, is the obvious place. Anything else
    // (a sketch, a plan without links) should not fill up with modules unasked.
    const drawn = parseFreeform(plan.freeform).freeform.shapes.length + plan.comments.length;
    // A plain whiteboard (code sync off) is never filled from the code unasked.
    if (codeSyncMode(plan) !== 'off' && (isCodeSynced(plan) || (!plan.nodes.length && !drawn)))
      return board.syncFromCode();
    const here = `Add to "${plan.title}"`;
    const pick = await vscode.window.showQuickPick([here, 'New architecture board'], {
      placeHolder: 'Where should the architecture go?',
    });
    if (!pick) return;
    if (pick === here) return board.syncFromCode();
  }
  const ws = target ? vscode.workspace.getWorkspaceFolder(target) : await pickWorkspaceFolder();
  if (!ws) return;
  const folder = target
    ? path.relative(ws.uri.fsPath, target.fsPath).split(path.sep).join('/')
    : '';
  const name = folder ? `${path.basename(folder)}-architecture` : 'architecture';
  const file = path.join(ws.uri.fsPath, `${name}${WHITEBOARD_EXT}`);
  recentlyCreated.add(file);
  setTimeout(() => recentlyCreated.delete(file), 10_000);
  try {
    await createPlanFile(
      file,
      blankBoard(name, folder ? `${path.basename(folder)} architecture` : 'Architecture'),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const uri = vscode.Uri.file(file);
  await openBoard(uri);
  // The board registers once its webview has loaded the document.
  for (let i = 0; i < 100 && !provider.boardFor(uri)?.current; i++)
    await new Promise((r) => setTimeout(r, 100));
  const opened = provider.boardFor(uri);
  if (!opened?.current) {
    void vscode.window.showErrorMessage(
      `Agentic Whiteboard: ${path.basename(file)} did not open, so it was not filled from the code. Open it and click Code ▸ Generate from code.`,
    );
    return;
  }
  await opened.syncFromCode(folder ? { folder } : {});
}

/** Hooks for the @vscode/test-electron suite; only registered in test mode. */
function registerTestCommands(context: vscode.ExtensionContext, provider: BoardEditorProvider) {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentic-whiteboard._test.boards', () =>
      [...provider.boards].map((b) => ({
        uri: b.document.uri.toString(),
        revision: b.current?.revision,
        posted: b.postedCount,
        agentWorking: b.agentWorking,
      })),
    ),
    vscode.commands.registerCommand(
      'agentic-whiteboard._test.webviewEdit',
      async (uri: string, plan: Plan, baseRevision: number, immediate = true) => {
        const board = provider.boardFor(vscode.Uri.parse(uri));
        if (!board) throw new Error(`No board for ${uri}`);
        // Same path as a webview 'edit' message.
        await (board as unknown as { onMessage(m: unknown): Promise<void> }).onMessage({
          type: 'edit',
          plan,
          baseRevision,
          immediate,
        });
      },
    ),
    vscode.commands.registerCommand('agentic-whiteboard._test.viewType', () => VIEW_TYPE),
    vscode.commands.registerCommand(
      'agentic-whiteboard._test.code',
      (uri: string) => provider.boardFor(vscode.Uri.parse(uri))?.code,
    ),
  );
}

export function deactivate() {}
