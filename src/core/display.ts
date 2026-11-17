/** How a note is labelled in the Notes view. */

export interface Located {
  file: string;
  line: number;
  character: number;
}

/** A note may point at a line of code, or at nothing: it is just a note. */
export type MaybeLocated = Partial<Located> & {
  /** Its code is no longer in the file, so its line number means nothing. */
  lost?: boolean;
};

/** Said instead of a line number when the note's code has gone. */
export const LOST_LABEL = 'code not found';

export function located<T extends MaybeLocated>(note: T): note is T & Located {
  return (
    typeof note.file === 'string' &&
    note.file !== '' &&
    typeof note.line === 'number' &&
    typeof note.character === 'number'
  );
}

/**
 * The muted text beside a note's title in the tree.
 *
 * Grouped by file, the file name is already the parent row, so a bare `:12`
 * added nothing but a puzzle: there is no description at all. Grouped by
 * hashtag the notes come from all over, so each one says where it is, in the
 * `path:line` form editors and stack traces use.
 */
export function noteDescription(note: MaybeLocated, showFile: boolean): string | undefined {
  if (!located(note)) {
    return undefined;
  }
  if (note.lost) {
    return showFile ? `${note.file} · ${LOST_LABEL}` : LOST_LABEL;
  }
  return showFile ? `${note.file}:${note.line + 1}` : undefined;
}

/** First line of a note's hover card: where it points, when it points anywhere. */
export function noteLocation(note: MaybeLocated): string | undefined {
  if (!located(note)) {
    return undefined;
  }
  return note.lost
    ? `${note.file}, ${LOST_LABEL}`
    : `${note.file}, line ${note.line + 1}, column ${note.character + 1}`;
}

/** `src/a.ts:12`, or nothing at all. For a line of detail beside a title. */
export function noteAnchor(note: MaybeLocated): string | undefined {
  if (!located(note)) {
    return undefined;
  }
  return note.lost ? `${note.file} · ${LOST_LABEL}` : `${note.file}:${note.line + 1}`;
}
