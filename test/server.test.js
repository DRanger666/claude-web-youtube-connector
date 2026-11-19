import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { signIn, startServer } from './helpers.js';

let server;
let base;
let accessToken;

before(async () => {
  server = await startServer('server');
  base = server.base;
  accessToken = (await signIn(base)).tokens.access_token;
});

after(() => server.close());

async function connect() {
  const client = new Client({ name: 'test', version: '1' });
  const requestInit = { headers: { authorization: `Bearer ${accessToken}` } };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit }));
  return client;
}

test('health answers without MCP', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'awake\n');
});

test('lists exactly the YouTube tools and sends the usage rules', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(),
    ['captions', 'gemini', 'list_files', 'read_file', 'save_file', 'video_info']);
  assert.match(client.getInstructions(), /captions first and Gemini only/);
  await client.close();
});

test('tool errors come back as results Claude can read, not as failures', async () => {
  const client = await connect();
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  const result = await client.callTool({ name: 'captions', arguments: { video: 'not a video' } }).finally(() => { console.log = log; });
  assert.deepEqual(logged.slice(-2).map((line) => line.replace(/\d+\.\ds/, 'Ns')), [
    'tools/call captions {"video":"not a video"}',
    'captions failed in Ns: Not a YouTube video URL or ID: not a video',
  ]);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Not a YouTube video URL or ID/);
  const gemini = await client.callTool({ name: 'gemini', arguments: { video: 'DStYkSO4Cc0', start: 60, end: 60, prompt: 'x' } });
  assert.match(gemini.content[0].text, /end must be after start/);

  const long = 'x'.repeat(500);
  console.log = (line) => logged.push(line);
  await client.callTool({ name: 'captions', arguments: { video: long, save_as: 'kept.md' } }).finally(() => { console.log = log; });
  assert.ok(logged.includes(`tools/call captions {"video":"${'x'.repeat(80)}...","save_as":"kept.md"}`), logged.join('\n'));
  await client.close();
});

test('files saved through the tools stay in the folder and are not replaced by accident', async () => {
  const client = await connect();
  const save = (args) => client.callTool({ name: 'save_file', arguments: args });
  assert.match((await save({ path: 'Hegel/notes.md', content: 'kept' })).content[0].text, /Saved Hegel\/notes.md/);
  assert.match((await save({ path: 'Hegel/notes.md', content: 'lost' })).content[0].text, /already exists/);
  assert.match((await save({ path: '../escape.md', content: 'x' })).content[0].text, /outside the saved-files folder/);
  const read = await client.callTool({ name: 'read_file', arguments: { path: 'Hegel/notes.md' } });
  assert.equal(read.content[0].text, 'kept');
  const gemini = await client.callTool({ name: 'gemini', arguments: { video: 'DStYkSO4Cc0', start: 0, end: 10, prompt: 'x', save_as: 'Hegel/notes.md' } });
  assert.match(gemini.content[0].text, /already exists/);
  await client.close();
});

// fetch drops a custom Host header, so this uses a raw request.
function statusFor(host) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/health`, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
}

test('requests for another host are refused, against DNS rebinding', async () => {
  assert.equal(await statusFor('attacker.example'), 403);
  assert.equal(await statusFor('127.0.0.1'), 200);
});
