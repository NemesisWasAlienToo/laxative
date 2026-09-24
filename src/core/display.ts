/** How a note is labelled in the Notes view. */

export interface Located {
  file: string;
  line: number;
  character: number;
}

/** A note may point at a line of code, or at nothing: it is just a note. */
export type MaybeLocated = Partial<Located>;

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
  return showFile ? `${note.file}:${note.line + 1}` : undefined;
}

/** First line of a note's hover card: where it points, when it points anywhere. */
export function noteLocation(note: MaybeLocated): string | undefined {
  return located(note)
    ? `${note.file}, line ${note.line + 1}, column ${note.character + 1}`
    : undefined;
}

/** `src/a.ts:12`, or nothing at all. For a line of detail beside a title. */
export function noteAnchor(note: MaybeLocated): string | undefined {
  return located(note) ? `${note.file}:${note.line + 1}` : undefined;
}
