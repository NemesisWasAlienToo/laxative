/**
 * A note's group is written at the end of its first line:
 *
 *   Session expires too early @auth/login
 *   Session expires too early@auth/login      (the same)
 *
 * `auth/login` is group `auth`, and inside it, `login`. A note has one group
 * or none, so there is never a question of which one it belongs to; tags stay
 * free for filtering and references.
 *
 * A group name is letters, digits, `-` and `_`, with `/` between levels, so an
 * email at the end of a line (`ask a@b.com`) is not one. `\@` is a plain `@`,
 * the way markdown escapes any symbol, and shows as `@` when rendered.
 */

const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9_-]*';
const GROUP_AT_END = new RegExp(`\\s*(?<!\\\\)@(${SEGMENT}(?:/${SEGMENT})*)\\s*$`);

/** The first line with something on it, and where it is. */
function firstLine(body: string): { index: number; text: string } | undefined {
  const lines = body.split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  return index < 0 ? undefined : { index, text: lines[index] };
}

/** The group a line ends in, lower-cased, if it ends in one. */
function groupAtEnd(line: string): string | undefined {
  const match = GROUP_AT_END.exec(line);
  return match ? match[1].toLowerCase() : undefined;
}

/** The note's group, lower-cased (`@Auth` and `@auth` are one group). */
export function parseGroup(body: string): string | undefined {
  const first = firstLine(body);
  return first ? groupAtEnd(first.text) : undefined;
}

/** A first line without the group at its end. */
export function withoutGroup(line: string): string {
  return line.replace(GROUP_AT_END, '');
}

/**
 * The body with its group set to `group`, or removed when `group` is empty.
 * Only the end of the first line changes; an empty note becomes just the group.
 */
export function setGroup(body: string, group: string | undefined): string {
  const name = group ? normalizeGroup(group) : undefined;
  const first = firstLine(body);
  if (!first) {
    return name ? `@${name}` + body : body;
  }
  const lines = body.split('\n');
  const bare = withoutGroup(first.text).replace(/\s+$/, '');
  lines[first.index] = name ? (bare ? `${bare} @${name}` : `@${name}`) : bare;
  return lines.join('\n');
}

/**
 * What someone typed as a group, as a group name: no `@`, spaces become `-`,
 * no empty levels, and anything a group name cannot hold is dropped. Empty
 * when nothing usable is left.
 */
export function normalizeGroup(typed: string): string {
  return typed
    .trim()
    .replace(/^@+/, '')
    .split('/')
    .map((part) => part.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').replace(/^-+/, ''))
    .filter((part) => part.length > 0)
    .join('/')
    .toLowerCase();
}

/** `auth/login/session` -> `auth`, `auth/login`, `auth/login/session`. */
export function groupPath(group: string): string[] {
  const parts = group.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Every group used, with each parent level too, sorted. */
export function allGroups(notes: readonly { group?: string }[]): string[] {
  const found = new Set<string>();
  for (const note of notes) {
    if (note.group) {
      for (const level of groupPath(note.group)) {
        found.add(level);
      }
    }
  }
  return [...found].sort();
}
