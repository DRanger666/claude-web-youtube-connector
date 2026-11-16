import assert from 'node:assert/strict';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The saved-files folder is fixed when the server module loads, so set it first.
const root = join(import.meta.dirname, '.scratch-server-files');
process.env.FILES_DIR = root;
const { createApp } = await import('../src/server.js');

let listener;
let base;

before(async () => {
  listener = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});

after(async () => {
  listener.close();
  await rm(root, { recursive: true, force: true });
});

async function connect() {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
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
  const result = await client.callTool({ name: 'captions', arguments: { video: 'not a video' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Not a YouTube video URL or ID/);
  const gemini = await client.callTool({ name: 'gemini', arguments: { video: 'DStYkSO4Cc0', start: 60, end: 60, prompt: 'x' } });
  assert.match(gemini.content[0].text, /end must be after start/);
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
