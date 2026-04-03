import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  WHITEBOARD_EXT,
  blankBoard,
  boardBaseName,
  mergePlans,
  parsePlanText,
  serializePlan,
  slugify,
  type BoardSettings,
  codeSyncMode,
  type CodeState,
  type HostToWebview,
  type Plan,
  type WebviewToHost,
} from '@agentic-whiteboard/shared';
import { autoLayout } from '@agentic-whiteboard/shared/layout';
import {
  VerificationCancelled,
  attachVerification,
  isAgentWorking,
  readAgentActivity,
  withPlanLock,
  writePlanAtomic,
} from '@agentic-whiteboard/shared/node';
import {
  aiPrompt,
  askAi,
  codeInfo,
  codeState,
  openNodeCode,
  reportDrift,
  runVerification,
  syncArchitecture,
  verifyCommand,
  type CodeIntel,
} from './codeSync';
import { openDiffs } from './git';
import { VIEW_TYPE, config, rootForPlan } from './planFiles';
import { boardHtml } from './webviewHtml';

const EDIT_DEBOUNCE_MS = 200;

export function boardSettings(): BoardSettings {
  const c = config();
  return {
    theme: c.get<BoardSettings['theme']>('theme') ?? 'auto',
    sketch: c.get<boolean>('sketchStyle') ?? true,
  };
}

/** One open board: a webview bound to a plan TextDocument. */
export class Board implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Plans recently sent to the webview, by revision: the merge base for its edits. */
  private readonly sent = new Map<number, Plan>();
  private lastPostedText: string | undefined;
  private pending: { plan: Plan; baseRevision: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private applying: Promise<void> = Promise.resolve();
  private ready = false;
  /**
   * The document text as VS Code last loaded or saved it, i.e. what VS Code believes is on disk.
   * If the disk differs, an agent wrote in the meantime and a save would hit a conflict.
   */
  private syncedText: string | undefined;
  private lastMtime = 0;
  private readonly poll: NodeJS.Timeout | undefined;
  private initializing = false;
  postedCount = 0;
  current: Plan | undefined;
  /** Drift between this board and the code, once computed. */
  code: CodeState | undefined;
  private codeTimer: NodeJS.Timeout | undefined;
  private codeRun = 0;
  /** An AI agent is changing the board (via MCP); the board is read-only meanwhile. */
  agentWorking = false;
  /** When the user took the board back from the agent; older agent activity is ignored. */
  private takenOverAt = 0;

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly onChange: (board: Board) => void,
    private readonly intel: CodeIntel,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
    panel.webview.html = boardHtml(panel.webview, extensionUri);
    this.current = this.parsedPlan();
    this.syncedText = document.isDirty ? undefined : document.getText();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== document || !e.contentChanges.length) return;
        // A change that leaves the document clean is a reload from disk.
        if (!document.isDirty) this.syncedText = document.getText();
        this.sync();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d === document) this.syncedText = document.getText();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentic-whiteboard'))
          this.post({ type: 'settings', settings: boardSettings() });
        if (e.affectsConfiguration('agentic-whiteboard.driftDetection')) this.scheduleCode(0);
      }),
      intel.onDidRescan((root) => {
        if (root === this.root) this.scheduleCode(0);
      }),
      panel.onDidChangeViewState(() => {
        this.onChange(this);
        // Catch up on anything that changed while the board was in the background.
        if (panel.active) void this.catchUpWithDisk();
      }),
    );

    // VS Code reloads clean documents when the file changes on disk (an MCP write). A dirty
    // document is not reloaded, so merge disk changes into it instead.
    if (document.uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(path.dirname(document.uri.fsPath)),
          path.basename(document.uri.fsPath),
        ),
      );
      watcher.onDidChange(() => void this.onDiskChange());
      this.disposables.push(watcher);
      this.poll = setInterval(() => void this.pollDisk(), 1000);
    }
  }

  private parse() {
    const text = this.document.getText();
    if (!text.trim()) return undefined;
    return parsePlanText(text);
  }

  private parsedPlan(): Plan | undefined {
    const res = this.parse();
    return res?.ok ? res.plan : undefined;
  }

  private post(msg: HostToWebview) {
    if (!this.ready) return;
    this.postedCount++;
    void this.panel.webview.postMessage(msg);
  }

  /** Pushes the document to the webview. */
  sync(force = false) {
    const text = this.document.getText();
    if (!force && text === this.lastPostedText) return;
    const settings = boardSettings();
    if (!text.trim()) {
      this.lastPostedText = text;
      this.post({ type: 'empty', settings });
      if (this.document.uri.path.endsWith(WHITEBOARD_EXT)) void this.initBlank();
      return;
    }
    const res = parsePlanText(text);
    if (!res.ok) {
      this.lastPostedText = text;
      this.post({ type: 'invalid', errors: res.errors, settings });
      return;
    }
    this.current = res.plan;
    this.remember(res.plan);
    this.lastPostedText = text;
    this.post({ type: 'load', plan: res.plan, settings });
    this.onChange(this);
    this.scheduleCode();
  }

  get root(): string {
    return rootForPlan(this.document.uri);
  }

  /** Recomputes drift shortly after the plan changes; several quick edits cost one check. */
  scheduleCode(delay = 400) {
    if (this.codeTimer) clearTimeout(this.codeTimer);
    this.codeTimer = setTimeout(() => void this.refreshCode(), delay);
  }

  async refreshCode(force = false): Promise<CodeState | undefined> {
    const plan = this.current;
    if (!plan || this.document.uri.scheme !== 'file') return undefined;
    const run = ++this.codeRun;
    try {
      if (force) await this.intel.scan(this.root, true);
      const state = await codeState(this.intel, this.root, plan);
      if (run !== this.codeRun) return state; // A newer check started meanwhile.
      this.code = state;
      this.post({ type: 'code', state });
      this.onChange(this);
      return state;
    } catch (err) {
      this.intel.output.appendLine(
        `Drift check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Applies a change to the latest plan as one undoable, saved edit. `fn` may take a while (a
   * scan, a layout); edits the user makes meanwhile are saved first and ours merges on top, so
   * neither is lost.
   */
  async update(fn: (plan: Plan) => Plan | Promise<Plan>) {
    await this.landPendingEdit();
    const res = this.parse();
    if (!res?.ok) throw new Error('The whiteboard file is invalid; fix the JSON first.');
    // The merge base, should the user edit while `fn` runs.
    this.remember(res.plan);
    const plan = await fn(res.plan);
    await this.landPendingEdit();
    this.pending = { plan, baseRevision: res.plan.revision };
    await this.flush(true);
  }

  /** Saves a debounced webview edit now instead of letting a code action replace it. */
  private async landPendingEdit() {
    if (this.timer) clearTimeout(this.timer);
    if (this.pending) await this.flush(false);
    await this.applying;
  }

  /** Code actions need a board saved in a folder: that folder's code is what they read. */
  private requireFile(): boolean {
    if (this.document.uri.scheme === 'file') return true;
    void vscode.window.showInformationMessage(
      'Agentic Whiteboard: save this whiteboard in your project first; code sync reads the folder it is in.',
    );
    return false;
  }

  private async busy<T>(task: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.post({ type: 'busy', task });
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VerificationCancelled) {
        void vscode.window.showInformationMessage(
          'Agentic Whiteboard: verification cancelled. Nothing was attached to the step.',
        );
      } else {
        void vscode.window.showErrorMessage(
          `Agentic Whiteboard: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return undefined;
    } finally {
      this.post({ type: 'busy' });
    }
  }

  /**
   * A board with code sync off is a plain whiteboard. Code actions ask before turning it on,
   * instead of quietly treating someone's sketch as architecture.
   */
  private async allowCodeSync(action: string): Promise<boolean> {
    if (codeSyncMode(this.current ?? {}) !== 'off') return true;
    const turnOn = 'Turn code sync on';
    const answer = await vscode.window.showInformationMessage(
      `Agentic Whiteboard: code sync is off on this board (a plain whiteboard). Turn it on to ${action}?`,
      turnOn,
    );
    if (answer !== turnOn) return false;
    await this.update((plan) => ({ ...plan, codeSync: 'on' }));
    return true;
  }

  /** Generates or re-syncs the architecture from the code into this board. */
  async syncFromCode(opts: { folder?: string } = {}): Promise<void> {
    if (this.blockedByAgent()) return;
    if (!this.requireFile() || !(await this.allowCodeSync('fill it from the code'))) return;
    const r = await this.busy('Reading the code…', async () => {
      let result: Awaited<ReturnType<typeof syncArchitecture>> | undefined;
      await this.update(async (plan) => {
        const folder = opts.folder ?? plan.codebase?.folder;
        result = await syncArchitecture(this.intel, this.root, plan, folder ? { folder } : {});
        return result.plan;
      });
      return result;
    });
    if (!r) return;
    // The board shows the result; a passing note is enough, nothing to confirm.
    const parts =
      r.mode === 'link'
        ? [
            `kept your drawing, ${r.updated.length} boxes linked`,
            r.added.length ? `${r.added.length} systems added` : '',
          ]
        : [`${r.added.length} added`, `${r.updated.length} refreshed`];
    if (r.removed.length) parts.push(`${r.removed.length} outdated removed`);
    vscode.window.setStatusBarMessage(
      `$(check) Agentic Whiteboard: synced with the code (${parts.filter(Boolean).join(', ')})`,
      6000,
    );
  }

  async checkDrift() {
    if (!this.requireFile() || !(await this.allowCodeSync('compare it with the code'))) return;
    const state = await this.refreshCode(true);
    if (!state) return;
    reportDrift(this.intel, `Drift check: ${this.current?.title ?? ''}`, state);
    if (!state.linked) {
      const sync = 'Generate from code';
      const answer = await vscode.window.showInformationMessage(
        'Agentic Whiteboard: no boxes on this board are linked to code. Generate the architecture from the code?',
        sync,
      );
      if (answer === sync) await this.syncFromCode();
      return;
    }
    const serious = state.drift.filter((d) => d.severity !== 'info').length;
    const message = state.drift.length
      ? `Agentic Whiteboard: ${state.drift.length} drift item${state.drift.length === 1 ? '' : 's'} (${serious} needing attention).`
      : 'Agentic Whiteboard: no drift. The diagram matches the code.';
    const actions = state.drift.length ? ['Show details', 'Ask AI to fix'] : [];
    const answer = await vscode.window.showInformationMessage(message, ...actions);
    if (answer === 'Show details') this.intel.output.show(true);
    if (answer === 'Ask AI to fix') await this.askAi('fix-drift', []);
  }

  async verifyStep(stepId: string) {
    const step = this.current?.steps.find((s) => s.id === stepId);
    if (!step || this.blockedByAgent()) return;
    if (!this.requireFile() || !(await this.allowCodeSync('verify its steps'))) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'Agentic Whiteboard: verifying runs commands from this project. Trust the workspace first (Manage Workspace Trust).',
      );
      return;
    }
    const command = await verifyCommand(this.root);
    if (command === undefined) return;
    const v = await this.busy(`Verifying "${step.title}"…`, async () => {
      const { verification, scan } = await runVerification(
        this.intel,
        this.root,
        this.current!,
        stepId,
        command.trim(),
      );
      await this.update((p) => attachVerification(p, stepId, verification, scan));
      return verification;
    });
    if (!v) return;
    const show = 'Show evidence';
    const text = `Agentic Whiteboard: "${step.title}" is ${v.status}.${v.reasons.length ? ` ${v.reasons[0]}` : ''}`;
    const answer =
      v.status === 'verified'
        ? await vscode.window.showInformationMessage(text, show)
        : await vscode.window.showWarningMessage(text, show);
    if (answer === show) await this.openVerification(stepId);
  }

  private async openVerification(stepId: string) {
    const step = this.current?.steps.find((s) => s.id === stepId);
    const v = step?.verification;
    if (!step || !v) return;
    const content = [
      `# ${step.title}: ${v.status.toUpperCase()} (${new Date(v.at).toLocaleString()}${v.commit ? `, at ${v.commit}` : ''})`,
      ...v.reasons.map((r) => `# - ${r}`),
      v.command ? `# $ ${v.command}  -> exit ${v.exitCode}` : '# (no command ran)',
      ...(v.output ? ['#', ...v.output.split('\n').map((l) => `#   ${l}`)] : []),
      '',
      v.diffStat
        ? v.diffStat
            .split('\n')
            .map((l) => `# ${l}`)
            .join('\n')
        : '# No changed files.',
      '',
      v.diff ?? '',
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content });
    await vscode.window.showTextDocument(doc, { viewColumn: this.otherColumn(), preview: true });
  }

  async askAi(request: Parameters<typeof aiPrompt>[0], ids: string[]) {
    if (!this.current) return;
    await askAi(
      aiPrompt(
        request,
        vscode.workspace.asRelativePath(this.document.uri),
        this.current,
        ids,
        this.code,
      ),
    );
  }

  /** A new, empty `.whiteboard` file becomes a blank board. */
  private async initBlank() {
    if (this.initializing) return;
    this.initializing = true;
    try {
      const name = boardBaseName(this.document.uri.path);
      await this.replaceDocument(blankBoard(slugify(name), name));
      if (this.document.uri.scheme === 'file') await this.document.save();
    } finally {
      this.initializing = false;
    }
  }

  private remember(plan: Plan) {
    this.sent.set(plan.revision, plan);
    if (this.sent.size > 20) this.sent.delete(this.sent.keys().next().value!);
  }

  private get file() {
    return this.document.uri.fsPath;
  }

  private async readDisk(): Promise<{ text: string; plan?: Plan } | undefined> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const res = parsePlanText(text);
      return { text, plan: res.ok ? res.plan : undefined };
    } catch {
      return undefined;
    }
  }

  private syncedPlan(): Plan | undefined {
    if (this.syncedText === undefined) return undefined;
    const res = parsePlanText(this.syncedText);
    return res.ok ? res.plan : undefined;
  }

  /** Tells the board whether an agent is changing it, from what MCP servers record. */
  private async checkAgent() {
    if (this.document.uri.scheme !== 'file') return;
    const activity = await readAgentActivity(this.file);
    const working = isAgentWorking(activity) && activity!.at > this.takenOverAt;
    if (working === this.agentWorking) return;
    this.agentWorking = working;
    this.post({ type: 'agent', working });
    this.onChange(this);
  }

  /** Board-changing actions wait for the agent, so they do not fight over the board. */
  private blockedByAgent(): boolean {
    if (!this.agentWorking) return false;
    void vscode.window.showInformationMessage(
      'Agentic Whiteboard: your AI is still changing this board. Wait until it finishes, or click "Take over" on the board.',
    );
    return true;
  }

  private async onDiskChange() {
    if (this.document.uri.scheme !== 'file') return;
    void this.checkAgent();
    // VS Code normally reloads a clean document by itself; give it a moment first.
    if (!this.document.isDirty) await new Promise((r) => setTimeout(r, 300));
    await this.catchUpWithDisk();
  }

  /**
   * Safety net for live progress: file events can be missed (VS Code skips a change that lands
   * right after its own save), so check the file's mtime every second while the board is visible.
   */
  private async pollDisk() {
    if (!this.panel.visible) return;
    await this.checkAgent();
    const stat = await fs.stat(this.file).catch(() => undefined);
    if (!stat || stat.mtimeMs === this.lastMtime) return;
    this.lastMtime = stat.mtimeMs;
    await this.catchUpWithDisk();
  }

  private async catchUpWithDisk() {
    if (this.document.isDirty && (await this.mergeDiskIntoDirtyDocument())) return;
    const disk = await this.readDisk();
    if (!disk?.plan || disk.text === this.document.getText()) return;
    // VS Code has not reloaded the clean document: show the disk version on the board now...
    if (disk.text !== this.lastPostedText) {
      this.current = disk.plan;
      this.remember(disk.plan);
      this.lastPostedText = disk.text;
      this.post({ type: 'load', plan: disk.plan, settings: boardSettings() });
      this.onChange(this);
    }
    // ...and reload the document, which is safe because it has no unsaved changes. The revert
    // command acts on the active editor, so only run it while this board is the active one.
    if (this.panel.active) await vscode.commands.executeCommand('workbench.action.files.revert');
  }

  /**
   * A dirty document is not reloaded by VS Code, so merge the agent's disk write into it.
   * Resolves to false when the document turned out to be clean, for the caller to load instead.
   */
  private async mergeDiskIntoDirtyDocument(): Promise<boolean> {
    return withPlanLock(this.file, async () => {
      // The poll can see our own save land before VS Code marks the document clean; by the time
      // we hold the lock that save has finished. Merging it into itself would bump the revision
      // and leave the document dirty, so every later disk change would be merged, never loaded.
      if (!this.document.isDirty) return false;
      const disk = await this.readDisk();
      const ours = this.parse();
      if (!disk?.plan || !ours?.ok || disk.text === this.syncedText) return true;
      if (disk.text === this.document.getText()) return true;
      const merged = mergePlans(this.syncedPlan() ?? ours.plan, ours.plan, disk.plan);
      merged.revision = Math.max(disk.plan.revision, ours.plan.revision) + 1;
      await this.replaceDocument(merged);
      // Not saved: VS Code would report a conflict. The user's next save writes the merged plan.
      return true;
    });
  }

  private async onMessage(m: WebviewToHost) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.sync(true);
        if (this.code) this.post({ type: 'code', state: this.code });
        this.post({ type: 'agent', working: this.agentWorking });
        void this.checkAgent();
        break;
      case 'takeOver':
        this.takenOverAt = Date.now();
        this.agentWorking = false;
        this.post({ type: 'agent', working: false });
        this.onChange(this);
        break;
      case 'edit':
        this.pending = { plan: m.plan, baseRevision: m.baseRevision };
        if (this.timer) clearTimeout(this.timer);
        if (m.immediate) await this.flush(true);
        else this.timer = setTimeout(() => void this.flush(false), EDIT_DEBOUNCE_MS);
        break;
      case 'openFile':
        await this.openFile(m.path);
        break;
      case 'openStepDiff':
        await this.openStepDiff(m.stepId);
        break;
      case 'relayout':
        await this.relayout(m.force ?? true);
        break;
      case 'undo':
      case 'redo':
        this.panel.reveal(undefined, false);
        await vscode.commands.executeCommand(m.type);
        break;
      case 'export':
        await this.saveExport(m.format, m.data, m.encoding, m.selection);
        break;
      case 'openAsText':
        await vscode.commands.executeCommand(
          'vscode.openWith',
          this.document.uri,
          'default',
          vscode.ViewColumn.Beside,
        );
        break;
      case 'error':
        void vscode.window.showErrorMessage(`Agentic Whiteboard: ${m.message}`);
        break;
      case 'openCode': {
        const node = this.current?.nodes.find((n) => n.id === m.nodeId);
        if (node) await openNodeCode(this.intel, this.root, node, this.otherColumn());
        break;
      }
      case 'codeInfo': {
        const node = this.current?.nodes.find((n) => n.id === m.nodeId);
        if (!node || this.document.uri.scheme !== 'file') break;
        const info = await codeInfo(this.intel, this.root, node).catch(() => undefined);
        if (info) this.post({ type: 'codeInfo', nodeId: node.id, info });
        break;
      }
      case 'syncFromCode':
        await this.syncFromCode();
        break;
      case 'checkDrift':
        await this.checkDrift();
        break;
      case 'verifyStep':
        await this.verifyStep(m.stepId);
        break;
      case 'openVerification':
        await this.openVerification(m.stepId);
        break;
      case 'askAi':
        await this.askAi(m.request, m.ids);
        break;
    }
  }

  /**
   * Applies the latest pending webview edit. Serialised, and done under the same lock as MCP
   * writers, so an agent write cannot land between our merge and our save.
   */
  flush(forceSave: boolean): Promise<void> {
    this.timer = undefined;
    this.applying = this.applying.then(async () => {
      const edit = this.pending;
      this.pending = undefined;
      if (!edit) return;
      const res = this.parse();
      if (res && !res.ok) {
        void vscode.window.showErrorMessage(
          'Agentic Whiteboard: the whiteboard file is invalid, so the board edit was not saved. Fix the JSON first.',
        );
        return;
      }
      const run =
        this.document.uri.scheme === 'file'
          ? (fn: () => Promise<void>) => withPlanLock(this.file, fn)
          : (fn: () => Promise<void>) => fn();
      await run(async () => {
        const current = this.parse();
        const docPlan = current?.ok ? current.plan : undefined;
        let next = edit.plan;
        if (docPlan && docPlan.revision !== edit.baseRevision) {
          // The document moved on (agent write, undo, text edit) while the user was editing.
          next = mergePlans(this.sent.get(edit.baseRevision) ?? docPlan, next, docPlan);
        }
        const disk = this.document.uri.scheme === 'file' ? await this.readDisk() : undefined;
        if (disk && disk.text !== this.syncedText && !disk.plan && disk.text.trim()) {
          void vscode.window.showErrorMessage(
            'Agentic Whiteboard: the whiteboard file on disk is invalid, so the board edit was not saved.',
          );
          return;
        }
        const diskAhead =
          !!disk?.plan && disk.text !== this.syncedText && disk.text !== this.document.getText();
        if (diskAhead)
          next = mergePlans(this.syncedPlan() ?? docPlan ?? disk.plan!, next, disk.plan!);
        next = {
          ...next,
          revision:
            Math.max(docPlan?.revision ?? 0, disk?.plan?.revision ?? 0, edit.baseRevision) + 1,
          updatedAt: new Date().toISOString(),
        };
        if (diskAhead) {
          // VS Code has not caught up with the agent's write, so saving the document would be
          // reported as a conflict. Write the merged plan ourselves and let VS Code reload it.
          await writePlanAtomic(this.file, next);
          if (this.document.isDirty) {
            await this.replaceDocument(next);
            if (this.panel.active)
              await vscode.commands.executeCommand('workbench.action.files.revert');
          }
          return;
        }
        await this.replaceDocument(next);
        if (forceSave || config().get<boolean>('autoSave', true)) await this.document.save();
      });
    });
    return this.applying;
  }

  private async replaceDocument(plan: Plan) {
    const text = serializePlan(plan);
    if (text === this.document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    const doc = this.document;
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      text,
    );
    await vscode.workspace.applyEdit(edit);
  }

  private resolveRepoPath(p: string): vscode.Uri {
    return vscode.Uri.file(path.isAbsolute(p) ? p : path.join(rootForPlan(this.document.uri), p));
  }

  private otherColumn() {
    return this.panel.viewColumn === vscode.ViewColumn.One
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;
  }

  private async openFile(p: string) {
    const uri = this.resolveRepoPath(p);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showInformationMessage(`${p} does not exist yet.`);
      return;
    }
    await vscode.window.showTextDocument(uri, { viewColumn: this.otherColumn(), preview: true });
  }

  private async openStepDiff(stepId: string) {
    const plan = this.current;
    const step = plan?.steps.find((s) => s.id === stepId);
    if (!plan || !step) return;
    const paths = step.nodeIds
      .map((id) => plan.nodes.find((n) => n.id === id)?.path)
      .filter((p): p is string => !!p);
    if (!paths.length) {
      void vscode.window.showInformationMessage(`Step "${step.title}" has no linked files.`);
      return;
    }
    let chosen = paths;
    if (paths.length > 1) {
      const pick = await vscode.window.showQuickPick(['All files', ...paths], {
        placeHolder: `Changes for "${step.title}"`,
      });
      if (!pick) return;
      chosen = pick === 'All files' ? paths : [pick];
    }
    await openDiffs(chosen.map((p) => this.resolveRepoPath(p)));
  }

  private async relayout(force: boolean) {
    // Only the user's Re-layout waits; placing elements that have no position yet is harmless.
    if (force && this.blockedByAgent()) return;
    // A debounced board edit would otherwise be replaced by the layout below and lost.
    await this.landPendingEdit();
    const res = this.parse();
    if (!res?.ok) return;
    const laid = await autoLayout(res.plan, { force });
    this.pending = { plan: laid, baseRevision: res.plan.revision };
    await this.flush(false);
  }

  private async saveExport(
    format: 'png' | 'svg',
    data: string,
    encoding: 'base64' | 'utf8',
    selection?: boolean,
  ) {
    const base =
      (this.current?.id ?? boardBaseName(this.document.uri.fsPath)) +
      (selection ? '-selection' : '');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(rootForPlan(this.document.uri), `${base}.${format}`)),
      filters: format === 'png' ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(data, encoding));
    void vscode.window.showInformationMessage(
      `Exported ${selection ? 'the selection' : 'the board'} to ${vscode.workspace.asRelativePath(target)}.`,
    );
  }

  requestExport(format: 'png' | 'svg') {
    this.post({ type: 'requestExport', format });
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.codeTimer) clearTimeout(this.codeTimer);
    if (this.poll) clearInterval(this.poll);
    for (const d of this.disposables) d.dispose();
    // An edit made just before the board closed may still be waiting for its debounce.
    const edit = this.pending;
    this.pending = undefined;
    if (edit) void this.savePendingOnClose(edit);
  }

  /**
   * The board closed before its last edit was applied. The editor is gone, so write the edit to
   * the file directly, merged with whatever is there. With auto-save off, ask first.
   */
  private async savePendingOnClose(edit: { plan: Plan; baseRevision: number }) {
    if (this.document.uri.scheme !== 'file') return;
    if (!config().get<boolean>('autoSave', true)) {
      const save = 'Save';
      const answer = await vscode.window.showWarningMessage(
        `Agentic Whiteboard: ${path.basename(this.file)} was closed right after a change on the board. Save that change?`,
        save,
        'Discard',
      );
      if (answer !== save) return;
    }
    try {
      await this.applying;
      await withPlanLock(this.file, async () => {
        const disk = await this.readDisk();
        // Never overwrite a file that is missing or invalid.
        if (!disk?.plan) return;
        const next =
          disk.plan.revision === edit.baseRevision
            ? edit.plan
            : mergePlans(this.sent.get(edit.baseRevision) ?? disk.plan, edit.plan, disk.plan);
        await writePlanAtomic(this.file, {
          ...next,
          revision: Math.max(disk.plan.revision, edit.baseRevision) + 1,
          updatedAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Agentic Whiteboard: the last change to ${path.basename(this.file)} could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export class BoardEditorProvider implements vscode.CustomTextEditorProvider {
  readonly boards = new Set<Board>();
  private active: Board | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<Board | undefined>();
  /** Fires when the active board changes or its plan changes. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly intel: CodeIntel,
  ) {}

  static register(
    context: vscode.ExtensionContext,
    provider: BoardEditorProvider,
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  get activeBoard(): Board | undefined {
    return this.active;
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const board = new Board(
      document,
      panel,
      this.extensionUri,
      (b) => {
        if (b.panel.active) this.active = b;
        else if (this.active === b && !b.panel.visible) this.active = undefined;
        this.changeEmitter.fire(this.active);
      },
      this.intel,
    );
    this.boards.add(board);
    if (panel.active) this.active = board;
    panel.onDidDispose(() => {
      board.dispose();
      this.boards.delete(board);
      if (this.active === board) this.active = undefined;
      this.changeEmitter.fire(this.active);
    });
    this.changeEmitter.fire(this.active);
  }

  boardFor(uri: vscode.Uri): Board | undefined {
    for (const b of this.boards) if (b.document.uri.toString() === uri.toString()) return b;
    return undefined;
  }
}
