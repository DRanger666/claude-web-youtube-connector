// Gemini jobs, with a fake in place of the Gemini script: the prompt says how
// long it takes and whether it fails, so no quota is used.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { signIn, startServer } from './helpers.js';

process.env.PYTHON = join(import.meta.dirname, 'fake-python.sh');
process.env.GEMINI_WAIT_SECONDS = '1';

let server;
let client;

before(async () => {
  server = await startServer('gemini');
  const accessToken = (await signIn(server.base)).tokens.access_token;
  client = new Client({ name: 'test', version: '1' });
  const requestInit = { headers: { authorization: `Bearer ${accessToken}` } };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), { requestInit }));
});

after(async () => {
  await client.close();
  await server.close();
});

const gemini = async (prompt, extra = {}) => (await client.callTool({
  name: 'gemini',
  arguments: { video: 'DStYkSO4Cc0', start: 0, end: 60, prompt, ...extra },
})).content[0].text;

const listing = async () => (await client.callTool({ name: 'list_files', arguments: {} })).content[0].text;
const saved = (path) => join(process.env.FILES_DIR, path);

test('a quick answer is returned and saved, under a name the server picks', async () => {
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  const text = await gemini('0.1 ok').finally(() => { console.log = log; });
  assert.ok(logged.some((line) => /^gemini job gemini\/DStYkSO4Cc0_0-60s_\d{8}T\d{6}\.md ok in \d+\.\ds$/.test(line)), logged.join('\n'));
  assert.match(text, /^Answer for: 0\.1 ok\nSaved gemini\/DStYkSO4Cc0_0-60s_\d{8}T\d{6}\.md in /m);
  assert.doesNotMatch(await listing(), /\.running/);
});

test('a slow answer returns its path in time and lands on disk later', async () => {
  const text = await gemini('2 ok', { save_as: 'slow.md' });
  assert.equal(text, 'Still running after 1 seconds; the result will be saved as slow.md; list_files shows its state');
  assert.match(await listing(), /^slow\.md\.running: started \d{4}-\d\d-\d\dT[\d:]+Z$/m);
  const second = await gemini('0 ok', { save_as: 'slow.md', wait: false });
  assert.equal(second, 'A Gemini request for this file is already running');
  await sleep(1500);
  assert.equal(await readFile(saved('slow.md'), 'utf8'), 'Answer for: 2 ok\n');
  assert.equal(existsSync(saved('slow.md.running')), false);
});

test('a failure is returned when it comes in time, and kept in a .failed file', async () => {
  assert.equal(await gemini('0 fail', { save_as: 'broken.md' }), 'Fake Gemini failure');
  assert.match(await listing(), /^broken\.md\.failed: \S+ Fake Gemini failure$/m);
  assert.match(await gemini('0 ok', { save_as: 'broken.md' }), /^Answer for: 0 ok/);
  assert.doesNotMatch(await listing(), /broken\.md\.failed/);
});

test('without waiting, several requests start at once and three run at a time', async () => {
  const started = [];
  for (const name of ['a', 'b', 'c', 'd']) started.push(await gemini('1 ok', { save_as: `batch/${name}.md`, wait: false }));
  assert.deepEqual(started, ['a', 'b', 'c', 'd'].map((name) => `Started; the result will be saved as batch/${name}.md; list_files shows its state`));
  const states = (await listing()).split('\n').filter((line) => line.startsWith('batch/'));
  assert.equal(states.filter((line) => line.includes('.running: started')).length, 3);
  assert.equal(states.filter((line) => line.includes('.running: queued')).length, 1);
  await sleep(2500);
  assert.deepEqual((await listing()).split('\n').filter((line) => line.startsWith('batch/')),
    ['a', 'b', 'c', 'd'].map((name) => `batch/${name}.md (17 bytes)`));
});

test('after a restart, requests left running are marked as interrupted', async () => {
  const { markInterrupted } = await import('../src/gemini.js');
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(saved('old'), { recursive: true });
  await writeFile(saved('old/clip.md.running'), 'started 2026-11-19T00:00:00Z\n');
  await markInterrupted(process.env.FILES_DIR);
  assert.match(await listing(), /^old\/clip\.md\.failed: \S+ The server restarted while this request was running$/m);
  assert.doesNotMatch(await listing(), /old\/clip\.md\.running/);
});
