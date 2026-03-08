import type { DriftItem } from './drift.js';
import type { Plan } from './schema.js';

/** Messages between the extension host and the board webview. */

export interface BoardSettings {
  theme: 'auto' | 'light' | 'dark';
  sketch: boolean;
}

/** What the code says about one box, for the Properties panel. */
export interface CodeInfo {
  exists: boolean;
  /** Source files under the box's path. */
  files: number;
  exports: string[];
  routes: string[];
  models: string[];
  /** External packages its code imports. */
  packages: string[];
  tests: string[];
  owners: { name: string; commits: number }[];
  commits: { hash: string; author: string; date: string; subject: string }[];
}

/** Drift between the board and the code, recomputed as either changes. */
export interface CodeState {
  /** The board has boxes linked to code. */
  linked: boolean;
  drift: DriftItem[];
  scannedAt?: string;
  commit?: string;
  /** Turned off in settings. */
  disabled?: boolean;
  /** Code sync is off on this board: a plain whiteboard. */
  off?: boolean;
}

export type AskAiRequest =
  /** Update the diagram to match the code. */
  | 'sync'
  /** Explain the drift on the selection (or the board) and fix it. */
  | 'fix-drift'
  /** Implement the approved change the selected flow represents. */
  | 'implement';

export type HostToWebview =
  | { type: 'load'; plan: Plan; settings: BoardSettings }
  /** The document is not a valid plan. The board stays read-only until it is fixed. */
  | { type: 'invalid'; errors: string[]; settings: BoardSettings }
  /** The document is empty, e.g. a plan file that is still being written. */
  | { type: 'empty'; settings: BoardSettings }
  | { type: 'settings'; settings: BoardSettings }
  | { type: 'requestExport'; format: 'png' | 'svg' }
  | { type: 'code'; state: CodeState }
  | { type: 'codeInfo'; nodeId: string; info: CodeInfo }
  /** A long code task (sync, verify) started or finished. */
  | { type: 'busy'; task?: string }
  /** An AI agent is (or stopped) changing the board; the board is read-only meanwhile. */
  | { type: 'agent'; working: boolean };

export type WebviewToHost =
  | { type: 'ready' }
  /**
   * A committed canvas change. `baseRevision` is the revision the webview edited from; the
   * host merges if the document moved on in the meantime. `immediate` skips the debounce and
   * always saves, for approve and request-changes.
   */
  | { type: 'edit'; plan: Plan; baseRevision: number; immediate?: boolean }
  | { type: 'openFile'; path: string }
  | { type: 'openStepDiff'; stepId: string }
  /** Auto-layout: `force` re-arranges everything, otherwise only elements without a position. */
  | { type: 'relayout'; force?: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  /** `selection`: the image holds only the selected elements, not the whole board. */
  | {
      type: 'export';
      format: 'png' | 'svg';
      data: string;
      encoding: 'base64' | 'utf8';
      selection?: boolean;
    }
  | { type: 'openAsText' }
  /** Open a box's code: its symbol, file, a file in its folder, or the files using its package. */
  | { type: 'openCode'; nodeId: string }
  | { type: 'codeInfo'; nodeId: string }
  /** Generate or re-sync the architecture from the code. */
  | { type: 'syncFromCode' }
  | { type: 'checkDrift' }
  | { type: 'verifyStep'; stepId: string }
  /** Open a step's verification evidence (diff and output) in an editor. */
  | { type: 'openVerification'; stepId: string }
  | { type: 'askAi'; request: AskAiRequest; ids: string[] }
  /** Unlock a board an agent is working on; it locks again on the agent's next change. */
  | { type: 'takeOver' }
  | { type: 'error'; message: string };
