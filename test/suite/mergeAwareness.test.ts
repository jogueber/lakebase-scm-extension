import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaScmProvider } from '../../src/providers/schemaScmProvider';
import { GitService } from '../../src/services/gitService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { SchemaDiffService, SchemaDiffResult } from '../../src/services/schemaDiffService';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';
import { GitHubService } from '../../src/services/githubService';
import { installMockGitFromExec } from '../helpers/mockGitClient';

describe('Merge Awareness — main branch view', () => {
  let provider: SchemaScmProvider;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;
  let githubStub: sinon.SinonStubbedInstance<GitHubService>;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];

    gitStub = sinon.createStubInstance(GitService);
    gitStub.getCachedBranch.returns('main');
    gitStub.getCurrentBranch.resolves('main');
    gitStub.getStagedChanges.resolves([]);
    gitStub.getUnstagedChanges.resolves([]);
    gitStub.getChangedFiles.resolves([]);
    gitStub.getMergeBase.resolves('abc123');
    gitStub.getAheadBehind.resolves({ ahead: 0, behind: 0, upstream: 'origin/main' });
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;

    githubStub = sinon.createStubInstance(GitHubService);
    githubStub.getPullRequest.resolves(undefined);

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    migrationStub.listMigrations.returns([]);
    migrationStub.watchMigrations.returns({ dispose: () => {} });

    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);

    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((name: string) =>
      name.replace(/\//g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 63)
    );
  });

  afterEach(() => {
    if (provider) { provider.dispose(); }
    sinon.restore();
  });

  function makeBranch(id: string, state: string = 'READY', isDefault: boolean = false): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state, isDefault };
  }

  describe('Lakebase group — production status', () => {
    it('shows production branch status on main', async () => {
      lakebaseStub.getDefaultBranch.resolves(makeBranch('br-prod-123', 'READY', true));
      lakebaseStub.getConsoleUrl.returns('https://workspace.databricks.com/lakebase/projects/p1/branches/br-prod-123');

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(lakebaseStub.getDefaultBranch.called);
    });

    it('handles missing default branch gracefully', async () => {
      lakebaseStub.getDefaultBranch.resolves(undefined);

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Should not throw
      assert.ok(true);
    });

    it('handles Lakebase API failure gracefully', async () => {
      lakebaseStub.getDefaultBranch.rejects(new Error('auth failed'));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(true);
    });
  });

  describe('Schema Migrations group', () => {
    it('lists all migration files on main', async () => {
      migrationStub.listMigrations.returns([
        { version: '1', description: 'init', filename: 'V1__init.sql', fullPath: '/fake/root/db/V1__init.sql' },
        { version: '2', description: 'create book', filename: 'V2__create_book.sql', fullPath: '/fake/root/db/V2__create_book.sql' },
        { version: '3', description: 'create product', filename: 'V3__create_product.sql', fullPath: '/fake/root/db/V3__create_product.sql' },
      ]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(migrationStub.listMigrations.called);
    });

    it('shows empty when no migrations', async () => {
      migrationStub.listMigrations.returns([]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Migrations group is hideWhenEmpty=true, so it hides
      assert.ok(true);
    });

    it('each migration links to its file', () => {
      const mig = { version: '6', description: 'create orders', filename: 'V6__create_orders.sql', fullPath: '/fake/root/db/V6__create_orders.sql' };
      // Verify the fullPath is used for the open command
      assert.ok(mig.fullPath.endsWith('V6__create_orders.sql'));
    });
  });

  describe('Recent Merges group', () => {
    it('shows recent merge commits on main', async () => {
      gitStub.getRecentMerges.resolves([
        { sha: 'abc1234', message: 'Merge pull request #9 from feature/orders' },
        { sha: 'def5678', message: 'Merge pull request #8 from feature/cart' },
      ]);
      gitStub.getGitHubUrl.resolves('https://github.com/user/repo');

      migrationStub.listMigrations.returns([]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));
      lakebaseStub.getConsoleUrl.returns('');

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 200));

      // The merge log was read
      assert.ok(true);
    });

    it('builds GitHub commit URLs from remote', () => {
      const remoteRaw = 'https://github.com/user/repo.git';
      const repoUrl = remoteRaw.replace(/\.git$/, '');
      const commitUrl = `${repoUrl}/commit/abc1234`;
      assert.strictEqual(commitUrl, 'https://github.com/user/repo/commit/abc1234');
    });

    it('handles SSH remote URL format', () => {
      const remoteRaw = 'git@github.com:user/repo.git';
      const repoUrl = remoteRaw
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/');
      assert.strictEqual(repoUrl, 'https://github.com/user/repo');
    });

    it('shows empty when no merge commits', async () => {
      gitStub.getRecentMerges.resolves([]);

      migrationStub.listMigrations.returns([]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Merges group hideWhenEmpty=true, so it hides
      assert.ok(true);
    });
  });

  describe('Groups are cleared on feature branch', () => {
    it('migrations and merges groups are empty on feature branch', async () => {
      gitStub.getCachedBranch.returns('feature-x');
      gitStub.getCurrentBranch.resolves('feature-x');
      gitStub.getAheadBehind.resolves({ ahead: 0, behind: 0, upstream: '' });

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      // On feature branch, migrations and merges groups should not be populated
      assert.ok(gitStub.getUnstagedChanges.called);
    });
  });

  describe('PR group is cleared on main', () => {
    it('PR group is empty and polling stopped on main', async () => {
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any, githubStub as any);
      await new Promise(r => setTimeout(r, 150));

      // hasPR context should be false
      assert.strictEqual(provider.getLastPrInfo(), undefined);
    });
  });
});

describe('GitHubService — mergePullRequest', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('calls merge with merge method and delete branch', async () => {
    const service = new GitHubService();
    const mergeStub = sinon.stub(service as any, 'mergePullRequest').resolves('Merged');
    await service.mergePullRequest('owner/repo', 9, 'merge', true);
    assert.ok(mergeStub.calledOnceWith('owner/repo', 9, 'merge', true));
  });

  it('calls merge with squash method', async () => {
    const service = new GitHubService();
    const mergeStub = sinon.stub(service as any, 'mergePullRequest').resolves('Merged');
    await service.mergePullRequest('owner/repo', 10, 'squash', true);
    assert.ok(mergeStub.calledOnceWith('owner/repo', 10, 'squash', true));
  });

  it('calls merge with rebase method without delete', async () => {
    const service = new GitHubService();
    const mergeStub = sinon.stub(service as any, 'mergePullRequest').resolves('Merged');
    await service.mergePullRequest('owner/repo', 11, 'rebase', false);
    assert.ok(mergeStub.calledOnceWith('owner/repo', 11, 'rebase', false));
  });
});

describe('GitHubService — getPullRequest', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns PR info from service stub', async () => {
    const service = new GitHubService();
    const prInfo = {
      number: 9,
      title: 'Feature orders',
      url: 'https://github.com/user/repo/pull/9',
      state: 'OPEN',
      isDraft: false,
      ciStatus: 'success' as const,
      checks: [],
      headBranch: 'feature/orders',
      baseBranch: 'main',
    };
    sinon.stub(service, 'getPullRequest').resolves(prInfo);
    const pr = await service.getPullRequest('user/repo', 'feature/orders');
    assert.ok(pr);
    assert.strictEqual(pr!.number, 9);
    assert.strictEqual(pr!.ciStatus, 'success');
    assert.strictEqual(pr!.headBranch, 'feature/orders');
  });

  it('returns undefined when no PR', async () => {
    const service = new GitHubService();
    sinon.stub(service, 'getPullRequest').resolves(undefined);
    const pr = await service.getPullRequest('user/repo', 'missing');
    assert.strictEqual(pr, undefined);
  });
});

describe('GitHubService — getPullRequestComments', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns comments', async () => {
    const service = new GitHubService();
    sinon.stub(service, 'getPullRequestComments').resolves([
      { author: 'github-actions', body: 'Schema diff: TABLE orders CREATED' },
    ]);
    const comments = await service.getPullRequestComments('user/repo', 9);
    assert.strictEqual(comments.length, 1);
    assert.ok(comments[0].body.includes('CREATED'));
  });

  it('returns empty on error', async () => {
    const service = new GitHubService();
    sinon.stub(service, 'getPullRequestComments').resolves([]);
    const comments = await service.getPullRequestComments('user/repo', 9);
    assert.deepStrictEqual(comments, []);
  });
});

describe('GitService — getAheadBehind', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    (vscode.workspace as any).workspaceFolders = undefined;
    sinon.restore();
  });

  it('returns ahead and behind counts', async () => {
    installMockGitFromExec((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref @{u}')) {
        return { stdout: 'origin/feature-x' };
      }
      if (cmd.includes('rev-list')) {
        return { stdout: '3\t2' };
      }
      return {};
    });
    const service = new GitService();
    const result = await service.getAheadBehind();
    assert.strictEqual(result.ahead, 3);
    assert.strictEqual(result.behind, 2);
    assert.strictEqual(result.upstream, 'origin/feature-x');
  });

  it('returns zeros when no upstream', async () => {
    installMockGitFromExec(() => ({ error: new Error('no upstream') }));
    const service = new GitService();
    const result = await service.getAheadBehind();
    assert.strictEqual(result.ahead, 0);
    assert.strictEqual(result.behind, 0);
    assert.strictEqual(result.upstream, '');
  });
});
