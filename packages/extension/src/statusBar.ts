import * as vscode from 'vscode';
import { parseFreeform, worstSeverity } from '@agentic-whiteboard/shared';
import type { BoardEditorProvider } from './boardEditor';

/** Shows the active whiteboard and how much is on it. */
export class PlanStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'agentic-whiteboard.status',
    vscode.StatusBarAlignment.Left,
    50,
  );
  private refreshing: NodeJS.Timeout | undefined;

  constructor(private readonly provider: BoardEditorProvider) {
    this.item.name = 'Agentic Whiteboard';
    this.item.command = 'agentic-whiteboard.openAsText';
  }

  /** Debounced refresh; an agent can change a board several times a second. */
  refresh() {
    if (this.refreshing) clearTimeout(this.refreshing);
    this.refreshing = setTimeout(() => this.update(), 150);
  }

  private update() {
    const board = this.provider.activeBoard;
    const plan = board?.current;
    if (!plan) {
      this.item.hide();
      return;
    }
    const count =
      plan.nodes.length +
      plan.comments.length +
      plan.constraints.length +
      plan.steps.length +
      parseFreeform(plan.freeform).freeform.shapes.length;
    const drift = (board?.code?.drift ?? []).filter((d) => d.severity !== 'info');
    const worst = worstSeverity(drift);
    this.item.text =
      `${board?.agentWorking ? '$(sync~spin) AI is drawing on' : '$(edit)'} ${plan.title} · ${count} element${count === 1 ? '' : 's'}` +
      (drift.length
        ? ` · $(${worst === 'error' ? 'error' : 'warning'}) ${drift.length} drift`
        : '');
    this.item.command = drift.length
      ? 'agentic-whiteboard.checkDrift'
      : 'agentic-whiteboard.openAsText';
    this.item.backgroundColor =
      worst === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      drift.length
        ? `**Agentic Whiteboard** - ${plan.title}\n\nThe diagram and the code disagree in ${drift.length} place${drift.length === 1 ? '' : 's'}. Click to check drift.`
        : `**Agentic Whiteboard** - ${plan.title}\n\nAsk your AI agent to draw on this board. Click to open it as JSON.`,
    );
    this.item.show();
  }

  dispose() {
    if (this.refreshing) clearTimeout(this.refreshing);
    this.item.dispose();
  }
}
