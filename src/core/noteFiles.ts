/**
 * Notes are split across files in one folder, `.laxative/`, and that folder is
 * the list: every `*.json` in it is a note file, named after the file itself.
 * Nothing lists them in settings, so a file added by a teammate, a `git pull`
 * or by hand is simply there, and one deleted is simply gone.
 *
 * The only thing settings hold is which of them you are looking at right now,
 * `laxative.activeNoteFiles`, by name. Empty means all of them, so a workspace
 * that has never chosen shows everything, and new files show up as they appear.
 *
 * Everything here is pure, so the rules can be tested without a workspace.
 */

export interface NoteFileConfig {
  /** How you refer to this file: its file name without `.json`. */
  name: string;
  /** Workspace-relative, posix-separated. */
  path: string;
  enabled: boolean;
}

/** The one folder note files live in. */
export const NOTES_DIR = '.laxative';

/** The file a workspace starts with, before anything has been named. */
export const DEFAULT_NAME = 'notes';
export const DEFAULT_PATH = `${NOTES_DIR}/${DEFAULT_NAME}.json`;

/** Names that are still devices on Windows, whatever folder they sit in. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Characters a file name cannot carry, or that would read as a path. */
const UNUSABLE = /[\x00-\x1f\x7f\\\/:*?"<>|]+/g;

/** `.laxative/review.json` -> `review`. */
export function nameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.json$/i, '') || DEFAULT_NAME;
}

/**
 * The file a note file called `name` is created as: `Design Notes` becomes
 * `.laxative/design-notes.json`. The name is what you call the file
 * everywhere, so the file on disk is named after it rather than after some
 * fixed default — that is the whole point of naming it.
 *
 * `taken` are the paths already there, so two names that would sharpen down to
 * the same file name still get a file each.
 */
export function pathForName(name: string, taken: readonly string[] = []): string {
  const slug =
    name
      .trim()
      .replace(/\.json$/i, '')
      .replace(UNUSABLE, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .toLowerCase() || DEFAULT_NAME;
  const base = RESERVED.test(slug) ? `${slug}-notes` : slug;

  let path = `${NOTES_DIR}/${base}.json`;
  for (let n = 2; taken.includes(path); n++) {
    path = `${NOTES_DIR}/${base}-${n}.json`;
  }
  return path;
}

/**
 * Why a note file cannot be called this, or undefined when it can. Checked
 * against the paths already there rather than the names, since two names can
 * sharpen down to one file: `Design Notes` is `design-notes`.
 */
export function validateName(name: string, takenPaths: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'Give the file a name.';
  }
  const path = pathForName(trimmed);
  if (takenPaths.includes(path)) {
    return `There is already a note file called "${nameFromPath(path)}".`;
  }
  return undefined;
}

/** The names in `laxative.activeNoteFiles`, however the setting was written. */
export function activeNames(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * The note files of a workspace: whatever `.laxative/` holds, with the ones
 * named in `active` switched on.
 *
 * `notes` comes first when it is there, since that is where a workspace's
 * notes start and where they go when nothing else is chosen; the rest follow
 * in alphabetical order, so the list never depends on what the file system
 * happened to hand back.
 *
 * An empty `active` means all of them, and so does one naming only files that
 * are no longer there: switching every file off would leave every view
 * inexplicably empty.
 */
export function discoverFiles(entries: readonly string[], active: unknown): NoteFileConfig[] {
  const names = new Set<string>();
  const files: NoteFileConfig[] = [];
  for (const entry of entries) {
    // `notes.json.tmp` is a write in flight, and a folder is not a note file.
    if (!/\.json$/i.test(entry) || entry.includes('/')) {
      continue;
    }
    const name = nameFromPath(entry);
    if (names.has(name.toLowerCase())) {
      continue; // `Review.json` beside `review.json`: one name, one file.
    }
    names.add(name.toLowerCase());
    files.push({ name, path: `${NOTES_DIR}/${entry}`, enabled: true });
  }

  const rank = (file: NoteFileConfig) => (file.name === DEFAULT_NAME ? 0 : 1);
  files.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  if (files.length === 0) {
    // Nothing yet: the file the first note will be written to.
    return [{ name: DEFAULT_NAME, path: DEFAULT_PATH, enabled: true }];
  }

  const wanted = new Set(activeNames(active).map((name) => name.toLowerCase()));
  if (wanted.size === 0 || !files.some((file) => wanted.has(file.name.toLowerCase()))) {
    return files;
  }
  return files.map((file) => ({ ...file, enabled: wanted.has(file.name.toLowerCase()) }));
}

/** The files notes are read from and written to right now. */
export function enabledFiles(files: readonly NoteFileConfig[]): NoteFileConfig[] {
  return files.filter((file) => file.enabled);
}
