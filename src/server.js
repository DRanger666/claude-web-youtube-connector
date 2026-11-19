// MCP server that gives Claude on the web this machine's YouTube tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { PassphraseProvider } from './auth.js';
import { FILES_DIR, insidePath, listFiles, readText, writeText } from './files.js';
import { MAX_RUNNING, markInterrupted, startJob } from './gemini.js';
import { describeVideo, transcript, videoId } from './youtube.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8790);
// The address Claude uses, such as https://machine.example.ts.net; the server
// itself listens only on this machine.
const PUBLIC_URL = new URL(process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`);
const MCP_URL = new URL('/mcp', PUBLIC_URL);
// claude.ai stops waiting for a tool after 230 seconds; answer before that.
const WAIT_SECONDS = Number(process.env.GEMINI_WAIT_SECONDS ?? 200);

const INSTRUCTIONS = `YouTube tools running on the user's own computer.

For each video, use captions first and Gemini only for what captions cannot give:
anything visual (slides, a board, on-screen text, what happens on screen) or a
video with no usable captions.

- Captions are in the language spoken in the video. If the user wants another
  language, translate them yourself rather than asking for a translation.
- Gemini quota is limited, and failed requests use it too. Ask for a clip, not
  a whole video: about 2 minutes for a transcript (longer clips often stop at
  Gemini's output limit, sooner for dense speech or non-Latin scripts), up to 30
  minutes for other questions. If a clip fails, try a smaller one rather than
  repeating the same request.
- Every gemini result is saved to a file, save_as or one the server names. A
  call waits up to ${WAIT_SECONDS} seconds; if Gemini is slower, it returns the file's path
  and the request keeps running. Tool calls from claude.ai run one at a time, so
  to run several clips at once, call gemini with wait set to false for each,
  then collect the results. The server runs ${MAX_RUNNING} Gemini requests at once
  and queues the rest.
- list_files shows each request's state: FILE.running (queued or started, with
  the time), FILE.failed (the error), FILE.partial (an answer cut off). Check
  back later, scheduling a check-in if you can, and read the finished files.
  Do not start a request again while it is still running.
- Cite captions with their timestamped links. Say which observations came from
  Gemini, and say when only part of a video was processed.

Files: the user's computer has one folder for this, ${FILES_DIR}. Save there,
with save_as or save_file, what the user wants to keep on their computer; keep
scratch work in this chat. Before a Gemini request, check list_files for an
answer saved earlier, because a saved answer costs no quota.`;

const video = z.string().describe('YouTube URL or 11-character video ID');
const saveAs = z.string().optional().describe(`Save the result to this path inside ${FILES_DIR}, for example Hegel/sec_75-76.md; folders are created as needed`);
const overwrite = z.boolean().optional().describe('Replace the file if it already exists');
const seconds = (what) => z.number().int().min(0).describe(`${what}, in seconds from the start of the video`);

const short = (text) => (text.length > 300 ? `${text.slice(0, 300)}...` : text);

// Runs a tool, turns its text or error into a result Claude can read, and logs
// how it ended, so failures and slow calls show in the service log.
function textResult(name, run) {
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  return run().then(
    (text) => {
      console.log(`${name} ok in ${took()}, ${text.length} characters`);
      return { content: [{ type: 'text', text }] };
    },
    (error) => {
      console.log(`${name} failed in ${took()}: ${short(error.message)}`);
      return { content: [{ type: 'text', text: error.message }], isError: true };
    },
  );
}

export function createServer() {
  const server = new McpServer({ name: 'youtube', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('video_info', {
    description: 'Title, channel, length, and the language of the spoken-language captions of a YouTube video.',
    inputSchema: { video },
    annotations: { readOnlyHint: true },
  }, ({ video }) => textResult('video_info', () => describeVideo(video)));

  server.registerTool('captions', {
    description: 'Captions in the language spoken in the video, as timestamped paragraphs with links. '
      + 'Never machine-translated. Give start and end to read part of a long video. '
      + 'With save_as the captions go only to the file, and read_file shows them.',
    inputSchema: { video, start: seconds('Start').optional(), end: seconds('End').optional(), save_as: saveAs, overwrite },
  }, ({ video, start, end, save_as, overwrite }) => textResult('captions', async () => {
    const text = await transcript(video, start, end);
    return save_as ? writeText(save_as, text, overwrite) : text;
  }));

  server.registerTool('gemini', {
    description: 'Ask Gemini about a clip of a YouTube video, for what captions cannot give. '
      + 'Either give a prompt, or set transcript to true for a structured transcript of the clip in its original language. '
      + 'The answer is always saved to a file, save_as or a name the server picks, and returned if it arrives in time.',
    inputSchema: {
      video,
      start: seconds('Clip start'),
      end: seconds('Clip end'),
      prompt: z.string().optional().describe('What to ask about the clip, for example what is written on the board'),
      transcript: z.boolean().optional().describe('Return a transcript of the clip instead of answering a prompt'),
      save_as: saveAs,
      overwrite,
      wait: z.boolean().optional().describe(`Wait up to ${WAIT_SECONDS} seconds for the answer (the default). Set to false to start the request and return at once`),
    },
    annotations: { openWorldHint: true },
  }, ({ video, start, end, prompt, transcript: transcriptMode, save_as, overwrite, wait }) => textResult('gemini', async () => {
    if (end <= start) throw new Error('end must be after start');
    if (!transcriptMode && !prompt) throw new Error('Give a prompt, or set transcript to true');
    const path = save_as ?? `gemini/${videoId(video)}_${start}-${end}s_${new Date().toISOString().replace(/[-:]|\.\d+Z/g, '')}.md`;
    const output = insidePath(path);
    if (existsSync(output) && !overwrite) throw new Error(`${path} already exists; set overwrite to true to replace it`);
    const { done } = await startJob({ video, start, end, prompt, transcriptMode }, output, path);
    const later = `the result will be saved as ${path}; list_files shows its state`;
    if (wait === false) return `Started; ${later}`;
    const finished = await Promise.race([done.then(() => true), sleep(WAIT_SECONDS * 1000, false)]);
    if (!finished) return `Still running after ${WAIT_SECONDS} seconds; ${later}`;
    return `${(await readText(path)).trimEnd()}\nSaved ${path} in ${FILES_DIR}`;
  }));

  server.registerTool('list_files', {
    description: `List the files saved in ${FILES_DIR} on the user's computer, or in one folder inside it.`,
    inputSchema: { folder: z.string().optional().describe('A folder inside the saved-files folder') },
    annotations: { readOnlyHint: true },
  }, ({ folder }) => textResult('list_files', () => listFiles(folder)));

  server.registerTool('read_file', {
    description: `Read a text file saved in ${FILES_DIR}.`,
    inputSchema: { path: z.string().describe('Path inside the saved-files folder, as list_files shows it') },
    annotations: { readOnlyHint: true },
  }, ({ path }) => textResult('read_file', () => readText(path)));

  server.registerTool('save_file', {
    description: `Save text, such as notes or a summary, to a file in ${FILES_DIR} on the user's computer. Folders are created as needed.`,
    inputSchema: {
      path: z.string().describe('Path inside the saved-files folder, for example Hegel/notes.md'),
      content: z.string().describe('The text to save'),
      overwrite,
    },
  }, ({ path, content, overwrite }) => textResult('save_file', () => writeText(path, content, overwrite)));

  return server;
}

export function createApp() {
  const app = createMcpExpressApp({ host: HOST, allowedHosts: ['127.0.0.1', 'localhost', PUBLIC_URL.hostname] });
  // Tailscale Funnel forwards from this machine; rate limits should count the
  // address it forwards for, not the tunnel's own.
  app.set('trust proxy', 'loopback');

  app.get('/health', (req, res) => res.type('text/plain').send('awake\n'));

  const provider = new PassphraseProvider();
  app.use(mcpAuthRouter({ provider, issuerUrl: PUBLIC_URL, resourceServerUrl: MCP_URL, resourceName: 'YouTube on my computer' }));
  app.use(provider.signInRouter());
  const signedIn = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL) });

  app.post('/mcp', signedIn, async (req, res) => {
    // One short line per request, so the service log shows what Claude asked
    // for, without keeping whole notes or transcripts; textResult logs the end.
    const { method, params } = req.body ?? {};
    // Long values (prompts, note text) are cut one by one, so a long prompt
    // cannot push the other arguments out of the line.
    const cut = (key, value) => (typeof value === 'string' && value.length > 80 ? `${value.slice(0, 80)}...` : value);
    console.log(short(method === 'tools/call' ? `tools/call ${params?.name} ${JSON.stringify(params?.arguments, cut)}` : String(method)));
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless: there is no session stream to open or close.
  const notAllowed = (req, res) => res.status(405).json({
    jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null,
  });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await markInterrupted(FILES_DIR);
  createApp().listen(PORT, HOST, () => console.log(`YouTube connector on http://${HOST}:${PORT}/mcp for ${MCP_URL}`));
}
