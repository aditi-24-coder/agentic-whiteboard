import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CodeIndex, isBoardPath, isUnder, normalizeCodePath, type CodeScan } from './codemap.js';
import { detectDrift, recordBaseline } from './drift.js';
import { gitChangedFiles, gitDiff, gitHead } from './git.js';
import type { Plan, Step, Verification } from './schema.js';

const OUTPUT_TAIL = 4000;
const DIFF_LIMIT = 12_000;
const NOT_STARTED = new Set<Plan['status']>(['drafting', 'awaiting_approval', 'approved']);

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** Guesses the project's test command from its manifest files. */
export async function detectVerifyCommand(root: string): Promise<string | undefined> {
  const pkg = await fs
    .readFile(path.join(root, 'package.json'), 'utf8')
    .then((t) => JSON.parse(t) as { scripts?: Record<string, string> })
    .catch(() => undefined);
  const test = pkg?.scripts?.test;
  if (test && !/no test specified/.test(test)) {
    if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm test';
    if (await exists(path.join(root, 'yarn.lock'))) return 'yarn test';
    if (await exists(path.join(root, 'bun.lockb'))) return 'bun test';
    return 'npm test';
  }
  for (const f of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'])
    if (await exists(path.join(root, f))) return 'pytest';
  if (await exists(path.join(root, 'go.mod'))) return 'go test ./...';
  if (await exists(path.join(root, 'Cargo.toml'))) return 'cargo test';
  return undefined;
}

export interface CommandResult {
  exitCode: number;
  /** Combined stdout and stderr, tail only. */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/** Stops a command and everything it started (a shell, npm, node, the test runner). */
function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    );
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM'); // The process group made by `detached`.
    } catch {
      child.kill('SIGTERM');
    }
  }
}

export class VerificationCancelled extends Error {
  constructor() {
    super('Verification cancelled.');
    this.name = 'VerificationCancelled';
  }
}

/** Runs a shell command in `root`, keeping the tail of its output. */
export function runCommand(
  root: string,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let finished = false;
    const child = spawn(command, {
      cwd: root,
      shell: true,
      windowsHide: true,
      // Its own process group on POSIX, so the whole tree can be stopped.
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const keep = (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_TAIL * 2);
    };
    // Decoding per stream keeps a character split across chunks intact.
    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree(child);
      },
      opts.timeoutMs ?? 10 * 60_000,
    );
    const onAbort = () => killTree(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const done = (exitCode: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        // eslint-disable-next-line no-control-regex
        output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-OUTPUT_TAIL),
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.on('error', (err) => {
      output += `\n${err.message}`;
      done(127);
    });
    child.on('close', (code) => done(timedOut ? 124 : (code ?? 1)));
  });
}

/** Repo paths a step covers: the paths of the boxes it touches. */
export function stepPaths(plan: Plan, step: Step): string[] {
  return step.nodeIds
    .map((id) => plan.nodes.find((n) => n.id === id)?.path)
    .filter((p): p is string => !!p)
    .map(normalizeCodePath);
}

export interface VerifyStepOptions {
  /** Command to run; none skips running anything and judges by the code alone. */
  command?: string;
  /** Diff base; default HEAD (uncommitted work). */
  base?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Collects evidence for one step: runs the command, diffs the step's files and checks its boxes
 * for drift. Verified when the command passes and the code matches the plan; failed when the
 * command fails; drifted when it passes but the code disagrees with the plan.
 */
export async function verifyStep(
  root: string,
  plan: Plan,
  stepId: string,
  scan: CodeScan,
  opts: VerifyStepOptions = {},
): Promise<Verification> {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`No step "${stepId}" on the board.`);
  const paths = stepPaths(plan, step);
  const changed = (await gitChangedFiles(root, opts.base)) ?? [];
  const relevant = changed.filter((f) => !isBoardPath(f));
  const stepFiles = paths.length
    ? relevant.filter((f) => paths.some((p) => isUnder(f, p)))
    : relevant;
  const reasons: string[] = [];

  let result: CommandResult | undefined;
  if (opts.command) {
    result = await runCommand(root, opts.command, opts);
    // A cancelled run proves nothing either way: attach nothing.
    if (opts.signal?.aborted) throw new VerificationCancelled();
    if (result.timedOut) reasons.push(`\`${opts.command}\` timed out.`);
    else if (result.exitCode !== 0)
      reasons.push(`\`${opts.command}\` exited with code ${result.exitCode}.`);
  }

  const touched = new Set(step.nodeIds);
  // Verifying a step means the work has started, whatever the plan status says.
  const working: Plan = NOT_STARTED.has(plan.status) ? { ...plan, status: 'in_progress' } : plan;
  const drift = detectDrift(working, scan, { changedFiles: changed }).filter(
    (d) =>
      d.severity !== 'info' &&
      ((d.targetId && touched.has(d.targetId)) || d.kind === 'unplanned-change'),
  );
  // A step that finished should have its new files in place, whatever the plan status says.
  const index = CodeIndex.for(scan);
  for (const id of step.nodeIds) {
    const n = plan.nodes.find((x) => x.id === id);
    if (
      n?.path &&
      n.changeType === 'new' &&
      !index.exists(n.path) &&
      !drift.some((d) => d.targetId === id)
    )
      reasons.push(
        `"${n.label}" is planned as new but ${normalizeCodePath(n.path)} does not exist.`,
      );
  }
  reasons.push(...drift.map((d) => d.message));

  const failed = !!result && (result.exitCode !== 0 || result.timedOut);
  const status: Verification['status'] = failed
    ? 'failed'
    : reasons.length
      ? 'drifted'
      : 'verified';
  const diff = await gitDiff(root, stepFiles, opts.base);
  const commit = await gitHead(root);
  return {
    status,
    at: new Date().toISOString(),
    ...(opts.command ? { command: opts.command } : {}),
    ...(result ? { exitCode: result.exitCode, output: result.output } : {}),
    ...(diff.stat ? { diffStat: diff.stat } : {}),
    ...(diff.patch
      ? {
          diff:
            diff.patch.length > DIFF_LIMIT
              ? `${diff.patch.slice(0, DIFF_LIMIT)}\n… (diff truncated)`
              : diff.patch,
        }
      : {}),
    files: stepFiles,
    ...(commit ? { commit } : {}),
    reasons,
  };
}

/**
 * Writes a verification onto its step. A pass marks the step done and, given the scan it was
 * judged on, records that code as the baseline for the step's boxes, so later changes to them
 * show as drift. A failure marks the step failed. Verifying moves the plan to in progress, and
 * to done once every step is done.
 */
export function attachVerification(
  plan: Plan,
  stepId: string,
  v: Verification,
  scan?: CodeScan,
): Plan {
  const steps = plan.steps.map((s) =>
    s.id !== stepId
      ? s
      : {
          ...s,
          verification: v,
          status: v.status === 'verified' ? 'done' : v.status === 'failed' ? 'failed' : s.status,
        },
  );
  const finished = steps.every((s) => s.status === 'done' || s.status === 'skipped');
  const status: Plan['status'] = finished
    ? 'done'
    : NOT_STARTED.has(plan.status) || plan.status === 'done'
      ? 'in_progress'
      : plan.status;
  const next: Plan = { ...plan, steps, status };
  const step = steps.find((s) => s.id === stepId);
  return v.status === 'verified' && scan && step ? recordBaseline(next, scan, step.nodeIds) : next;
}
