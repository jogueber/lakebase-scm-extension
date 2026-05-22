import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';
import * as gitClient from '../../src/utils/gitClient';

describe('GitService', () => {
  let service: GitService;
  let gitRawStub: sinon.SinonStub;
  let revparseStub: sinon.SinonStub;
  let nameStatusDiffStub: sinon.SinonStub;
  let nameOnlyDiffStub: sinon.SinonStub;
  let existsRefStub: sinon.SinonStub;
  let getGitStub: sinon.SinonStub;

  beforeEach(() => {
    service = new GitService();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
    getGitStub = sinon.stub(gitClient, 'getGit').returns({} as ReturnType<typeof gitClient.getGit>);
    gitRawStub = sinon.stub(gitClient, 'gitRaw');
    revparseStub = sinon.stub(gitClient, 'revparse');
    nameStatusDiffStub = sinon.stub(gitClient, 'nameStatusDiff');
    nameOnlyDiffStub = sinon.stub(gitClient, 'nameOnlyDiff');
    existsRefStub = sinon.stub(gitClient, 'existsRef');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getCurrentBranch', () => {
    it('returns the current branch name', async () => {
      revparseStub.resolves('feature/dev-sprint-1');
      const branch = await service.getCurrentBranch();
      assert.strictEqual(branch, 'feature/dev-sprint-1');
    });

    it('trims whitespace', async () => {
      revparseStub.resolves('  main  ');
      const branch = await service.getCurrentBranch();
      assert.strictEqual(branch, 'main');
    });
  });

  describe('listLocalBranches', () => {
    it('parses branch output with tracking info', async () => {
      revparseStub.resolves('main');
      gitRawStub.callsFake(async (_git, args: string[]) => {
        return [
          'main|origin/main|',
          'feature-x|origin/feature-x|[ahead 2, behind 1]',
          'orphan||',
        ].join('\n');
      });

      const branches = await service.listLocalBranches();
      assert.strictEqual(branches.length, 3);

      const main = branches.find(b => b.name === 'main');
      assert.ok(main);
      assert.strictEqual(main!.isCurrent, true);

      const feature = branches.find(b => b.name === 'feature-x');
      assert.ok(feature);
      assert.strictEqual(feature!.ahead, 2);
      assert.strictEqual(feature!.behind, 1);
      assert.strictEqual(feature!.tracking, 'origin/feature-x');
    });
  });

  describe('getChangedFiles', () => {
    it('parses diff output into file changes', async () => {
      gitRawStub.callsFake(async (_git, args: string[]) => {
        if (args[0] === 'merge-base') {
          return 'abc123';
        }
        if (args.includes('ls-files')) {
          return '';
        }
        if (args[0] === 'log') {
          return '1000';
        }
        return '';
      });
      existsRefStub.resolves(true);
      revparseStub.resolves('main');
      nameStatusDiffStub.resolves([
        { status: 'added', path: 'src/new-file.ts' },
        { status: 'modified', path: 'src/changed.ts' },
        { status: 'deleted', path: 'src/removed.ts' },
      ]);

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 3);

      const added = files.find(f => f.path === 'src/new-file.ts');
      assert.ok(added);
      assert.strictEqual(added!.status, 'added');

      const modified = files.find(f => f.path === 'src/changed.ts');
      assert.strictEqual(modified!.status, 'modified');

      const deleted = files.find(f => f.path === 'src/removed.ts');
      assert.strictEqual(deleted!.status, 'deleted');
    });

    it('handles renamed files', async () => {
      gitRawStub.callsFake(async (_git, args: string[]) => {
        if (args[0] === 'merge-base') { return 'abc123'; }
        if (args.includes('ls-files')) { return ''; }
        if (args[0] === 'log') { return '1000'; }
        return '';
      });
      existsRefStub.resolves(true);
      revparseStub.resolves('feature');
      nameStatusDiffStub.resolves([
        { status: 'renamed', path: 'new-name.ts', oldPath: 'old-name.ts' },
      ]);

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].status, 'renamed');
      assert.strictEqual(files[0].path, 'new-name.ts');
      assert.strictEqual(files[0].oldPath, 'old-name.ts');
    });

    it('includes untracked files as added', async () => {
      gitRawStub.callsFake(async (_git, args: string[]) => {
        if (args[0] === 'merge-base') { return 'abc123'; }
        if (args.includes('ls-files')) {
          return 'src/untracked-new.ts\nsrc/another-new.ts';
        }
        if (args[0] === 'log') { return '1000'; }
        return '';
      });
      existsRefStub.resolves(true);
      revparseStub.resolves('feature');
      nameStatusDiffStub.resolves([{ status: 'modified', path: 'src/existing.ts' }]);

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 3);
      const untracked = files.filter(f => f.path.includes('untracked') || f.path.includes('another'));
      assert.strictEqual(untracked.length, 2);
      assert.strictEqual(untracked[0].status, 'added');
      assert.strictEqual(untracked[1].status, 'added');
    });

    it('does not duplicate files already in diff', async () => {
      gitRawStub.callsFake(async (_git, args: string[]) => {
        if (args[0] === 'merge-base') { return 'abc123'; }
        if (args.includes('ls-files')) { return 'src/new-file.ts'; }
        if (args[0] === 'log') { return '1000'; }
        return '';
      });
      existsRefStub.resolves(true);
      revparseStub.resolves('feature');
      nameStatusDiffStub.resolves([{ status: 'added', path: 'src/new-file.ts' }]);

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 1);
    });
  });

  describe('getStagedFiles', () => {
    it('returns list of staged file paths', async () => {
      gitRawStub.onFirstCall().resolves('/fake/root');
      nameOnlyDiffStub.resolves(['src/file1.ts', 'src/file2.ts']);

      const staged = await service.getStagedFiles();
      assert.deepStrictEqual(staged, ['src/file1.ts', 'src/file2.ts']);
    });

    it('returns empty array when nothing staged', async () => {
      gitRawStub.onFirstCall().resolves('/fake/root');
      nameOnlyDiffStub.resolves([]);

      const staged = await service.getStagedFiles();
      assert.deepStrictEqual(staged, []);
    });
  });

  describe('getCachedBranch', () => {
    it('returns empty string initially', () => {
      assert.strictEqual(service.getCachedBranch(), '');
    });
  });

  describe('listMigrationsOnBranch', () => {
    it('lists V*.sql files from git ls-tree', async () => {
      revparseStub.resolves('/fake/root');
      gitRawStub.callsFake(async (_git, args: string[]) => {
        if (args[0] === 'ls-tree') {
          return 'V1__init.sql\nV2__create_table.sql\nREADME.md';
        }
        return '';
      });

      const migs = await service.listMigrationsOnBranch('main', 'src/main/resources/db/migration');
      assert.deepStrictEqual(migs, ['V1__init.sql', 'V2__create_table.sql']);
    });
  });

  describe('parseNameStatus (gitClient)', () => {
    it('parses added, modified, deleted, and renamed lines', () => {
      const changes = gitClient.parseNameStatus(
        'A\tnew.ts\nM\tmod.ts\nD\tdel.ts\nR100\told.ts\trenamed.ts',
      );
      assert.strictEqual(changes.length, 4);
      assert.strictEqual(changes[3].status, 'renamed');
      assert.strictEqual(changes[3].path, 'renamed.ts');
      assert.strictEqual(changes[3].oldPath, 'old.ts');
    });
  });
});
