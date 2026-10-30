import test from 'node:test';
import assert from 'node:assert/strict';
import { commonDirectory, relativeDisplayPath, directoryLabel } from '../../explorer/src/components/path-presentation.js';

test('shared context removes directory components, never identifying suffixes',()=>{
  const prefix='/Users/andyed/Documents/dev/worktrees/';
  const paths=[prefix+'operator/docs/IOS_RELEASE.md',prefix+'operator/docs/guide/README.md'];
  const root=commonDirectory(paths);
  assert.equal(root,prefix+'operator/docs/');
  assert.deepEqual(paths.map(path=>relativeDisplayPath(path,root)),['IOS_RELEASE.md','guide/README.md']);
  assert.equal(directoryLabel(root),'…/operator/docs/');
  assert.equal(commonDirectory([paths[0]]),root);
  assert.equal(relativeDisplayPath(prefix+'operator-v2/docs/IOS_RELEASE.md',root),prefix+'operator-v2/docs/IOS_RELEASE.md');
  const worktrees=[paths[0],prefix+'operator-v2/docs/IOS_RELEASE.md'];
  assert.deepEqual(worktrees.map(path=>relativeDisplayPath(path,commonDirectory(worktrees))),['operator/docs/IOS_RELEASE.md','operator-v2/docs/IOS_RELEASE.md']);
  assert.equal(commonDirectory(['/a/file.md','/ab/file.md']),'');
  assert.equal(commonDirectory([]),'');
  assert.equal(commonDirectory(['README.md']),'');
  assert.equal(commonDirectory(['C:\\work\\docs\\one.md','C:\\work\\docs\\two.md']),'C:/work/docs/');
});
