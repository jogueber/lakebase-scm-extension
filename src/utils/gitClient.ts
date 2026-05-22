import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';

export type NameStatusChange = {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
};

/** Create a simple-git client rooted at `baseDir` (workspace folder or repo root). */
export function getGit(baseDir: string, options?: Partial<SimpleGitOptions>): SimpleGit {
  return simpleGit({ baseDir, ...options });
}

/** Run arbitrary git args; returns trimmed stdout. */
export async function gitRaw(git: SimpleGit, args: string[]): Promise<string> {
  return String(await git.raw(args)).trim();
}

/** `git rev-parse` — single ref or option list. */
export async function revparse(git: SimpleGit, ...args: string[]): Promise<string> {
  const result = args.length === 1
    ? await git.revparse(args[0])
    : await git.revparse(args);
  return String(result).trim();
}

/** True when `git rev-parse --verify <ref>` succeeds. */
export async function existsRef(git: SimpleGit, ref: string): Promise<boolean> {
  try {
    await revparse(git, '--verify', ref);
    return true;
  } catch {
    return false;
  }
}

/** `git diff --name-status` with optional extra args (e.g. `--cached`, `main...HEAD`). */
export async function nameStatusDiff(git: SimpleGit, ...extraArgs: string[]): Promise<NameStatusChange[]> {
  const raw = String(await git.diff(['--name-status', ...extraArgs])).trim();
  return parseNameStatus(raw);
}

/** `git diff --name-only` with optional extra args. */
export async function nameOnlyDiff(git: SimpleGit, ...extraArgs: string[]): Promise<string[]> {
  const raw = String(await git.diff(['--name-only', ...extraArgs])).trim();
  return raw ? raw.split('\n').filter(Boolean) : [];
}

const STATUS_MAP: Record<string, NameStatusChange['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
};

/** Parse `git diff --name-status` / `--cached` output lines. */
export function parseNameStatus(raw: string): NameStatusChange[] {
  if (!raw) {
    return [];
  }
  return raw.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const code = parts[0][0];
    if (code === 'R') {
      return { status: 'renamed' as const, path: parts[2], oldPath: parts[1] };
    }
    return { status: STATUS_MAP[code] || 'modified', path: parts[1] };
  });
}
