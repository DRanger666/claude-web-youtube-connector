// MCP server that gives Claude on the web this machine's YouTube tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { PassphraseProvider } from './auth.js';
import { FILES_DIR, insidePath, listFiles, readText, writeText } from './files.js';
import { askGemini, describeVideo, transcript } from './youtube.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8790);
// The address Claude uses, such as https://machine.example.ts.net; the server
// itself listens only on this machine.
const PUBLIC_URL = new URL(process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`);
const MCP_URL = new URL('/mcp', PUBLIC_URL);

const INSTRUCTIONS = `YouTube tools running on the user's own computer.

For each video, use captions first and Gemini only for what captions cannot give:
anything visual (slides, a board, on-screen text, what happens on screen) or a
video with no usable captions.

- Captions are in the language spoken in the video. If the user wants another
  language, translate them yourself rather than asking for a translation.
- Gemini quota is limited. Ask for a clip, not a whole long video: up to 600
  seconds for a transcript, up to 1800 seconds for other questions. Work through
  a long video one clip at a time, and if a clip fails, try a smaller one rather
  than repeating the same request.
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
      + 'With save_as the answer is both returned and saved.',
    inputSchema: {
      video,
      start: seconds('Clip start'),
      end: seconds('Clip end'),
      prompt: z.string().optional().describe('What to ask about the clip, for example what is written on the board'),
      transcript: z.boolean().optional().describe('Return a transcript of the clip instead of answering a prompt'),
      save_as: saveAs,
      overwrite,
    },
    annotations: { openWorldHint: true },
  }, ({ video, start, end, prompt, transcript: transcriptMode, save_as, overwrite }) => textResult('gemini', async () => {
    if (end <= start) throw new Error('end must be after start');
    if (!transcriptMode && !prompt) throw new Error('Give a prompt, or set transcript to true');
    if (!save_as) return askGemini({ video, start, end, prompt, transcriptMode });
    const output = insidePath(save_as);
    if (existsSync(output) && !overwrite) throw new Error(`${save_as} already exists; set overwrite to true to replace it`);
    await mkdir(dirname(output), { recursive: true });
    await askGemini({ video, start, end, prompt, transcriptMode, output });
    return `${await readText(save_as)}\nSaved ${relative(FILES_DIR, output)} in ${FILES_DIR}`;
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
    console.log(short(method === 'tools/call' ? `tools/call ${params?.name} ${JSON.stringify(params?.arguments)}` : String(method)));
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
  createApp().listen(PORT, HOST, () => console.log(`YouTube connector on http://${HOST}:${PORT}/mcp for ${MCP_URL}`));
}
