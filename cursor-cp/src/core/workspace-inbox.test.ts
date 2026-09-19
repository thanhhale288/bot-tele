import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  DEFAULT_PHOTO_PROMPT,
  INBOX_DIR,
  MAX_IMAGE_BYTES,
  encodeImageForAgent,
  expandAtFileRefs,
  formatQuotedReply,
  guessMimeType,
  isImageMime,
  isTextLikeFile,
  listWorkspaceRuleFiles,
  parseAtFileRefs,
  quotedTextFromTelegramShape,
  saveInboxFile,
  transcribeAudioFile,
  transcribeCommands,
} from './workspace-inbox.js';

describe('workspace-inbox', () => {
  it('parses @file refs and ignores emails and bare usernames', () => {
    expect(parseAtFileRefs('@src/a.ts please')).toEqual(['src/a.ts']);
    expect(parseAtFileRefs('see @README.md')).toEqual(['README.md']);
    expect(parseAtFileRefs('user@gmail.com')).toEqual([]);
    expect(parseAtFileRefs('hey @alice')).toEqual([]);
    expect(parseAtFileRefs('@src/a.ts and @src/a.ts')).toEqual(['src/a.ts']);
  });

  it('expands @file refs, lists missing paths, and skips traversal', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'inbox-expand-'));
    mkdirSync(resolve(cwd, 'src'));
    writeFileSync(resolve(cwd, 'src/a.ts'), 'export const x = 1;\n');

    const attached = await expandAtFileRefs(cwd, '@src/a.ts please');
    expect(attached.attached).toEqual(['src/a.ts']);
    expect(attached.missing).toEqual([]);
    expect(attached.prompt).toContain('<file path="src/a.ts">');
    expect(attached.prompt).toContain('export const x = 1;');

    const missing = await expandAtFileRefs(cwd, 'look at @no-such.ts');
    expect(missing.attached).toEqual([]);
    expect(missing.missing).toContain('no-such.ts');

    const traversal = await expandAtFileRefs(cwd, 'see @../../etc/passwd');
    expect(traversal.attached).toEqual([]);
    expect(traversal.prompt).not.toMatch(/root:/);
  });

  it('formats a quoted reply with quoted and user text', () => {
    const out = formatQuotedReply('earlier note', 'please fix');
    expect(out).toContain('earlier note');
    expect(out).toContain('please fix');
    expect(out).toMatch(/replying to this earlier message/i);
    expect(formatQuotedReply('  ', 'just this')).toBe('just this');
  });

  it('extracts quoted text from telegram message shapes', () => {
    expect(quotedTextFromTelegramShape({ text: 'hello' })).toBe('hello');
    expect(quotedTextFromTelegramShape({ caption: 'cap' })).toBe('cap');
    expect(quotedTextFromTelegramShape({ photo: [{}] })).toBe('[photo]');
    expect(quotedTextFromTelegramShape({ document: { file_name: 'a.ts' } })).toBe('[file a.ts]');
    expect(quotedTextFromTelegramShape({ text: 'prefer', caption: 'nope' })).toBe('prefer');
    expect(quotedTextFromTelegramShape(null)).toBe('');
  });

  it('encodes small images and rejects oversized buffers', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = encodeImageForAgent(png, 'image/png');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data).toBe(png.toString('base64'));
      expect(ok.data.startsWith('data:')).toBe(false);
      expect(ok.mimeType).toBe('image/png');
    }

    const oversized = encodeImageForAgent(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png');
    expect(oversized.ok).toBe(false);
  });

  it('guesses mime types and classifies images vs text-like files', () => {
    expect(guessMimeType('shot.png')).toBe('image/png');
    expect(guessMimeType('a.ts')).toMatch(/typescript|plain|javascript/);
    expect(guessMimeType('unknown.bin')).toBe('application/octet-stream');
    expect(guessMimeType('unknown.bin', 'text/plain')).toBe('text/plain');
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('text/plain')).toBe(false);
    expect(isTextLikeFile('a.ts')).toBe(true);
    expect(isTextLikeFile('a.json')).toBe(true);
    expect(isTextLikeFile('a.png')).toBe(false);
    expect(isTextLikeFile('a.pdf')).toBe(false);
    expect(isTextLikeFile('clip.mp3')).toBe(false);
  });

  it('saves inbox files under INBOX_DIR with a sanitized basename and rejects traversal', async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'inbox-save-'));
    const saved = await saveInboxFile(cwd, 'nested/note.txt', Buffer.from('hello-inbox'));
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.relative.startsWith(`${INBOX_DIR}/`)).toBe(true);
      expect(saved.relative.endsWith('-note.txt')).toBe(true);
      expect(readFileSync(saved.absolute, 'utf8')).toBe('hello-inbox');
    }

    const rejected = await saveInboxFile(cwd, '../x', Buffer.from('nope'));
    expect(rejected.ok).toBe(false);
  });

  it('returns whisper argv arrays that include the audio path', () => {
    const audioPath = '/tmp/voice.ogg';
    const cmds = transcribeCommands(audioPath);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((cmd) => cmd.command === 'whisper')).toBe(true);
    for (const cmd of cmds) {
      expect(Array.isArray(cmd.args)).toBe(true);
      expect(cmd.args).toContain(audioPath);
      expect(cmd.args.join(' ')).not.toMatch(/(^|[|&;])\s*sh\s+-c\s/);
    }
  });

  it('fails transcription when the audio file is missing', async () => {
    const result = await transcribeAudioFile(resolve(tmpdir(), 'no-such-voice-xyz.ogg'));
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
  });

  it('lists .cursorrules in a temp workspace', () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'inbox-rules-'));
    writeFileSync(resolve(cwd, '.cursorrules'), 'always be kind');
    expect(listWorkspaceRuleFiles(cwd)).toContain('.cursorrules');
    expect(listWorkspaceRuleFiles(resolve(tmpdir(), 'no-such-ws-dir-xyz'))).toEqual([]);
  });

  it('exports a non-empty default photo prompt', () => {
    expect(DEFAULT_PHOTO_PROMPT.trim().length).toBeGreaterThan(0);
  });
});
