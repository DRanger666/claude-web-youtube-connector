// Gemini requests run as jobs that always write their result to a file, so a
// request that outlasts the client's wait still ends up on disk. Next to the
// file, a marker shows the job's state while it has no result:
//   OUTPUT.running   queued or started, with the time
//   OUTPUT.failed    the error; a cut-off answer is also in OUTPUT.partial
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { askGemini } from './youtube.js';

export const MAX_RUNNING = 3;
let running = 0;
const queue = [];

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

async function takeSlot() {
  if (running < MAX_RUNNING) running += 1;
  else await new Promise((resolve) => queue.push(resolve));
}

// A finished job hands its slot straight to the next queued one.
function releaseSlot() {
  const next = queue.shift();
  if (next) next();
  else running -= 1;
}

// Claims OUTPUT, then returns at once with `done`, which settles when the job
// ends. Refuses a second job for the same file while one is running. The
// service log gets one line when the job ends, since the caller may be gone.
export async function startJob(request, output, label = output) {
  const marker = `${output}.running`;
  await mkdir(dirname(output), { recursive: true });
  try {
    await writeFile(marker, `queued ${now()}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('A Gemini request for this file is already running');
    throw error;
  }
  await rm(`${output}.failed`, { force: true });
  await rm(`${output}.partial`, { force: true });
  const done = (async () => {
    await takeSlot();
    const started = Date.now();
    const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    try {
      await writeFile(marker, `started ${now()}\n`);
      await askGemini({ ...request, output });
      console.log(`gemini job ${label} ok in ${took()}`);
    } catch (error) {
      console.log(`gemini job ${label} failed in ${took()}: ${error.message.slice(0, 300)}`);
      await writeFile(`${output}.failed`, `${now()} ${error.message}\n`);
      throw error;
    } finally {
      await rm(marker, { force: true });
      releaseSlot();
    }
  })();
  done.catch(() => {}); // the caller may never wait for it; the .failed file records the error
  return { done };
}

// Jobs die with the server, so markers left from before a restart are stale.
export async function markInterrupted(root) {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.running'))) {
    const marker = join(entry.parentPath, entry.name);
    const output = marker.slice(0, -'.running'.length);
    await writeFile(`${output}.failed`, `${now()} The server restarted while this request was running\n`);
    await rm(marker);
  }
}
