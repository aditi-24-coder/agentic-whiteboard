import { execFile } from 'node:child_process';
import { normalizeCodePath } from './codemap.js';

/**
 * Settings that stop a repository's own config from running programs when we only read from
 * it: a cloned repo can set an fsmonitor hook, an external diff tool or a textconv filter.
 */
const SAFE_CONFIG = [
  '-c',
  'core.quotepath=off',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
];

/**
 * Runs git in `root`. Resolves to stdout, or undefined when git is missing or fails. Paths in
 * and out are relative to `root`, which may be a subfolder of the repository.
 */
export function git(root: string, args: string[], maxBuffer = 32 * 1024 * 1024) {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd: root, maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

const split = (out: string | undefined) =>
  (out ?? '').split('\0').filter(Boolean).map(normalizeCodePath);

export async function gitHead(root: string): Promise<string | undefined> {
  return (await git(root, ['rev-parse', '--short', 'HEAD']))?.trim() || undefined;
}

/**
 * Files changed since `base` (default HEAD): modified, staged, deleted and untracked. In a
 * repository without commits yet, every file counts as changed.
 */
export async function gitChangedFiles(root: string, base = 'HEAD'): Promise<string[] | undefined> {
  if ((await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true')
    return undefined;
  const untracked = await git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  // --relative: names relative to `root` (not the repo root), limited to files under it.
  let changed = await git(root, ['diff', '--name-only', '--relative', '--no-ext-diff', '-z', base]);
  if (changed === undefined && !(await gitHead(root)))
    changed = await git(root, ['ls-files', '-z', '--cached']);
  if (changed === undefined) return undefined;
  return [...new Set([...split(changed), ...split(untracked)])].sort();
}

export interface GitDiff {
  stat: string;
  patch: string;
}

/** Runs git once per batch of paths: Windows caps a command line at about 32K characters. */
async function gitBatched(root: string, args: string[], paths: readonly string[]) {
  let out = '';
  for (let i = 0; i < paths.length; i += 100) {
    const res = await git(root, [...args, '--', ...paths.slice(i, i + 100)]);
    if (res === undefined) return undefined;
    out += res;
  }
  return out;
}

/** Diff of `files` against `base`. Untracked files appear as additions in the stat. */
export async function gitDiff(
  root: string,
  files: readonly string[],
  base = 'HEAD',
): Promise<GitDiff> {
  if (!files.length) return { stat: '', patch: '' };
  const tracked = new Set(split(await gitBatched(root, ['ls-files', '-z'], files)));
  const known = files.filter((f) => tracked.has(f));
  const untracked = files.filter((f) => !tracked.has(f));
  const diffArgs = ['diff', '--relative', '--no-ext-diff', '--no-textconv', base];
  const stat = known.length ? ((await gitBatched(root, [...diffArgs, '--stat'], known)) ?? '') : '';
  const patch = known.length ? ((await gitBatched(root, diffArgs, known)) ?? '') : '';
  const extra = untracked.map((f) => ` ${f} | new file`).join('\n');
  return { stat: [stat.trimEnd(), extra].filter(Boolean).join('\n'), patch };
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export async function gitLog(root: string, target: string, limit = 5): Promise<GitCommit[]> {
  const out = await git(root, [
    'log',
    `-n${limit}`,
    '--format=%h%x1f%an%x1f%as%x1f%s',
    '--',
    target || '.',
  ]);
  return (out ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split('\x1f') as [string, string, string, string];
      return { hash, author, date, subject };
    });
}

/** People with the most commits touching `target`, most active first. */
export async function gitOwners(
  root: string,
  target: string,
  limit = 3,
): Promise<{ name: string; commits: number }[]> {
  // Recent history only: a full shortlog of an old, busy path can take seconds.
  const out = await git(root, [
    'shortlog',
    '-sn',
    '--no-merges',
    '--max-count=1000',
    'HEAD',
    '--',
    target || '.',
  ]);
  return (out ?? '')
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .slice(0, limit)
    .map((m) => ({ name: m[2]!.trim(), commits: Number(m[1]) }));
}
