// YouTube and Gemini access, reusing the work-with-youtube skill's scripts so
// that Claude Code and this connector share one implementation.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export const SKILL_DIR = process.env.SKILL_DIR ?? join(homedir(), '.claude/skills/work-with-youtube');
const captions = await import(join(SKILL_DIR, 'scripts/save_captions.mjs'));
const GEMINI_SCRIPT = join(SKILL_DIR, 'scripts/gemini_video.py');
const GEMINI_TIMEOUT_MS = 15 * 60 * 1000;

export function videoId(video) {
  const match = video.trim().match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(video.trim())) return video.trim();
  throw new Error(`Not a YouTube video URL or ID: ${video}`);
}

export function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function eventsInRange(events, start, end) {
  return events.filter((event) => {
    const seconds = (event.tStartMs ?? 0) / 1000;
    return (start === undefined || seconds >= start) && (end === undefined || seconds < end);
  });
}

export async function describeVideo(video) {
  const id = videoId(video);
  const info = await captions.videoInfo(id);
  let language;
  try {
    const track = captions.trackFor(info);
    language = `${track.language_code} (${track.name?.text ?? 'captions'})`;
  } catch (error) {
    language = `no usable captions: ${error.message}`;
  }
  const basic = info.basic_info;
  return [
    `Title: ${basic.title}`,
    `Channel: ${basic.author}`,
    `Length: ${basic.duration} seconds`,
    `Spoken-language captions: ${language}`,
    `URL: ${watchUrl(id)}`,
  ].join('\n');
}

export async function transcript(video, start, end) {
  const id = videoId(video);
  const info = await captions.videoInfo(id);
  const track = captions.trackFor(info);
  const events = eventsInRange(await captions.captionEvents(track), start, end);
  if (events.length === 0) throw new Error('No captions in that time range');
  const name = track.name?.text ?? track.language_code;
  return captions.formatTranscript(info.basic_info.title, id, name, events);
}

// Settings the caller may choose; the script holds their defaults and records
// what was sent.
export const GEMINI_SETTINGS = ['model', 'thinking_level', 'max_output_tokens', 'note'];

const python = () => process.env.PYTHON ?? 'python3';

function geminiArgs({ video, start, end, prompt, transcriptMode, output, ...settings }) {
  const args = [GEMINI_SCRIPT, '--video-url', watchUrl(videoId(video)), '--start', String(start), '--end', String(end), '--caller', 'connector'];
  args.push(...(transcriptMode ? ['--transcript'] : ['--prompt', prompt]));
  if (output) args.push('--output', output);
  for (const name of GEMINI_SETTINGS) {
    if (settings[name] !== undefined) args.push(`--${name.replaceAll('_', '-')}`, String(settings[name]));
  }
  return args;
}

// The script reports each attempt on its own stderr line, as it happens, then
// a summary of the request, and ends with the reason when it fails; onLog gets
// every line, the error only the last.
export function askGemini(request, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(python(), geminiArgs(request), { timeout: GEMINI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim().split('\n').at(-1) || error.message)) : resolve(stdout.trim())));
    createInterface({ input: child.stderr }).on('line', onLog);
  });
}

// The connector runs whatever version of the skill is installed, so check that
// its script still accepts every argument askGemini can send. Each mode is
// tried with every setting and an empty clip (start after end): the script
// parses all the arguments, then stops at its range check, before reading keys,
// calling Gemini or writing a record. Any other answer means the installed
// skill and this connector disagree.
export async function checkGeminiScript() {
  const setting = { model: 'gemini-check', thinking_level: 'medium', max_output_tokens: 1, note: 'startup check' };
  for (const mode of [{ prompt: 'startup check' }, { transcriptMode: true }]) {
    const request = { video: 'DStYkSO4Cc0', start: 1, end: 0, output: '/dev/null', ...mode, ...setting };
    const stderr = await new Promise((resolve) => {
      execFile(python(), geminiArgs(request), { timeout: 30_000 }, (error, stdout, stderr) => resolve(String(stderr)));
    });
    if (!stderr.includes('Require 0 <= start < end')) {
      throw new Error(`The installed work-with-youtube skill does not accept the arguments this connector sends; `
        + `update it (commit 4d3c353 or later) and reinstall it. ${GEMINI_SCRIPT} said: ${stderr.trim().split('\n').at(-1) || 'nothing'}`);
    }
  }
}
