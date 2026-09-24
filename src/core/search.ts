/**
 * Matching notes for the search view and the graph's filter box. Both offer an
 * exclude as well as a search, so the same rules have to hold in both places:
 * the graph's copy of this lives in `media/graph.js`, and both are tested.
 *
 * The rules, kept deliberately plain:
 *   - a search is split on whitespace, and every term has to appear somewhere
 *     in the note (title, body, file path, or a hashtag);
 *   - an exclude is split the same way, and a note matching *any* of its terms
 *     is dropped, whatever the search says;
 *   - a search term written with a leading minus, `-test`, is an exclude too,
 *     so one box can do both: `cache -test -#wip`;
 *   - everything is case-insensitive, and matching is on substrings, so `cach`
 *     finds `src/cache.ts`.
 */

export interface Searchable {
  title: string;
  body: string;
  /** Absent for a note that points at no line of code. */
  file?: string;
  tags: string[];
}

export interface Query {
  query?: string;
  exclude?: string;
}

/** Search terms in a box: whitespace- or comma-separated, lower-cased. */
export function terms(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\s,]+/)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
}

/**
 * Everything about a note that a search looks at, as one lower-cased string.
 *
 * Cached against the note itself: a note's text is searched again on every
 * keystroke and once per group the list draws, and joining and lower-casing a
 * whole body each time is the difference between a list that scrolls and one
 * that stutters. The cache is a WeakMap, so reloading the store drops it.
 */
const cache = new WeakMap<object, string>();

export function haystack(note: Searchable): string {
  const known = cache.get(note as object);
  if (known !== undefined) {
    return known;
  }
  const text = [note.title, note.body, note.file ?? '', ...(note.tags ?? []).map((tag) => `#${tag}`)]
    .join('\n')
    .toLowerCase();
  cache.set(note as object, text);
  return text;
}

/** A query with its terms already split out, ready to run over many notes. */
export interface Compiled {
  include: string[];
  exclude: string[];
}

/**
 * Splitting the boxes into terms is done once per query, not once per note:
 * running it per note meant two regex splits for every note in the list, every
 * time the list drew a group.
 */
export function compile(query: Query): Compiled {
  const include: string[] = [];
  const exclude = terms(query.exclude);
  for (const term of terms(query.query)) {
    // `-test` in the search itself excludes, the way it does in a web search.
    // A lone "-" is just a character someone is part-way through typing.
    if (term.startsWith('-') && term.length > 1) {
      exclude.push(term.slice(1));
    } else if (term !== '-') {
      include.push(term);
    }
  }
  return { include, exclude };
}

/** True when a query would narrow anything down at all. */
export function isActive(query: Query): boolean {
  const compiled = compile(query);
  return compiled.include.length > 0 || compiled.exclude.length > 0;
}

export function test(note: Searchable, compiled: Compiled): boolean {
  const text = haystack(note);
  if (compiled.exclude.some((term) => text.includes(term))) {
    return false;
  }
  return compiled.include.every((term) => text.includes(term));
}

/** One note against one query; `compile` + `test` for a whole list. */
export function matches(note: Searchable, query: Query): boolean {
  return test(note, compile(query));
}

export function searchNotes<T extends Searchable>(notes: readonly T[], query: Query): T[] {
  const compiled = compile(query);
  return notes.filter((note) => test(note, compiled));
}
