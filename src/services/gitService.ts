import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SimpleGit } from 'simple-git';
import { getConfig, getWorkspaceRoot } from '../utils/config';
import {
  existsRef,
  getGit,
  gitRaw,
  nameOnlyDiff,
  nameStatusDiff,
  parseNameStatus,
  revparse,
} from '../utils/gitClient';
import { formatOwnerRepo, parseOwnerRepo } from '../utils/parseRepo';

export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string;
  detailsUrl?: string;
}

export interface PullRequestReview {
  author: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING, DISMISSED
  body: string;
  submittedAt?: string;
}

export interface PullRequestFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  ciStatus: 'pending' | 'success' | 'failure' | 'unknown';
  ciConclusion?: string;
  checks: PullRequestCheck[];
  headBranch: string;
  baseBranch: string;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewDecision?: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitFileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
}


export class GitService {
  private _onBranchChanged = new vscode.EventEmitter<string>();
  readonly onBranchChanged = this._onBranchChanged.event;

  private currentBranch: string = '';
  private watcher: vscode.FileSystemWatcher | undefined;
  private pollInterval: NodeJS.Timeout | undefined;
  private cachedRepoRoot = '';

  async initialize(): Promise<void> {
    this.currentBranch = await this.getCurrentBranch();

    const root = getWorkspaceRoot();
    if (root) {
      const headPattern = new vscode.RelativePattern(root, '.git/HEAD');
      this.watcher = vscode.workspace.createFileSystemWatcher(headPattern);
      this.watcher.onDidChange(() => this.checkBranchChange());
      this.watcher.onDidCreate(() => this.checkBranchChange());
    }

    this.pollInterval = setInterval(() => this.checkBranchChange(), 5000);
  }

  private async checkBranchChange(): Promise<void> {
    try {
      const branch = await this.getCurrentBranch();
      if (branch !== this.currentBranch && branch) {
        this.currentBranch = branch;
        this._onBranchChanged.fire(branch);
      }
    } catch {
      // Git not available or not in a repo
    }
  }

  private workspaceRoot(): string {
    return getWorkspaceRoot() || '';
  }

  /** simple-git client; optional `cwd` for repos outside the active workspace folder. */
  private gitClient(cwd?: string): SimpleGit {
    const base = cwd || this.workspaceRoot();
    if (!base) {
      throw new Error('No workspace root');
    }
    return getGit(base);
  }

  private async repoBase(cwd?: string): Promise<string> {
    if (cwd) {
      return cwd;
    }
    const cached = await this.getRepoRoot();
    return cached || this.workspaceRoot();
  }

  async getCurrentBranch(cwd?: string): Promise<string> {
    const base = cwd || this.workspaceRoot();
    if (!base) {
      return '';
    }
    try {
      return (await revparse(this.gitClient(base), '--abbrev-ref', 'HEAD')).trim();
    } catch {
      return '';
    }
  }

  /**
   * Absolute path of the git repository root (the dir containing `.git` or
   * the parent of a submodule's `.git` file). Differs from the VS Code
   * workspace folder when the project lives in a subdirectory of the repo
   * (e.g. a monorepo). Git file paths (from `diff --name-status`, etc.) are
   * relative to this root, so file URIs must be built from it.
   *
   * Returns the workspace root as a fallback if the CLI call fails.
   */
  async getRepoRoot(): Promise<string> {
    if (this.cachedRepoRoot) {
      return this.cachedRepoRoot;
    }
    const root = this.workspaceRoot();
    if (!root) {
      return '';
    }
    try {
      this.cachedRepoRoot = await revparse(this.gitClient(root), '--show-toplevel');
      return this.cachedRepoRoot;
    } catch {
      return root;
    }
  }

  async listLocalBranches(): Promise<GitBranchInfo[]> {
    const root = this.workspaceRoot();
    if (!root) {
      return [];
    }

    const current = await this.getCurrentBranch();
    const git = this.gitClient(root);
    let raw: string;
    try {
      raw = await gitRaw(git, [
        'branch',
        '--format=%(refname:short)|%(upstream:short)|%(upstream:track)',
      ]);
    } catch {
      return [];
    }

    if (!raw) {
      return [];
    }

    return raw.split('\n').filter(Boolean).map(line => {
      const [name, tracking, trackInfo] = line.split('|');
      let ahead = 0;
      let behind = 0;

      if (trackInfo) {
        const aheadMatch = trackInfo.match(/ahead (\d+)/);
        const behindMatch = trackInfo.match(/behind (\d+)/);
        if (aheadMatch) { ahead = parseInt(aheadMatch[1], 10); }
        if (behindMatch) { behind = parseInt(behindMatch[1], 10); }
      }

      return {
        name,
        isCurrent: name === current,
        isRemote: false,
        tracking: tracking || undefined,
        ahead,
        behind,
      };
    });
  }

  async listRemoteBranches(): Promise<GitBranchInfo[]> {
    const root = this.workspaceRoot();
    if (!root) { return []; }

    try {
      const localBranches = await this.listLocalBranches();
      const localNames = new Set(localBranches.map(b => b.name));

      const raw = await gitRaw(this.gitClient(root), ['branch', '-r', '--format=%(refname:short)']);
      if (!raw) { return []; }

      return raw.split('\n').filter(Boolean)
        .filter(name => !name.includes('HEAD'))
        .map(name => {
          const shortName = name.replace(/^origin\//, '');
          return { name, shortName };
        })
        .filter(({ shortName }) => !localNames.has(shortName))
        .map(({ name, shortName }) => ({
          name: shortName,
          isCurrent: false,
          isRemote: true,
          tracking: name,
        }));
    } catch {
      return [];
    }
  }

  async getFileAtRef(ref: string, filePath: string): Promise<string> {
    const base = await this.repoBase();
    if (!base) { return ''; }
    try {
      return await this.gitClient(base).show(`${ref}:${filePath}`);
    } catch {
      return '';
    }
  }

  async getMergeBase(): Promise<string> {
    const base = await this.repoBase();
    if (!base) { return ''; }
    const git = this.gitClient(base);
    let baseBranch = 'main';
    if (!(await existsRef(git, 'main'))) {
      if (await existsRef(git, 'master')) {
        baseBranch = 'master';
      } else {
        return '';
      }
    }
    try {
      return await gitRaw(git, ['merge-base', baseBranch, 'HEAD']);
    } catch {
      return '';
    }
  }

  /** Merge-base SHA between two refs (e.g. HEAD and a branch name). */
  async mergeBase(ref1: string, ref2: string, cwd?: string): Promise<string> {
    const base = cwd || await this.repoBase();
    if (!base) { return ''; }
    try {
      return await gitRaw(this.gitClient(base), ['merge-base', ref1, ref2]);
    } catch {
      return '';
    }
  }

  /** Unix timestamp of a commit. */
  async commitTimestamp(sha: string, cwd?: string): Promise<number> {
    const base = cwd || await this.repoBase();
    if (!base) { return 0; }
    try {
      const out = await gitRaw(this.gitClient(base), ['log', '-1', '--format=%at', sha]);
      return parseInt(out, 10) || 0;
    } catch {
      return 0;
    }
  }

  /** Count commits in a rev-list range (e.g. `main..HEAD`). */
  async revListCount(range: string, cwd?: string): Promise<number> {
    const base = cwd || await this.repoBase();
    if (!base) { return 0; }
    try {
      const out = await gitRaw(this.gitClient(base), ['rev-list', '--count', range]);
      return parseInt(out, 10) || 0;
    } catch {
      return 0;
    }
  }

  async checkoutBranch(branchName: string, create: boolean = false, startPoint?: string): Promise<void> {
    const git = this.gitClient(await this.repoBase());
    await git.checkout(
      create ? ['-b', branchName, ...(startPoint ? [startPoint] : [])] : branchName,
    );
  }

  async getChangedFiles(branch?: string, baseOverride?: string): Promise<GitFileChange[]> {
    const root = this.workspaceRoot();
    if (!root) {
      return [];
    }
    const git = this.gitClient(root);

    const cfgGcf = getConfig();
    let baseBranch = baseOverride || cfgGcf.baseBranch || '';
    if (!baseBranch) {
      const tipForMb = branch && branch.length > 0 ? branch : 'HEAD';
      let currentBranchName = '';
      try {
        currentBranchName = await revparse(git, '--abbrev-ref', 'HEAD');
      } catch { /* ignore */ }
      const tipBranch = (branch && branch.length > 0) ? branch : currentBranchName;
      const candidates = Array.from(new Set(
        [cfgGcf.trunkBranch, 'main', 'master', cfgGcf.stagingBranch, 'staging'].filter(Boolean) as string[]
      ));
      let bestTs = 0;
      for (const c of candidates) {
        if (c === tipBranch) { continue; }
        try {
          const baseSha = await gitRaw(git, ['merge-base', tipForMb, c]);
          if (!baseSha) { continue; }
          const ts = parseInt(await gitRaw(git, ['log', '-1', '--format=%at', baseSha]), 10) || 0;
          if (ts > bestTs) {
            bestTs = ts;
            baseBranch = c;
          }
        } catch { /* candidate not present locally — skip */ }
      }
    }
    if (!baseBranch) {
      baseBranch = cfgGcf.trunkBranch || 'main';
      if (!(await existsRef(git, baseBranch))) {
        if (await existsRef(git, 'master')) {
          baseBranch = 'master';
        } else {
          return [];
        }
      }
    } else if (!(await existsRef(git, baseBranch))) {
      return [];
    }

    const tip = branch && branch.length > 0 ? branch : 'HEAD';
    const includeUntracked = tip === 'HEAD';

    try {
      const changes: GitFileChange[] = await nameStatusDiff(git, `${baseBranch}...${tip}`);

      if (includeUntracked) {
        try {
          const untracked = await gitRaw(git, ['ls-files', '--others', '--exclude-standard']);
          if (untracked) {
            const trackedPaths = new Set(changes.map(c => c.path));
            for (const filePath of untracked.split('\n').filter(Boolean)) {
              if (!trackedPaths.has(filePath)) {
                changes.push({ status: 'added', path: filePath });
              }
            }
          }
        } catch {
          // Ignore — untracked listing is optional
        }
      }

      return changes;
    } catch {
      return [];
    }
  }

  async listMigrationsOnBranch(branchName: string, migrationPath: string, pattern?: RegExp): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) {
      return [];
    }
    const filePattern = pattern || /^V\d+.*\.sql$/i;
    try {
      const raw = await gitRaw(
        this.gitClient(base),
        ['ls-tree', '--name-only', branchName, '--', `${migrationPath}/`],
      );
      if (!raw) {
        return [];
      }
      return raw.split('\n')
        .map(f => f.split('/').pop() || f)
        .filter(f => filePattern.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  async getStagedFiles(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) {
      return [];
    }
    try {
      return await nameOnlyDiff(this.gitClient(base), '--cached');
    } catch {
      return [];
    }
  }

  async getStagedChanges(): Promise<GitFileChange[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      return await nameStatusDiff(this.gitClient(base), '--cached');
    } catch {
      return [];
    }
  }

  async getUnstagedChanges(): Promise<GitFileChange[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const git = this.gitClient(base);
      const changes: GitFileChange[] = await nameStatusDiff(git);
      const status = await git.status();
      for (const filePath of status.not_added) {
        changes.push({ status: 'added', path: filePath });
      }
      return changes;
    } catch {
      return [];
    }
  }

  async stageFile(filePath: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).add(filePath);
  }

  async unstageFile(filePath: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).reset(['HEAD', '--', filePath]);
  }

  async discardFile(filePath: string): Promise<void> {
    const repoRoot = await this.repoBase();
    const git = this.gitClient(repoRoot);
    try {
      await gitRaw(git, ['ls-files', '--error-unmatch', filePath]);
      await git.checkout(['--', filePath]);
    } catch {
      const fullPath = path.join(repoRoot, filePath);
      if (fs.existsSync(fullPath)) { fs.unlinkSync(fullPath); }
    }
  }

  async commit(message: string): Promise<void> {
    const base = await this.repoBase();
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await this.gitClient(base).commit(message);
  }

  async hasUpstream(cwd?: string): Promise<boolean> {
    const base = cwd || await this.repoBase();
    if (!base) { return false; }
    try {
      await revparse(this.gitClient(base), '--abbrev-ref', '@{u}');
      return true;
    } catch {
      return false;
    }
  }

  async getAheadBehind(): Promise<{ ahead: number; behind: number; upstream: string }> {
    const base = await this.repoBase();
    if (!base) { return { ahead: 0, behind: 0, upstream: '' }; }
    try {
      const status = await this.gitClient(base).status();
      return {
        ahead: status.ahead,
        behind: status.behind,
        upstream: status.tracking || '',
      };
    } catch {
      return { ahead: 0, behind: 0, upstream: '' };
    }
  }

  async push(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).push();
  }

  async publishBranch(): Promise<void> {
    const base = await this.repoBase();
    const branch = await this.getCurrentBranch();
    if (!branch) { throw new Error('No current branch'); }
    await this.gitClient(base).push('origin', branch, ['--set-upstream']);
  }

  async pull(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).pull();
  }

  async pushCurrentBranchForPr(): Promise<void> {
    const base = await this.repoBase();
    const branch = await this.getCurrentBranch();
    if (!branch) { throw new Error('No current branch'); }
    const git = this.gitClient(base);
    const hasRemote = await this.hasUpstream();
    if (!hasRemote) {
      await git.push('origin', branch, ['--set-upstream']);
    } else {
      await git.push();
    }
  }

  async commitAll(message: string, cwd?: string): Promise<void> {
    const base = cwd || await this.repoBase();
    if (!message.trim()) { throw new Error('Commit message is required'); }
    const git = this.gitClient(base);
    await git.add('-A');
    await git.commit(message);
  }

  async commitAmend(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).commit('', { '--amend': null, '--no-edit': null });
  }

  async commitAmendMessage(message: string): Promise<void> {
    const base = await this.repoBase();
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await this.gitClient(base).commit(message, { '--amend': null });
  }

  async undoLastCommit(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).reset(['--soft', 'HEAD~1']);
  }

  async discardAllChanges(): Promise<void> {
    const base = await this.repoBase();
    const git = this.gitClient(base);
    await git.checkout(['--', '.']);
    await gitRaw(git, ['clean', '-fd']);
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).deleteLocalBranch(branchName, force);
  }

  async hasRemoteBranch(branchName: string): Promise<boolean> {
    const base = await this.repoBase();
    if (!base) { return false; }
    try {
      const out = await gitRaw(this.gitClient(base), ['ls-remote', '--heads', 'origin', branchName]);
      return out.length > 0;
    } catch {
      return false;
    }
  }

  async isDirty(): Promise<boolean> {
    const base = await this.repoBase();
    if (!base) { return false; }
    try {
      const status = await this.gitClient(base).status();
      return !status.isClean();
    } catch {
      return false;
    }
  }

  async renameBranch(newName: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).branch(['-m', newName]);
  }

  async mergeBranch(branchName: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).merge([branchName]);
  }

  async createTag(name: string, message?: string, sha?: string): Promise<void> {
    const base = await this.repoBase();
    const git = this.gitClient(base);
    if (sha) {
      await gitRaw(git, message
        ? ['tag', '-a', name, '-m', message, sha]
        : ['tag', name, sha]);
      return;
    }
    if (message) {
      await git.addAnnotatedTag(name, message);
    } else {
      await git.addTag(name);
    }
  }

  async deleteTag(name: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).tag(['-d', name]);
  }

  async deleteRemoteTag(name: string): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['push', 'origin', '--delete', `refs/tags/${name}`]);
  }

  async commitSignedOff(message: string): Promise<void> {
    const base = await this.repoBase();
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await this.gitClient(base).commit(message, { '-s': null });
  }

  async commitAllSignedOff(message: string, cwd?: string): Promise<void> {
    const base = cwd || await this.repoBase();
    if (!message.trim()) { throw new Error('Commit message is required'); }
    const git = this.gitClient(base);
    await git.add('-A');
    await git.commit(message, { '-s': null });
  }

  async stashStaged(message?: string): Promise<void> {
    const base = await this.repoBase();
    const args = ['push', '--staged'];
    if (message) { args.push('-m', message); }
    await this.gitClient(base).stash(args);
  }

  async stashIncludeUntracked(message?: string): Promise<void> {
    const base = await this.repoBase();
    const args = ['push', '--include-untracked'];
    if (message) { args.push('-m', message); }
    await this.gitClient(base).stash(args);
  }

  async stashList(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const raw = await gitRaw(this.gitClient(base), ['stash', 'list']);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async stashApply(index: number = 0): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['stash', 'apply', `stash@{${index}}`]);
  }

  async stashDrop(index: number = 0): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['stash', 'drop', `stash@{${index}}`]);
  }

  async stashDropAll(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).stash(['clear']);
  }

  async listTags(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const result = await this.gitClient(base).tags();
      return result.all;
    } catch {
      return [];
    }
  }

  async abortRebase(): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['rebase', '--abort']);
  }

  async isRebasing(): Promise<boolean> {
    const repoRoot = await this.getRepoRoot();
    if (!repoRoot) { return false; }
    return fs.existsSync(path.join(repoRoot, '.git/rebase-merge')) ||
           fs.existsSync(path.join(repoRoot, '.git/rebase-apply'));
  }

  async rebaseBranch(branchName: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).rebase([branchName]);
  }

  async deleteRemoteBranch(branchName: string): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['push', 'origin', '--delete', branchName]);
  }

  async addRemote(name: string, url: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).addRemote(name, url);
  }

  async removeRemote(name: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).removeRemote(name);
  }

  async createWorktree(worktreePath: string, branchName: string): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['worktree', 'add', worktreePath, '-b', branchName]);
  }

  async listWorktrees(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const raw = await gitRaw(this.gitClient(base), ['worktree', 'list']);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const base = await this.repoBase();
    await gitRaw(this.gitClient(base), ['worktree', 'remove', worktreePath]);
  }

  async fetch(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).fetch();
  }

  async fetchPrune(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).fetch(['--prune']);
  }

  async fetchAll(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).fetch(['--all']);
  }

  async revert(sha: string): Promise<void> {
    const base = await this.repoBase();
    const git = this.gitClient(base);
    const parents = (await revparse(git, `${sha}^@`)).split('\n').filter(Boolean);
    const args = ['revert', '--no-edit'];
    if (parents.length > 1) {
      args.push('-m', '1');
    }
    args.push(sha);
    await gitRaw(git, args);
  }

  async cherryPick(sha: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).raw(['cherry-pick', sha]);
  }

  async checkoutDetached(sha: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).checkout(['--detach', sha]);
  }

  async getBranchesAtCommit(sha: string): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const raw = await gitRaw(
        this.gitClient(base),
        ['branch', '-a', '--points-at', sha, '--format=%(refname:short)'],
      );
      return raw.split('\n').filter(Boolean).filter(b => !b.includes('HEAD') && b !== 'origin');
    } catch {
      return [];
    }
  }

  async getCommitFiles(sha: string): Promise<Array<{ status: string; path: string }>> {
    const base = await this.repoBase();
    if (!base) { return []; }
    const git = this.gitClient(base);
    let raw = await gitRaw(git, ['diff-tree', '--no-commit-id', '--name-status', '-r', sha]);
    if (!raw) {
      try {
        raw = String(await git.diff(['--name-status', `${sha}^1`, sha])).trim();
      } catch {
        return [];
      }
    }
    return raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { status: parts[0][0], path: parts[parts.length - 1] };
    });
  }

  async getDiffFiles(fromRef: string, toRef: string | null): Promise<Array<{ status: string; path: string }>> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const extra = toRef ? [fromRef, toRef] : [fromRef];
      const changes = await nameStatusDiff(this.gitClient(base), ...extra);
      const letter: Record<GitFileChange['status'], string> = {
        added: 'A',
        modified: 'M',
        deleted: 'D',
        renamed: 'R',
      };
      return changes.map(c => ({ status: letter[c.status], path: c.path }));
    } catch {
      return [];
    }
  }

  async getGitHubUrl(cwd?: string): Promise<string> {
    const root = cwd || this.workspaceRoot();
    if (!root) { return ''; }
    try {
      const remotes = await this.gitClient(root).getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin');
      const url = origin?.refs?.fetch || origin?.refs?.push || '';
      if (!url) {
        return '';
      }
      return url
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
    } catch {
      return '';
    }
  }

  async getOwnerRepo(cwd?: string): Promise<string> {
    const url = await this.getGitHubUrl(cwd);
    if (!url) { return ''; }
    try {
      const { owner, repo } = parseOwnerRepo(url);
      return formatOwnerRepo(owner, repo);
    } catch {
      return '';
    }
  }

  async getLogRaw(format: string, limit: number, refArgs: string): Promise<string> {
    const base = await this.repoBase();
    if (!base) { return ''; }
    try {
      const extra = refArgs.trim().split(/\s+/).filter(Boolean);
      return await gitRaw(this.gitClient(base), [
        'log',
        '--date-order',
        `--format=${format}`,
        `-${limit}`,
        ...extra,
      ]);
    } catch {
      return '';
    }
  }

  async getLogShortstat(format: string, limit: number, refArgs: string): Promise<string> {
    const base = await this.repoBase();
    if (!base) { return ''; }
    try {
      const extra = refArgs.trim().split(/\s+/).filter(Boolean);
      return await gitRaw(this.gitClient(base), [
        'log',
        '--date-order',
        `--format=${format}`,
        '--shortstat',
        `-${limit}`,
        ...extra,
      ]);
    } catch {
      return '';
    }
  }

  async getOutgoingCommits(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const raw = await gitRaw(this.gitClient(base), ['log', '--oneline', '@{u}..HEAD']);
      return raw.split('\n').filter(Boolean).map(l => l.split(' ')[0]);
    } catch {
      return [];
    }
  }

  async getIncomingCommits(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const raw = await gitRaw(this.gitClient(base), ['log', '--oneline', 'HEAD..@{u}']);
      return raw.split('\n').filter(Boolean).map(l => l.split(' ')[0]);
    } catch {
      return [];
    }
  }

  async getRecentMerges(limit = 5): Promise<Array<{ sha: string; message: string }>> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const raw = await gitRaw(this.gitClient(base), ['log', '--merges', '--oneline', `-${limit}`]);
      return raw.split('\n').filter(Boolean).map(line => {
        const sp = line.indexOf(' ');
        return { sha: line.substring(0, sp), message: line.substring(sp + 1) };
      });
    } catch {
      return [];
    }
  }

  async pullRebase(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).pull(['--rebase']);
  }

  async pullFrom(remote: string, branch: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).pull(remote, branch);
  }

  async pushTo(remote: string, branch: string): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).push(remote, branch);
  }

  async listRemotes(): Promise<string[]> {
    const base = await this.repoBase();
    if (!base) { return []; }
    try {
      const remotes = await this.gitClient(base).getRemotes();
      return remotes.map(r => r.name);
    } catch {
      return [];
    }
  }

  async stash(message?: string): Promise<void> {
    const base = await this.repoBase();
    const args = ['push'];
    if (message) { args.push('-m', message); }
    await this.gitClient(base).stash(args);
  }

  async stashPop(): Promise<void> {
    const base = await this.repoBase();
    await this.gitClient(base).stash(['pop']);
  }

  async sync(): Promise<void> {
    const base = await this.repoBase();
    const git = this.gitClient(base);
    await git.pull();
    await git.push();
  }

  async cloneRepo(repoUrl: string, parentDir: string): Promise<void> {
    await getGit(parentDir).clone(repoUrl);
  }

  /** Initial commit + push for a newly scaffolded project directory. */
  async initialCommitAndPush(
    projectDir: string,
    message: string,
    branch = 'main',
    remote = 'origin',
  ): Promise<void> {
    await this.commitAll(message, projectDir);
    await this.gitClient(projectDir).push(remote, branch, ['--set-upstream']);
  }

  getCachedBranch(): string {
    return this.currentBranch;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this._onBranchChanged.dispose();
  }
}
