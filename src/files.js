// The one folder Claude on the web may read and write on this machine.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const FILES_DIR = resolve(process.env.FILES_DIR ?? join(homedir(), 'YouTube_from_Claude'));
const MAX_READ_CHARS = 500_000;

// Only relative paths that stay inside the folder. Every file in it is written
// by these tools, which never create links, so checking the path is enough.
export function insidePath(path, root = FILES_DIR) {
  if (!path || isAbsolute(path)) throw new Error(`Give a path relative to the saved-files folder, not ${JSON.stringify(path)}`);
  const full = resolve(root, path);
  if (!full.startsWith(root + sep)) throw new Error(`${path} is outside the saved-files folder`);
  return full;
}

export async function listFiles(folder = '', root = FILES_DIR) {
  const base = folder ? insidePath(folder, root) : root;
  await mkdir(root, { recursive: true });
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const full = join(entry.parentPath, entry.name);
    // A Gemini request's marker shows its state, its first line, instead of a size.
    if (/\.(running|failed)$/.test(entry.name)) return `${relative(root, full)}: ${(await readFile(full, 'utf8')).split('\n')[0].slice(0, 300)}`;
    return `${relative(root, full)} (${(await stat(full)).size} bytes)`;
  }));
  return files.length > 0 ? files.sort().join('\n') : 'No files yet';
}

export async function readText(path, root = FILES_DIR) {
  const text = await readFile(insidePath(path, root), 'utf8');
  if (text.length > MAX_READ_CHARS) throw new Error(`${path} has ${text.length} characters, more than ${MAX_READ_CHARS} can be read at once`);
  return text;
}

// Creates folders as needed, and replaces an existing file only when asked to.
export async function writeText(path, text, overwrite = false, root = FILES_DIR) {
  const full = insidePath(path, root);
  await mkdir(dirname(full), { recursive: true });
  try {
    await writeFile(full, text, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${path} already exists; set overwrite to true to replace it`);
    throw error;
  }
  return `Saved ${relative(root, full)} (${Buffer.byteLength(text)} bytes) in ${root}`;
}
