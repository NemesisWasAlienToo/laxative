import { Note, NoteStoreFile, STORE_VERSION } from './types';
import { parseTags } from './tags';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(existing: ReadonlySet<string> = new Set()): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    if (!existing.has(id)) {
      return id;
    }
  }
  throw new Error('could not allocate a unique note id');
}

/** First non-empty markdown line, stripped of leading `#`/list markers. */
export function deriveTitle(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return 'Untitled note';
  }
  const cleaned = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').trim();
  const title = cleaned.length > 0 ? cleaned : 'Untitled note';
  return title.length > 120 ? title.slice(0, 117) + '...' : title;
}

/**
 * Deterministic ordering, so that two people adding notes to different files
 * produce diffs that git can merge instead of conflicting.
 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.character - b.character ||
      a.id.localeCompare(b.id)
  );
}

export function serialize(notes: Note[]): string {
  const doc: NoteStoreFile = { version: STORE_VERSION, notes: sortNotes(notes) };
  return JSON.stringify(doc, null, 2) + '\n';
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Line and column numbers are non-negative integers, whatever the file says. */
function asPosition(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Tolerant parser: unknown/missing fields are repaired rather than thrown away. */
export function parse(text: string): Note[] {
  if (text.trim() === '') {
    return [];
  }
  const raw = JSON.parse(text) as unknown;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as NoteStoreFile)?.notes)
      ? (raw as NoteStoreFile).notes
      : [];

  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const file = asString(entry.file).replace(/\\/g, '/');
    if (!file) {
      continue;
    }
    let id = asString(entry.id);
    if (!id || seen.has(id)) {
      id = newId(seen);
    }
    seen.add(id);
    const body = asString(entry.body);
    const now = new Date().toISOString();
    notes.push({
      id,
      body,
      title: asString(entry.title) || deriveTitle(body),
      file,
      line: asPosition(entry.line),
      character: asPosition(entry.character),
      tags: parseTags(body),
      createdAt: asString(entry.createdAt, now),
      updatedAt: asString(entry.updatedAt, now)
    });
  }
  return sortNotes(notes);
}
