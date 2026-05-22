import * as sinon from 'sinon';
import type { SimpleGit } from 'simple-git';
import * as gitClient from '../../src/utils/gitClient';

export type MockGitExecResult = { stdout?: string; error?: Error };

/** Reconstruct a shell-style git command string for legacy test assertions. */
export function argsToGitCmd(args: string[]): string {
  const parts = args.map(a => {
    if (a.includes(' ') || a.includes('"')) {
      return `"${a}"`;
    }
    return a;
  });
  return `git ${parts.join(' ')}`;
}

export type MockGitFromExecHandler = (cmd: string) => MockGitExecResult;

/**
 * Stub gitClient for unit tests that previously mocked child_process.exec.
 * Records every git invocation as a `git ...` command string.
 */
function defaultExecFallback(cmd: string): MockGitExecResult | undefined {
  if (cmd.includes('--show-toplevel')) {
    return { stdout: '/fake/root' };
  }
  if (cmd.includes('abbrev-ref') && cmd.includes('HEAD') && !cmd.includes('@{u}')) {
    return { stdout: 'main' };
  }
  if (cmd.includes('@{u}')) {
    return { stdout: 'origin/main' };
  }
  return undefined;
}

export function installMockGitFromExec(
  handler: MockGitFromExecHandler = () => ({}),
): { cmds: string[]; git: SimpleGit } {
  const cmds: string[] = [];

  const dispatch = (args: string[]): MockGitExecResult => {
    const cmd = argsToGitCmd(args);
    cmds.push(cmd);
    const custom = handler(cmd);
    if (custom.error || custom.stdout !== undefined) {
      return custom;
    }
    return defaultExecFallback(cmd) ?? {};
  };

  const runRaw = async (args: string | string[]): Promise<string> => {
    const arr = Array.isArray(args) ? args : [args];
    const result = dispatch(arr);
    if (result.error) {
      throw result.error;
    }
    return result.stdout ?? '';
  };

  const git = {
    raw: sinon.stub().callsFake(runRaw),
    revparse: sinon.stub().callsFake(async (opts: string | string[]) => {
      const args = Array.isArray(opts) ? opts : [opts];
      return runRaw(['rev-parse', ...args]);
    }),
    diff: sinon.stub().callsFake(async (opts: string | string[]) => {
      const args = Array.isArray(opts) ? opts : [opts];
      return runRaw(['diff', ...args]);
    }),
    show: sinon.stub().callsFake(async (spec: string) => runRaw(['show', spec])),
    add: sinon.stub().callsFake(async (...files: string[]) => runRaw(['add', ...files])),
    commit: sinon.stub().callsFake(async (message: string, opts?: Record<string, unknown>) => {
      const args = ['commit'];
      if (opts && '-s' in opts) { args.push('-s'); }
      if (opts && '--amend' in opts) { args.push('--amend'); }
      if (opts && '--no-edit' in opts) { args.push('--no-edit'); }
      if (message) { args.push('-m', message); }
      return runRaw(args);
    }),
    push: sinon.stub().callsFake(async (...parts: unknown[]) => {
      const args = ['push'];
      for (const p of parts) {
        if (Array.isArray(p)) {
          args.push(...p.map(String));
        } else if (p !== undefined) {
          args.push(String(p));
        }
      }
      return runRaw(args);
    }),
    pull: sinon.stub().callsFake(async (...parts: unknown[]) => {
      const args = ['pull', ...parts.flat().map(String)];
      return runRaw(args);
    }),
    fetch: sinon.stub().callsFake(async (opts?: string | string[]) => {
      const extra = opts ? (Array.isArray(opts) ? opts : [opts]) : [];
      return runRaw(['fetch', ...extra]);
    }),
    checkout: sinon.stub().callsFake(async (...parts: unknown[]) => {
      return runRaw(['checkout', ...parts.flat().map(String)]);
    }),
    merge: sinon.stub().callsFake(async (branches: string | string[]) => {
      const list = Array.isArray(branches) ? branches : [branches];
      return runRaw(['merge', ...list]);
    }),
    rebase: sinon.stub().callsFake(async (branches: string | string[]) => {
      const list = Array.isArray(branches) ? branches : [branches];
      return runRaw(['rebase', ...list]);
    }),
    clean: sinon.stub().callsFake(async (mode: string, opts?: string[]) => {
      return runRaw(['clean', mode, ...(opts || [])]);
    }),
    reset: sinon.stub().callsFake(async (args: string | string[]) => {
      const list = Array.isArray(args) ? args : [args];
      return runRaw(['reset', ...list]);
    }),
    branch: sinon.stub().callsFake(async (opts?: string | string[]) => {
      const args = opts ? (Array.isArray(opts) ? opts : [opts]) : [];
      return runRaw(['branch', ...args]);
    }),
    deleteLocalBranch: sinon.stub().callsFake(async (name: string, force?: boolean) => {
      return runRaw(['branch', force ? '-D' : '-d', name]);
    }),
    addRemote: sinon.stub().callsFake(async (name: string, url: string) => runRaw(['remote', 'add', name, url])),
    removeRemote: sinon.stub().callsFake(async (name: string) => runRaw(['remote', 'remove', name])),
    getRemotes: sinon.stub().callsFake(async (verbose?: boolean) => {
      const result = dispatch(verbose ? ['remote', '-v'] : ['remote']);
      const raw = (result.stdout ?? '').trim();
      const names = raw ? raw.split('\n').filter(Boolean) : [];
      if (verbose) {
        return names.map(name => ({
          name,
          refs: { fetch: `https://github.com/o/${name}.git`, push: '' },
        }));
      }
      return names.map(name => ({ name }));
    }),
    addTag: sinon.stub().callsFake(async (name: string) => runRaw(['tag', name])),
    addAnnotatedTag: sinon.stub().callsFake(async (name: string, message: string) => {
      return runRaw(['tag', '-a', name, '-m', message]);
    }),
    tag: sinon.stub().callsFake(async (opts?: string | string[]) => {
      const args = opts ? (Array.isArray(opts) ? opts : [opts]) : [];
      return runRaw(['tag', ...args]);
    }),
    tags: sinon.stub().callsFake(async () => {
      const raw = await runRaw(['tag', '-l']);
      const all = raw ? raw.split('\n').filter(Boolean) : [];
      return { all, latest: all[0] || null, total: all.length };
    }),
    stash: sinon.stub().callsFake(async (...parts: unknown[]) => {
      const args = ['stash'];
      for (const p of parts) {
        if (typeof p === 'string') {
          args.push(p);
        } else if (Array.isArray(p)) {
          args.push(...p.map(String));
        }
      }
      return runRaw(args);
    }),
    status: sinon.stub().callsFake(async () => {
      const upstreamResult = dispatch(['rev-parse', '--abbrev-ref', '@{u}']);
      if (upstreamResult.error) {
        throw upstreamResult.error;
      }
      const tracking = (upstreamResult.stdout ?? '').trim();
      const abResult = dispatch(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      const ab = (abResult.stdout ?? '0\t0').split(/\s+/);
      let not_added: string[] = [];
      const lsResult = dispatch(['ls-files', '--others', '--exclude-standard']);
      if (lsResult.stdout) {
        not_added = lsResult.stdout.trim().split('\n').filter(Boolean);
      }
      const porcelain = handler('git status --porcelain');
      return {
        not_added,
        ahead: parseInt(ab[0], 10) || 0,
        behind: parseInt(ab[1], 10) || 0,
        tracking,
        isClean: () => !(porcelain.stdout || '').trim(),
      };
    }),
    clone: sinon.stub().callsFake(async (url: string) => runRaw(['clone', url])),
  } as unknown as SimpleGit;

  sinon.stub(gitClient, 'getGit').returns(git);
  sinon.stub(gitClient, 'gitRaw').callsFake(async (_g, args: string[]) => {
    const result = dispatch(args);
    if (result.error) {
      throw result.error;
    }
    return (result.stdout ?? '').trim();
  });
  sinon.stub(gitClient, 'revparse').callsFake(async (_g, ...args: string[]) => {
    const result = dispatch(['rev-parse', ...args]);
    if (result.error) {
      throw result.error;
    }
    return (result.stdout ?? '').trim();
  });
  sinon.stub(gitClient, 'existsRef').callsFake(async (_g, ref: string) => {
    try {
      const result = dispatch(['rev-parse', '--verify', ref]);
      if (result.error) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
  sinon.stub(gitClient, 'nameStatusDiff').callsFake(async (_g, ...args: string[]) => {
    const result = dispatch(['diff', '--name-status', ...args]);
    return gitClient.parseNameStatus((result.stdout ?? '').trim());
  });
  sinon.stub(gitClient, 'nameOnlyDiff').callsFake(async (_g, ...args: string[]) => {
    const result = dispatch(['diff', '--name-only', ...args]);
    const raw = (result.stdout ?? '').trim();
    return raw ? raw.split('\n').filter(Boolean) : [];
  });

  return { cmds, git };
}
