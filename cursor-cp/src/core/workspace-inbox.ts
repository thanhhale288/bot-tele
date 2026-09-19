/**
 * Phase 5 — inbox / media helpers (images, @file refs, quoted replies, whisper argv).
 * Commands use execa argv arrays, never a shell string.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import { safeResolveWorkspacePath } from './workspace-review.js';
import { runWorkspaceCommand, validateWorkspaceCwd } from './workspace-shell.js';

export const INBOX_DIR = '.cursor-cp-inbox';
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACH_TEXT_BYTES = 120_000;
export const DEFAULT_PHOTO_PROMPT =
  'Please look at this image and help. If it looks like a bug, explain and fix it.';
export const DEFAULT_FILE_PROMPT = 'Please look at this uploaded file and help.';
export const DEFAULT_VOICE_PROMPT = 'Please follow the transcribed voice message.';

const MAX_QUOTED_CHARS = 4000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const TRANSCRIBE_HINT =
  'Could not transcribe. Install whisper (e.g. brew install openai-whisper) or send text instead.';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.jsx': 'text/jsx',
  '.css': 'text/css',
  '.html': 'text/html',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.sh': 'text/x-shellscript',
  '.pdf': 'application/pdf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
};

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.json',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.py',
  '.rs',
  '.go',
  '.sh',
  '.xml',
]);

const AT_FILE_RE =
  /(?<![\w.])@((?:\.\.?\/)?[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*)/g;

export function guessMimeType(filename: string, fallback?: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || fallback || 'application/octet-stream';
}

function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(';')[0]?.trim() || '';
}

export function isImageMime(mime: string): boolean {
  return normalizeMime(mime).startsWith('image/');
}

export function isAudioMime(mime: string): boolean {
  const m = normalizeMime(mime);
  return m.startsWith('audio/') || m === 'application/ogg';
}

export function isTextLikeFile(filename: string, mime?: string): boolean {
  const m = normalizeMime(mime || guessMimeType(filename));
  if (
    m.startsWith('image/') ||
    m.startsWith('audio/') ||
    m.startsWith('video/') ||
    m === 'application/pdf' ||
    m.includes('zip')
  ) {
    return false;
  }
  if (m.startsWith('text/')) return true;
  if (m.includes('json') || m.includes('javascript') || m.includes('xml')) return true;
  return TEXT_EXTS.has(extname(filename).toLowerCase());
}

export function encodeImageForAgent(
  buf: Buffer,
  mimeType: string
): { ok: true; data: string; mimeType: string } | { ok: false; error: string } {
  if (!buf.length) {
    return { ok: false, error: 'Image is empty.' };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Image exceeds ${MAX_IMAGE_BYTES} bytes.` };
  }
  return { ok: true, data: buf.toString('base64'), mimeType };
}

function looksLikeFileRef(ref: string): boolean {
  if (ref.includes('/')) return true;
  const dot = ref.lastIndexOf('.');
  return dot > 0 && /\.[A-Za-z0-9]+$/.test(ref);
}

export function parseAtFileRefs(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  AT_FILE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AT_FILE_RE.exec(text)) !== null) {
    const ref = match[1];
    if (!ref || !looksLikeFileRef(ref) || seen.has(ref)) continue;
    seen.add(ref);
    found.push(ref);
  }
  return found;
}

export async function expandAtFileRefs(
  cwd: string,
  text: string
): Promise<{ prompt: string; attached: string[]; missing: string[] }> {
  const refs = parseAtFileRefs(text);
  if (refs.length === 0) {
    return { prompt: text, attached: [], missing: [] };
  }

  const attached: string[] = [];
  const missing: string[] = [];
  const blocks: string[] = [];

  for (const ref of refs) {
    const resolved = safeResolveWorkspacePath(cwd, ref);
    if (!resolved.ok) {
      missing.push(ref);
      continue;
    }

    if (!existsSync(resolved.absolute)) {
      missing.push(ref);
      continue;
    }

    let stat;
    try {
      stat = statSync(resolved.absolute);
    } catch {
      missing.push(ref);
      continue;
    }

    if (!stat.isFile()) {
      missing.push(ref);
      continue;
    }

    const mime = guessMimeType(resolved.relative);
    if (!isTextLikeFile(resolved.relative, mime)) {
      blocks.push(
        `(Skipped ${resolved.relative}: not a text file — ${mime || 'binary'}.)`
      );
      continue;
    }

    if (stat.size > MAX_ATTACH_TEXT_BYTES) {
      blocks.push(
        `(Skipped ${resolved.relative}: too large to attach (${stat.size} bytes).)`
      );
      continue;
    }

    let buf: Buffer;
    try {
      buf = await readFile(resolved.absolute);
    } catch {
      missing.push(ref);
      continue;
    }

    if (buf.includes(0)) {
      blocks.push(`(Skipped ${resolved.relative}: binary file.)`);
      continue;
    }

    attached.push(resolved.relative);
    blocks.push(`<file path="${resolved.relative}">\n${buf.toString('utf8')}\n</file>`);
  }

  const prompt = blocks.length > 0 ? `${text}\n\n${blocks.join('\n\n')}` : text;
  return { prompt, attached, missing };
}

export function formatQuotedReply(quoted: string, userText: string): string {
  const trimmed = quoted.trim();
  if (!trimmed) return userText;
  const clipped = trimmed.length > MAX_QUOTED_CHARS ? trimmed.slice(0, MAX_QUOTED_CHARS) : trimmed;
  return [
    'The user is replying to this earlier message:',
    '"""',
    clipped,
    '"""',
    userText,
  ].join('\n');
}

export function quotedTextFromTelegramShape(
  msg:
    | {
        text?: string;
        caption?: string;
        photo?: unknown;
        document?: { file_name?: string };
        voice?: unknown;
        audio?: { title?: string; file_name?: string };
      }
    | undefined
    | null
): string {
  if (!msg) return '';
  if (msg.text?.trim()) return msg.text.trim();
  if (msg.caption?.trim()) return msg.caption.trim();
  if (msg.photo) return '[photo]';
  if (msg.document) {
    const name = msg.document.file_name?.trim();
    return name ? `[file ${name}]` : '[file]';
  }
  if (msg.voice) return '[voice message]';
  if (msg.audio) {
    const label = msg.audio.title?.trim() || msg.audio.file_name?.trim();
    return label ? `[audio ${label}]` : '[audio]';
  }
  return '';
}

function inboxStamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

function sanitizeInboxFilename(filename: string): string | null {
  const raw = filename.trim();
  if (!raw || raw.includes('..')) return null;
  const base = basename(raw).replace(/[/\\]/g, '').trim();
  if (!base || base === '.' || base === '..' || base.includes('..')) return null;
  return base;
}

export async function saveInboxFile(
  cwd: string,
  filename: string,
  data: Buffer
): Promise<{ ok: true; relative: string; absolute: string } | { ok: false; error: string }> {
  const invalid = validateWorkspaceCwd(cwd);
  if (invalid) {
    return { ok: false, error: invalid };
  }
  if (!data.length) {
    return { ok: false, error: 'File is empty.' };
  }

  const base = sanitizeInboxFilename(filename);
  if (!base) {
    return { ok: false, error: 'Invalid filename.' };
  }

  const relative = `${INBOX_DIR}/${inboxStamp()}-${base}`;
  const resolved = safeResolveWorkspacePath(cwd, relative);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  try {
    await mkdir(resolve(cwd, INBOX_DIR), { recursive: true });
    await writeFile(resolved.absolute, data);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, relative: resolved.relative, absolute: resolved.absolute };
}

export function transcribeCommands(audioPath: string): Array<{ command: string; args: string[] }> {
  const outDir = dirname(audioPath) || '.';
  const stem = join(outDir, basename(audioPath, extname(audioPath)));
  return [
    {
      command: 'whisper',
      args: [audioPath, '--model', 'tiny', '--output_format', 'txt', '--output_dir', outDir],
    },
    {
      command: 'whisper-cli',
      args: ['-f', audioPath, '-m', 'tiny', '-otxt', '-of', stem],
    },
    {
      command: 'whisper.cpp',
      args: ['-f', audioPath, '-m', 'tiny', '-otxt'],
    },
  ];
}

function commandCwd(audioPath: string): string {
  const dir = dirname(audioPath);
  try {
    if (dir && existsSync(dir) && statSync(dir).isDirectory()) return dir;
  } catch {
    // fall through
  }
  return tmpdir();
}

function txtCandidates(audioPath: string, args: string[]): string[] {
  const dir = dirname(audioPath);
  const stem = basename(audioPath, extname(audioPath));
  const candidates = [join(dir, `${stem}.txt`)];

  const outDirIdx = args.indexOf('--output_dir');
  if (outDirIdx >= 0 && args[outDirIdx + 1]) {
    candidates.push(join(args[outDirIdx + 1], `${stem}.txt`));
  }

  const ofIdx = args.indexOf('-of');
  if (ofIdx >= 0 && args[ofIdx + 1]) {
    const of = args[ofIdx + 1];
    candidates.push(of.endsWith('.txt') ? of : `${of}.txt`);
  }

  return candidates;
}

async function readTxtIfPresent(path: string): Promise<string> {
  try {
    if (!existsSync(path)) return '';
    const stat = statSync(path);
    if (!stat.isFile()) return '';
    const buf = await readFile(path);
    return buf.toString('utf8').trim();
  } catch {
    return '';
  }
}

export async function transcribeAudioFile(
  audioPath: string
): Promise<{ ok: boolean; text: string; engine?: string; error?: string }> {
  if (!audioPath || !existsSync(audioPath)) {
    return { ok: false, text: '', error: 'Audio file not found.' };
  }

  try {
    if (!statSync(audioPath).isFile()) {
      return { ok: false, text: '', error: 'Audio file not found.' };
    }
  } catch {
    return { ok: false, text: '', error: 'Audio file not found.' };
  }

  const cwd = commandCwd(audioPath);
  const recipes = transcribeCommands(audioPath);

  for (const recipe of recipes) {
    const result = await runWorkspaceCommand({
      cwd,
      command: recipe.command,
      args: recipe.args,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    });

    let text = '';
    for (const candidate of txtCandidates(audioPath, recipe.args)) {
      text = await readTxtIfPresent(candidate);
      if (text) break;
    }
    if (!text) {
      text = (result.stdout || '').trim();
    }

    if (text) {
      return { ok: true, text, engine: recipe.command };
    }
  }

  return { ok: false, text: '', error: TRANSCRIBE_HINT };
}

function posixRel(path: string): string {
  return path.split(/[/\\]/).join('/');
}

export function listWorkspaceRuleFiles(cwd: string): string[] {
  const root = cwd.trim();
  if (!root) return [];
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const found: string[] = [];

  const cursorrules = resolve(root, '.cursorrules');
  try {
    if (existsSync(cursorrules) && statSync(cursorrules).isFile()) {
      found.push('.cursorrules');
    }
  } catch {
    // skip
  }

  const rulesDir = resolve(root, '.cursor', 'rules');
  try {
    if (existsSync(rulesDir) && statSync(rulesDir).isDirectory()) {
      const names = readdirSync(rulesDir)
        .filter((name) => {
          const ext = extname(name).toLowerCase();
          return ext === '.mdc' || ext === '.md';
        })
        .sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const abs = resolve(rulesDir, name);
        try {
          if (statSync(abs).isFile()) {
            found.push(posixRel(join('.cursor', 'rules', name)));
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  for (const rel of ['AGENTS.md', join('.cursor', 'AGENTS.md')]) {
    const abs = resolve(root, rel);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        found.push(posixRel(rel));
      }
    } catch {
      // skip
    }
  }

  return found;
}

export function formatTranscribedVoice(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return DEFAULT_VOICE_PROMPT;
  return `${DEFAULT_VOICE_PROMPT}\n\n${trimmed}`;
}

export function formatInboxSaved(relative: string): string {
  return `Saved uploaded file to ${relative}`;
}
