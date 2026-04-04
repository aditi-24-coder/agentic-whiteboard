import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CodeIndex,
  detectDrift,
  formatDrift,
  codeSyncMode,
  hasCodeLinks,
  isCodeSynced,
  normalizeCodePath,
  syncBoardWithCode,
  type AskAiRequest,
  type CodeInfo,
  type CodeScan,
  type CodeState,
  type Plan,
  type PlanNode,
} from '@agentic-whiteboard/shared';
import { layoutSynced } from '@agentic-whiteboard/shared/layout';
import {
  detectVerifyCommand,
  gitChangedFiles,
  gitLog,
  gitOwners,
  scanRepo,
  verifyStep,
  type ScanCache,
} from '@agentic-whiteboard/shared/node';
import { config } from './planFiles';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,prisma}';
const RESCAN_DELAY_MS = 1500;

interface RootState {
  cache: ScanCache;
  scan?: CodeScan;
  running?: Promise<CodeScan>;
  stale: boolean;
  /** `git` changed files, briefly cached: drift is rechecked after every board edit. */
  changed?: { at: number; files: Promise<string[] | undefined> };
}

const CHANGED_FILES_TTL_MS = 3000;

/**
 * Keeps an up-to-date scan of each workspace root that has an open, code-linked board, and
 * tells boards when the code changes.
 */
export class CodeIntel implements vscode.Disposable {
  private readonly roots = new Map<string, RootState>();
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with a root after its code changed and was rescanned. */
  readonly onDidRescan = this.emitter.event;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly output = vscode.window.createOutputChannel('Agentic Whiteboard');

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    const changed = (uri: vscode.Uri) => {
      if (/[\\/](node_modules|\.git|dist|out)[\\/]/.test(uri.fsPath)) return;
      const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      const state = root && this.roots.get(root);
      if (!root || !state) return;
      state.stale = true;
      state.changed = undefined;
      clearTimeout(this.timers.get(root));
      this.timers.set(
        root,
        setTimeout(() => void this.scan(root).then(() => this.emitter.fire(root)), RESCAN_DELAY_MS),
      );
    };
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.disposables.push(
      watcher,
      this.emitter,
      this.output,
      // Trusting the folder turns git on: rescan so commits, owners and changes appear.
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        for (const [root, state] of this.roots) {
          state.stale = true;
          state.changed = undefined;
          void this.scan(root).then(() => this.emitter.fire(root));
        }
      }),
    );
  }

  private state(root: string): RootState {
    let state = this.roots.get(root);
    if (!state) this.roots.set(root, (state = { cache: new Map(), stale: true }));
    return state;
  }

  /** The latest scan of `root`; rescans when files changed since the last one. */
  scan(root: string, force = false): Promise<CodeScan> {
    const s = this.state(root);
    if (s.running) return s.running;
    if (s.scan && !s.stale && !force) return Promise.resolve(s.scan);
    s.stale = false;
    s.running = scanRepo(root, { cache: s.cache, git: gitAllowed() })
      .then((scan) => (s.scan = scan))
      .finally(() => (s.running = undefined));
    return s.running;
  }

  /** Files changed in the working tree, or undefined without git (or trust). */
  changedFiles(root: string): Promise<string[] | undefined> {
    if (!gitAllowed()) return Promise.resolve(undefined);
    const s = this.state(root);
    if (!s.changed || Date.now() - s.changed.at > CHANGED_FILES_TTL_MS)
      s.changed = { at: Date.now(), files: gitChangedFiles(root) };
    return s.changed.files;
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }
}

/** Git runs programs a repository's config names, so only in trusted folders. */
export function gitAllowed(): boolean {
  return vscode.workspace.isTrusted;
}

export function driftEnabled(): boolean {
  return config().get<boolean>('driftDetection', true);
}

/** Drift for a board, or an empty state when it has no code links. */
export async function codeState(intel: CodeIntel, root: string, plan: Plan): Promise<CodeState> {
  if (codeSyncMode(plan) === 'off') return { linked: hasCodeLinks(plan), drift: [], off: true };
  if (!driftEnabled()) return { linked: hasCodeLinks(plan), drift: [], disabled: true };
  if (!isCodeSynced(plan) || !hasCodeLinks(plan)) return { linked: false, drift: [] };
  const scan = await intel.scan(root);
  const changedFiles = await intel.changedFiles(root);
  return {
    linked: true,
    drift: detectDrift(plan, scan, changedFiles ? { changedFiles } : {}),
    scannedAt: scan.scannedAt,
    ...(scan.commit ? { commit: scan.commit } : {}),
  };
}

export function reportDrift(intel: CodeIntel, title: string, state: CodeState) {
  intel.output.appendLine(`[${new Date().toLocaleTimeString()}] ${title}`);
  intel.output.appendLine(formatDrift(state.drift));
  intel.output.appendLine('');
}

// Board actions

/** Merges the current code architecture into `plan`. */
export async function syncArchitecture(
  intel: CodeIntel,
  root: string,
  plan: Plan,
  opts: { folder?: string; prune?: boolean } = {},
) {
  const scan = await intel.scan(root, true);
  if (!scan.files.length)
    throw new Error('No TypeScript, JavaScript, Python, Go or Prisma files found in this folder.');
  const res = syncBoardWithCode(plan, scan, {
    ...(opts.folder ? { folder: opts.folder } : {}),
    maxNodes: config().get<number>('architectureMaxBoxes', 12),
    rootName: path.basename(root),
    ...(opts.prune === false ? { prune: false } : {}),
  });
  if (res.empty) throw new Error(`No source files under "${opts.folder}".`);
  return { ...res, plan: await layoutSynced(res.plan, res.added) };
}

export async function codeInfo(intel: CodeIntel, root: string, node: PlanNode): Promise<CodeInfo> {
  const index = CodeIndex.for(await intel.scan(root));
  const target = node.path ? (index.resolve(node.path) ?? normalizeCodePath(node.path)) : undefined;
  const files = target ? index.filesUnder(target).filter((f) => !f.test) : [];
  const usedBy = node.package ? index.importersOf(node.package).map((f) => f.path) : [];
  const gitTarget = gitAllowed()
    ? (target ?? (usedBy.length === 1 ? usedBy[0] : undefined))
    : undefined;
  const [owners, commits] = gitTarget
    ? await Promise.all([gitOwners(root, gitTarget), gitLog(root, gitTarget)])
    : [[], []];
  const take = (xs: string[]) => [...new Set(xs)].slice(0, 30);
  return {
    exists: target ? index.exists(target) : usedBy.length > 0,
    files: node.package ? usedBy.length : files.length,
    exports: take(files.flatMap((f) => f.exports)),
    routes: take(files.flatMap((f) => f.routes)),
    models: take(files.flatMap((f) => f.models)),
    packages: target ? index.packagesUnder(target) : [],
    tests: target ? index.testsFor(target).slice(0, 30) : [],
    owners,
    commits,
  };
}

async function revealSymbol(uri: vscode.Uri, symbol: string, column: vscode.ViewColumn) {
  const editor = await vscode.window.showTextDocument(uri, { viewColumn: column, preview: true });
  const symbols =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    )) ?? [];
  const find = (list: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
    for (const s of list) {
      if (s.name === symbol) return s;
      const inner = find(s.children ?? []);
      if (inner) return inner;
    }
    return undefined;
  };
  let range = find(symbols)?.selectionRange;
  if (!range) {
    // No symbol provider (or not found): fall back to the first declaration-looking line.
    const text = editor.document.getText();
    // The symbol comes from the board file, so it may contain regex characters.
    const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(
      `\\b(class|function|def|func|const|let|var|type|interface)\\s+${name}\\b`,
    ).exec(text);
    if (m) {
      const start = editor.document.positionAt(m.index);
      range = new vscode.Range(start, start);
    }
  }
  if (range) {
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } else {
    void vscode.window.showInformationMessage(
      `"${symbol}" was not found in ${path.basename(uri.fsPath)}.`,
    );
  }
}

/** Opens what a box stands for: its symbol, its file, a file in its folder, or its package's users. */
export async function openNodeCode(
  intel: CodeIntel,
  root: string,
  node: PlanNode,
  column: vscode.ViewColumn,
) {
  const abs = (p: string) => vscode.Uri.file(path.join(root, p));
  const pick = async (files: string[], placeHolder: string) => {
    if (files.length <= 1) return files[0];
    return vscode.window.showQuickPick(files, { placeHolder });
  };
  const index = CodeIndex.for(await intel.scan(root));
  if (node.path) {
    const p = index.resolve(node.path);
    if (p === undefined) {
      void vscode.window.showWarningMessage(
        `${normalizeCodePath(node.path)} does not exist${node.changeType === 'new' ? ' yet' : ''}.`,
      );
      return;
    }
    const isFile = index.paths.has(p);
    const file = isFile
      ? p
      : await pick(
          index.filesUnder(p).length ? index.filesUnder(p).map((f) => f.path) : index.pathsUnder(p),
          `Files in ${p}`,
        );
    if (!file) return;
    if (node.symbol) return revealSymbol(abs(file), node.symbol, column);
    await vscode.window.showTextDocument(abs(file), { viewColumn: column, preview: true });
    return;
  }
  if (node.package) {
    const users = index.importersOf(node.package).map((f) => f.path);
    if (!users.length) {
      void vscode.window.showInformationMessage(`No code imports "${node.package}".`);
      return;
    }
    const file = await pick(users, `Files that import ${node.package}`);
    if (file)
      await vscode.window.showTextDocument(abs(file), { viewColumn: column, preview: true });
    return;
  }
  void vscode.window.showInformationMessage(
    `"${node.label}" is not linked to code. Set its path in Properties, or sync the board from the code.`,
  );
}

/** The command to verify steps with: the setting, else a guess from the project's manifests. */
export async function verifyCommand(root: string): Promise<string | undefined> {
  const configured = config().get<string>('verifyCommand', '').trim();
  const guess = configured || (await detectVerifyCommand(root));
  const command = await vscode.window.showInputBox({
    title: 'Verify step',
    prompt:
      'Command that proves the step works. Leave empty to only check the code against the plan.',
    value: guess ?? '',
    placeHolder: 'e.g. npm test',
    ignoreFocusOut: true,
  });
  return command;
}

export async function runVerification(
  intel: CodeIntel,
  root: string,
  plan: Plan,
  stepId: string,
  command: string,
) {
  const scan = await intel.scan(root, true);
  const verification = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: command ? `Verifying step: ${command}` : 'Verifying step',
      cancellable: true,
    },
    (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      return verifyStep(root, plan, stepId, scan, {
        ...(command ? { command } : {}),
        signal: abort.signal,
      });
    },
  );
  // The scan it was judged on becomes the baseline for the step's boxes when it passes.
  return { verification, scan };
}

// Handing work to an AI agent

function describeIds(plan: Plan, ids: readonly string[]): string {
  const lines: string[] = [];
  for (const id of ids) {
    const n = plan.nodes.find((x) => x.id === id);
    if (n)
      lines.push(
        `- box ${n.id} "${n.label}"${n.path ? ` -> ${n.path}` : ''}${n.changeType !== 'unchanged' ? ` (${n.changeType})` : ''}`,
      );
    const e = plan.edges.find((x) => x.id === id);
    if (e) lines.push(`- arrow ${e.id}: ${e.from} -> ${e.to}${e.label ? ` "${e.label}"` : ''}`);
    const s = plan.steps.find((x) => x.id === id);
    if (s) lines.push(`- step ${s.id} #${s.order} "${s.title}"`);
  }
  return lines.join('\n');
}

/** Layout rules for any request that changes the diagram. */
const CLEAN_DIAGRAM =
  '\n\nKeep the diagram clean:\n' +
  '- High level: boxes for the major parts (services, apps, layers; folders, not files) plus real external systems (databases, caches, third-party APIs; not libraries). Merge boxes rather than adding near-duplicates.\n' +
  '- At most 20 boxes on one board. If the system has more parts, merge related ones into one box (e.g. one "Payments" box for several payment folders), or keep this board as an overview and draw each large area on its own board (create_whiteboard, generate_architecture with folder).\n' +
  '- Few arrows: one per real relationship, no duplicate or two-way pairs, no arrows into shared helpers or utilities. Labels of one or two words.\n' +
  '- Never set x/y on boxes and never hand-place them; arrows must not cross boxes or each other.\n' +
  '- Finish by calling tidy_layout once: it arranges the boxes and routes every arrow around them. The board stays locked for me until you do.';

export function aiPrompt(
  request: AskAiRequest,
  board: string,
  plan: Plan,
  ids: readonly string[],
  state: CodeState | undefined,
): string {
  const selection = ids.length ? `\n\nSelected on the board:\n${describeIds(plan, ids)}` : '';
  const relevant = (state?.drift ?? []).filter(
    (d) => !ids.length || !d.targetId || ids.includes(d.targetId),
  );
  const drift = relevant.length ? `\n\nCurrent drift:\n${formatDrift(relevant)}` : '';
  switch (request) {
    case 'sync':
      return (
        `Update the Agentic Whiteboard whiteboard "${board}" so its architecture matches the current code, as a clean, readable diagram. ` +
        'Call check_drift first and explain each difference (what changed in the code and why it matters). ' +
        'Then fix the diagram: generate_architecture re-syncs boxes generated from code; use update_elements, draw_diagram and remove_elements for hand-drawn ones. Keep names the user gave to boxes.' +
        CLEAN_DIAGRAM +
        selection +
        drift
      );
    case 'fix-drift':
      return (
        `The Agentic Whiteboard whiteboard "${board}" no longer matches the code. ` +
        'Explain what changed in the code for each drift item below, then propose whether to update the diagram or the code, and do it once I agree.' +
        CLEAN_DIAGRAM +
        selection +
        drift
      );
    case 'implement':
      return (
        `Implement the approved change shown on the Agentic Whiteboard whiteboard "${board}". ` +
        'Call read_whiteboard first. Respect every rule note (🚫) on the board. If a box that stands for code has no path, set one with update_elements before you start. ' +
        'Set the plan status to "in_progress" with update_elements, then work through the steps in order; after each one, call verify_step so the test result and diff are attached to it, and fix failures before moving on.' +
        selection
      );
  }
}

/** Opens the chat with the prompt when possible; it is always copied to the clipboard too. */
export async function askAi(prompt: string) {
  await vscode.env.clipboard.writeText(prompt);
  // VS Code's chat (Copilot) takes the prompt directly; terminal agents get it by pasting.
  await Promise.resolve(
    vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt }),
  ).catch(() => undefined);
  void vscode.window.showInformationMessage(
    'Agentic Whiteboard: the request is on your clipboard too. Paste it into your AI agent (Claude Code, Codex, Cursor…) if it did not open.',
  );
}
