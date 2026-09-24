import { Note, NoteStoreFile, STORE_VERSION } from './types';
import { Located, located } from './display';
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
  return [...notes].sort((a, b) => {
    // Notes with no location have nothing to be in the order of, so they go
    // after the ones that do, in a stable order of their own.
    if (!located(a) || !located(b)) {
      return (
        Number(located(b)) - Number(located(a)) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
      );
    }
    return (
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.character - b.character ||
      a.id.localeCompare(b.id)
    );
  });
}

/** Only the fields that belong on disk, in a fixed order, so diffs stay stable. */
function onDisk(note: Note): Note {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    // A note with no location carries no location fields at all, rather than
    // an empty path and a line 0 that read as a real place.
    ...(located(note) ? { file: note.file, line: note.line, character: note.character } : {}),
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

/**
 * An export carries which note file each note came from, which a store file
 * never does: there, the file a note is written in *is* the answer, but an
 * export is one document standing in for several, and without it an import
 * has no way to put them back where they were.
 *
 * The notes stay a flat list under `notes`, so a reader that knows nothing of
 * note files still reads every note in the export.
 */
export function serializeExport(notes: readonly Note[]): string {
  const doc = {
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    notes: sortNotes([...notes]).map((note) => ({
      ...onDisk(note),
      ...(note.store ? { store: note.store } : {})
    }))
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

export function serialize(notes: Note[]): string {
  const doc: NoteStoreFile = { version: STORE_VERSION, notes: sortNotes(notes).map(onDisk) };
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

/**
 * Where a note points, if it points anywhere. There is no flag for that: a
 * note that does not carry all three of file, line and character is about the
 * workspace rather than about a line in it. A value that is there but nonsense
 * is still repaired, so only a missing one means "nowhere".
 */
function locationOf(entry: Record<string, unknown>): Located | undefined {
  const file = asString(entry.file).replace(/\\/g, '/');
  if (!file || entry.line === undefined || entry.line === null) {
    return undefined;
  }
  if (entry.character === undefined || entry.character === null) {
    return undefined;
  }
  return { file, line: asPosition(entry.line), character: asPosition(entry.character) };
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
    const at = locationOf(entry);
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
      ...(at ?? {}),
      tags: parseTags(body),
      createdAt: asString(entry.createdAt, now),
      updatedAt: asString(entry.updatedAt, now),
      // Only an export carries this; it is what puts the notes back in the
      // files they came from.
      ...(asString(entry.store) ? { store: asString(entry.store) } : {})
    });
  }
  return sortNotes(notes);
}
