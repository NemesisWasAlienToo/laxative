/** How a note is labelled in the Notes view. */

export interface Located {
  file: string;
  line: number;
  character: number;
}

/**
 * The muted text beside a note's title in the tree.
 *
 * Grouped by file, the file name is already the parent row, so a bare `:12`
 * added nothing but a puzzle: there is no description at all. Grouped by
 * hashtag the notes come from all over, so each one says where it is, in the
 * `path:line` form editors and stack traces use.
 */
export function noteDescription(note: Located, showFile: boolean): string | undefined {
  return showFile ? `${note.file}:${note.line + 1}` : undefined;
}

/** First line of a note's hover card: where it points, always spelled out. */
export function noteLocation(note: Located): string {
  return `${note.file}, line ${note.line + 1}, column ${note.character + 1}`;
}
