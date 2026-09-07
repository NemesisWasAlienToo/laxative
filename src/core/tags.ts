/**
 * Hashtags are written inline in a note's body (`#refactor`, `#perf/hot-path`)
 * and are how notes get grouped across files.
 *
 * Markdown uses `#` too, so the rules below are deliberately narrow. A `#` only
 * starts a tag when all of these hold:
 *
 *   - it is followed immediately by a letter, so ATX headings (`# Title`,
 *     `### Title` — CommonMark requires the space) and issue refs (`#123`) are
 *     left alone;
 *   - it is not preceded by a word character, `#`, `/`, `&`, `(` or `\`, so
 *     `a#b`, `##`, url fragments (`https://x/y#frag`), heading anchors
 *     (`[jump](#section)`), html entities (`&#160;`) and escapes (`\#literal`)
 *     are left alone;
 *   - it is outside fenced and inline code;
 *   - it does not look like a 6- or 8-digit hex colour (`#a1b2c3`).
 */

const TAG_PATTERN = /(?<![\w`#/&(\\])#([A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)*)/g;
const HEX_COLOUR = /^(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Blanks out code so tags cannot be picked up from it. Done line by line rather
 * than with one regex so that an unterminated fence still swallows the rest of
 * the note. Indented blocks are deliberately left alone: in a note, four spaces
 * is far more often a nested list item than a code block.
 */
function stripCode(body: string): string {
  const blank = (text: string) => ' '.repeat(text.length);
  let fence: string | undefined;
  return body
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(```+|~~~+)/.exec(line);
      if (fence !== undefined) {
        if (marker && line.trim().startsWith(fence)) {
          fence = undefined;
        }
        return blank(line);
      }
      if (marker) {
        fence = marker[1];
        return blank(line);
      }
      return line.replace(/`[^`]*`/g, blank);
    })
    .join('\n');
}

/** Tags in a note body, lower-cased and de-duplicated, in order of appearance. */
export function parseTags(body: string): string[] {
  const prose = stripCode(body);
  const found = new Set<string>();
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(prose)) !== null) {
    if (!HEX_COLOUR.test(match[1])) {
      found.add(match[1].toLowerCase());
    }
  }
  return [...found];
}

/** Every tag used across a set of notes, most used first, with counts. */
export function tagIndex(notes: readonly { tags: string[] }[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
