import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import type { SimpleGit } from 'simple-git';
import {
  existsRef,
  nameOnlyDiff,
  nameStatusDiff,
  parseNameStatus,
  revparse,
} from '../../src/utils/gitClient';

describe('gitClient helpers', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('parseNameStatus', () => {
    it('parses added, modified, deleted, and renamed lines', () => {
      const changes = parseNameStatus(
        'A\tnew.ts\nM\tmod.ts\nD\tdel.ts\nR100\told.ts\trenamed.ts',
      );
      assert.strictEqual(changes.length, 4);
      assert.strictEqual(changes[3].status, 'renamed');
      assert.strictEqual(changes[3].path, 'renamed.ts');
      assert.strictEqual(changes[3].oldPath, 'old.ts');
    });
  });

  describe('revparse', () => {
    it('delegates to simple-git revparse', async () => {
      const git = { revparse: sinon.stub().resolves('main\n') } as unknown as SimpleGit;
      const result = await revparse(git, '--abbrev-ref', 'HEAD');
      assert.strictEqual(result, 'main');
      assert.deepStrictEqual((git.revparse as sinon.SinonStub).firstCall.args[0], ['--abbrev-ref', 'HEAD']);
    });
  });

  describe('existsRef', () => {
    it('returns true when rev-parse succeeds', async () => {
      const git = { revparse: sinon.stub().resolves('abc') } as unknown as SimpleGit;
      assert.strictEqual(await existsRef(git, 'main'), true);
    });

    it('returns false when rev-parse fails', async () => {
      const git = { revparse: sinon.stub().rejects(new Error('bad ref')) } as unknown as SimpleGit;
      assert.strictEqual(await existsRef(git, 'missing'), false);
    });
  });

  describe('nameStatusDiff', () => {
    it('parses diff --name-status output', async () => {
      const git = {
        diff: sinon.stub().resolves('A\tfile.ts\n'),
      } as unknown as SimpleGit;
      const changes = await nameStatusDiff(git, '--cached');
      assert.deepStrictEqual(changes, [{ status: 'added', path: 'file.ts' }]);
      assert.deepStrictEqual((git.diff as sinon.SinonStub).firstCall.args[0], ['--name-status', '--cached']);
    });
  });

  describe('nameOnlyDiff', () => {
    it('splits diff --name-only lines', async () => {
      const git = {
        diff: sinon.stub().resolves('a.ts\nb.ts\n'),
      } as unknown as SimpleGit;
      const files = await nameOnlyDiff(git, '--cached');
      assert.deepStrictEqual(files, ['a.ts', 'b.ts']);
    });
  });
});
