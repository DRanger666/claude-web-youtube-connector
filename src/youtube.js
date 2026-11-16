// YouTube and Gemini access, reusing the work-with-youtube skill's scripts so
// that Claude Code and this connector share one implementation.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
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

export function askGemini({ video, start, end, prompt, transcriptMode, output }) {
  const args = [GEMINI_SCRIPT, '--video-url', watchUrl(videoId(video)), '--start', String(start), '--end', String(end)];
  args.push(...(transcriptMode ? ['--transcript'] : ['--prompt', prompt]));
  if (output) args.push('--output', output);
  return new Promise((resolve, reject) => {
    execFile(process.env.PYTHON ?? 'python3', args, { timeout: GEMINI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())));
  });
}
