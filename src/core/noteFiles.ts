/**
 * Notes can be split across several files — one shared with the team, one kept
 * private, one per area of the codebase — each with a name of your choosing.
 * Which of them are switched on decides what the rest of the extension sees.
 *
 * The shape on disk is `laxative.noteFiles`:
 *
 *   [{ "name": "team", "path": ".laxative/notes.json", "enabled": true }]
 *
 * Everything here is pure, so the rules that decide what a valid entry is can
 * be tested without a workspace.
 */

export interface NoteFileConfig {
  /** How you refer to this file; unique, and shown wherever notes are grouped. */
  name: string;
  /** Workspace-relative, posix-separated. */
  path: string;
  enabled: boolean;
}

export const DEFAULT_PATH = '.laxative/notes.json';

/** Workspace-relative posix path, or undefined if it is not one we will write. */
export function normalisePath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (trimmed === '' || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    return undefined;
  }
  if (trimmed.split('/').some((segment) => segment === '..')) {
    return undefined;
  }
  return trimmed;
}

/** `.laxative/notes.local.json` -> `notes.local`, so a file always has a name. */
export function nameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.json$/i, '') || 'notes';
}

/** Why this name cannot be used, or undefined when it can. */
export function validateName(name: string, taken: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'Give the file a name.';
  }
  if (taken.some((other) => other.toLowerCase() === trimmed.toLowerCase())) {
    return `There is already a note file called "${trimmed}".`;
  }
  return undefined;
}

/** Why this path cannot be used, or undefined when it can. */
export function validatePath(path: string, taken: readonly string[]): string | undefined {
  const normalised = normalisePath(path);
  if (!normalised) {
    return 'Use a path inside the workspace, without "..".';
  }
  if (taken.some((other) => other === normalised)) {
    return 'Another note file already uses that path.';
  }
  return undefined;
}

/**
 * Reads the configured list, repairing whatever it finds rather than refusing
 * to start: a broken entry in settings should cost you that entry, not every
 * note you have.
 *
 * An empty list means the single-file setup this extension started with, so
 * `laxative.storeFile` is used and existing workspaces carry on unchanged.
 */
export function parseNoteFiles(raw: unknown, legacyPath: string): NoteFileConfig[] {
  const entries = Array.isArray(raw) ? raw : [];
  const files: NoteFileConfig[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const path = normalisePath(record.path);
    if (!path || paths.has(path)) {
      continue; // No path, or the same file twice: nothing to read.
    }
    paths.add(path);

    const wanted = typeof record.name === 'string' ? record.name.trim() : '';
    let name = wanted || nameFromPath(path);
    if (names.has(name.toLowerCase())) {
      // Names address a file, so they have to be distinct.
      let n = 2;
      while (names.has(`${name} ${n}`.toLowerCase())) {
        n++;
      }
      name = `${name} ${n}`;
    }
    names.add(name.toLowerCase());
    files.push({ name, path, enabled: record.enabled !== false });
  }

  if (files.length === 0) {
    const path = normalisePath(legacyPath) ?? DEFAULT_PATH;
    return [{ name: nameFromPath(path), path, enabled: true }];
  }
  if (!files.some((file) => file.enabled)) {
    // Nothing switched on shows nothing at all, which reads as a broken
    // extension rather than a choice. One file always stays on.
    files[0].enabled = true;
  }
  return files;
}

/** The files notes are read from and written to right now. */
export function enabledFiles(files: readonly NoteFileConfig[]): NoteFileConfig[] {
  return files.filter((file) => file.enabled);
}
