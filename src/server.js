// MCP server that gives Claude on the web this machine's YouTube tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { askGemini, describeVideo, transcript } from './youtube.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8790);
const PUBLIC_HOST = process.env.PUBLIC_HOST;

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
  Gemini, and say when only part of a video was processed.`;

const video = z.string().describe('YouTube URL or 11-character video ID');
const seconds = (what) => z.number().int().min(0).describe(`${what}, in seconds from the start of the video`);

function textResult(run) {
  return run().then(
    (text) => ({ content: [{ type: 'text', text }] }),
    (error) => ({ content: [{ type: 'text', text: error.message }], isError: true }),
  );
}

export function createServer() {
  const server = new McpServer({ name: 'youtube', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('video_info', {
    description: 'Title, channel, length, and the language of the spoken-language captions of a YouTube video.',
    inputSchema: { video },
    annotations: { readOnlyHint: true },
  }, ({ video }) => textResult(() => describeVideo(video)));

  server.registerTool('captions', {
    description: 'Captions in the language spoken in the video, as timestamped paragraphs with links. '
      + 'Never machine-translated. Give start and end to read part of a long video.',
    inputSchema: { video, start: seconds('Start').optional(), end: seconds('End').optional() },
    annotations: { readOnlyHint: true },
  }, ({ video, start, end }) => textResult(() => transcript(video, start, end)));

  server.registerTool('gemini', {
    description: 'Ask Gemini about a clip of a YouTube video, for what captions cannot give. '
      + 'Either give a prompt, or set transcript to true for a structured transcript of the clip in its original language.',
    inputSchema: {
      video,
      start: seconds('Clip start'),
      end: seconds('Clip end'),
      prompt: z.string().optional().describe('What to ask about the clip, for example what is written on the board'),
      transcript: z.boolean().optional().describe('Return a transcript of the clip instead of answering a prompt'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ video, start, end, prompt, transcript: transcriptMode }) => textResult(async () => {
    if (end <= start) throw new Error('end must be after start');
    if (!transcriptMode && !prompt) throw new Error('Give a prompt, or set transcript to true');
    return askGemini({ video, start, end, prompt, transcriptMode });
  }));

  return server;
}

export function createApp() {
  const allowedHosts = ['127.0.0.1', 'localhost', ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])];
  const app = createMcpExpressApp({ host: HOST, allowedHosts });

  app.get('/health', (req, res) => res.type('text/plain').send('awake\n'));

  app.post('/mcp', async (req, res) => {
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
  createApp().listen(PORT, HOST, () => console.log(`YouTube connector on http://${HOST}:${PORT}/mcp`));
}
