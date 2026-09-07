/** Pure helpers shared by the note editor and its completion provider. */

/** A filename-safe version of a note title, used for the editor's tab label. */
export function slugForTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const slug = cleaned.length > 0 ? cleaned : 'Untitled note';
  return slug.length > 60 ? slug.slice(0, 60).trimEnd() : slug;
}

export interface Prefix {
  /** What the user has typed after the trigger. */
  query: string;
  /** Character offset where the whole token (trigger included) starts. */
  start: number;
}

/** An unclosed `[[` before the cursor, i.e. the user is picking a note. */
export function refPrefix(lineUpToCursor: string): Prefix | undefined {
  const match = /\[\[([^\]\n]*)$/.exec(lineUpToCursor);
  return match ? { query: match[1], start: match.index } : undefined;
}

/** A `#` before the cursor that would become a hashtag, i.e. the user is tagging. */
export function tagPrefix(lineUpToCursor: string): Prefix | undefined {
  const match = /(?:^|[^\w`#/&(\\])(#[\w-]*)$/.exec(lineUpToCursor);
  if (!match) {
    return undefined;
  }
  const start = lineUpToCursor.length - match[1].length;
  return { query: match[1].slice(1), start };
}
