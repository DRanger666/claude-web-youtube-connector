import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { insidePath, listFiles, readText, writeText } from '../src/files.js';

const root = join(import.meta.dirname, '.scratch-files');

before(() => mkdir(root, { recursive: true }));
after(() => rm(root, { recursive: true, force: true }));

test('paths that leave the folder are refused', () => {
  for (const path of ['../outside.md', 'a/../../outside.md', '/etc/passwd', '', '.']) {
    assert.throws(() => insidePath(path, root), /saved-files folder/, path);
  }
  assert.equal(insidePath('Hegel/sec_75-76.md', root), join(root, 'Hegel/sec_75-76.md'));
});

test('saving creates folders, refuses to replace, and replaces when asked', async () => {
  assert.match(await writeText('Hegel/notes.md', 'first', false, root), /Saved Hegel\/notes.md \(5 bytes\)/);
  await assert.rejects(writeText('Hegel/notes.md', 'second', false, root), /already exists; set overwrite/);
  assert.equal(await readText('Hegel/notes.md', root), 'first');
  await writeText('Hegel/notes.md', 'second', true, root);
  assert.equal(await readText('Hegel/notes.md', root), 'second');
});

test('listing shows files with sizes, for the whole folder or one subfolder', async () => {
  await writeText('Other/a.md', 'abc', false, root);
  assert.equal(await listFiles('', root), 'Hegel/notes.md (6 bytes)\nOther/a.md (3 bytes)');
  assert.equal(await listFiles('Other', root), 'Other/a.md (3 bytes)');
  await assert.rejects(listFiles('../', root), /outside the saved-files folder/);
});
