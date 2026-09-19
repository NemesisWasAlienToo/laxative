/**
 * What the Notes list shows: the notes that survive the search and the hashtag
 * filter, put into groups. Plain data in and out, so the list can be drawn by
 * anything — it is drawn by a webview — and tested without an editor.
 */
import { noteDescription, noteLocation } from './display';
import { Query, compile, isActive, test } from './search';
import { tagIndex } from './tags';

export type GroupBy = 'file' | 'tag' | 'store';

export interface ListNote {
  id: string;
  title: string;
  body: string;
  file: string;
  line: number;
  character: number;
  tags: string[];
  store?: string;
}

export interface ListRow {
  /** Unique in the list: a note under two hashtags is two rows. */
  id: string;
  noteId: string;
  title: string;
  description?: string;
  /** Where the note points and how it starts, for the row's hover. */
  tooltip: string;
}

export interface ListGroup {
  id: string;
  kind: 'file' | 'tag' | 'untagged' | 'store';
  label: string;
  description: string;
  /** The annotated file, for a file group, so it can be given that file's icon. */
  file?: string;
  /** The hashtag, for a tag group, so the row can offer to filter by it. */
  tag?: string;
  rows: ListRow[];
}

export interface NoteList {
  groups: ListGroup[];
  /** Ids of the notes shown, each once, in list order. */
  visible: string[];
  total: number;
}

export interface ListOptions {
  groupBy: GroupBy;
  query?: Query;
  tagFilter?: string;
  /** Names of the note files switched on, in the order they are configured. */
  storeOrder?: readonly string[];
}

const TOOLTIP_LENGTH = 600;

function tooltipOf(note: ListNote, showStore: boolean): string {
  const where = showStore && note.store ? `${noteLocation(note)} · ${note.store}` : noteLocation(note);
  const body = note.body.trim();
  const shown = body.length > TOOLTIP_LENGTH ? `${body.slice(0, TOOLTIP_LENGTH).trimEnd()}…` : body;
  return shown ? `${where}\n\n${shown}` : where;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * `notes` are expected sorted by file, then line, as the store hands them over,
 * so every group comes out in reading order without sorting again.
 */
export function buildList(notes: readonly ListNote[], options: ListOptions): NoteList {
  const query = options.query ?? {};
  const searching = isActive(query);
  const compiled = compile(query);
  const order = options.storeOrder ?? [];
  // Which file a note is in only earns space when more than one is switched on.
  const showStore = order.length > 1;

  const visible: ListNote[] = [];
  for (const note of notes) {
    if (options.tagFilter && !note.tags.includes(options.tagFilter)) {
      continue;
    }
    if (searching && !test(note, compiled)) {
      continue;
    }
    visible.push(note);
  }

  const rowsOf = (group: string, members: readonly ListNote[], showFile: boolean): ListRow[] =>
    members.map((note) => ({
      id: `note:${group}:${note.id}`,
      noteId: note.id,
      title: note.title,
      description: noteDescription(note, showFile),
      tooltip: tooltipOf(note, showStore)
    }));

  const groups: ListGroup[] = [];
  if (options.groupBy === 'tag') {
    const byTag = new Map<string, ListNote[]>();
    const untagged: ListNote[] = [];
    for (const note of visible) {
      if (note.tags.length === 0) {
        untagged.push(note);
      }
      for (const tag of note.tags) {
        push(byTag, tag, note);
      }
    }
    for (const { tag, count } of tagIndex(visible)) {
      groups.push({
        id: `tag:${tag}`,
        kind: 'tag',
        label: `#${tag}`,
        description: String(count),
        tag,
        rows: rowsOf(`tag:${tag}`, byTag.get(tag) ?? [], true)
      });
    }
    if (untagged.length > 0) {
      groups.push({
        id: 'tag: untagged',
        kind: 'untagged',
        label: 'untagged',
        description: String(untagged.length),
        rows: rowsOf('tag:_untagged', untagged, true)
      });
    }
  } else if (options.groupBy === 'store') {
    const byStore = new Map<string, ListNote[]>();
    for (const note of visible) {
      push(byStore, note.store ?? '', note);
    }
    const rank = (name: string) => order.indexOf(name) + 1 || 99;
    for (const name of [...byStore.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const members = byStore.get(name) ?? [];
      groups.push({
        id: `store:${name}`,
        kind: 'store',
        label: name,
        description: String(members.length),
        rows: rowsOf(`store:${name}`, members, true)
      });
    }
  } else {
    const byFile = new Map<string, ListNote[]>();
    for (const note of visible) {
      push(byFile, note.file, note);
    }
    for (const file of [...byFile.keys()].sort()) {
      const members = byFile.get(file) ?? [];
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
      groups.push({
        id: `file:${file}`,
        kind: 'file',
        file,
        label: file.split('/').pop() ?? file,
        description: `${dir} · ${members.length}`.trim(),
        rows: rowsOf(`file:${file}`, members, false)
      });
    }
  }

  return { groups, visible: visible.map((note) => note.id), total: notes.length };
}

/** One line saying what the list is showing, above the rows. */
export function describeList(
  list: NoteList,
  options: Pick<ListOptions, 'query' | 'tagFilter' | 'storeOrder'>
): string {
  const { total } = list;
  const count = list.visible.length;
  if (total === 0) {
    return '';
  }
  const query = options.query ?? {};
  if (isActive(query)) {
    const asked = compile(query);
    const terms = [
      asked.include.join(' '),
      options.tagFilter ? `#${options.tagFilter}` : '',
      asked.exclude.length > 0 ? `excluding ${asked.exclude.join(', ')}` : ''
    ].filter(Boolean);
    return count === 0
      ? `No notes match ${terms.join(', ')}.`
      : `${count} of ${total} notes match ${terms.join(', ')}.`;
  }
  if (options.tagFilter) {
    return `#${options.tagFilter}: ${count} of ${total} notes.`;
  }
  const from = options.storeOrder ?? [];
  const notes = `${total} note${total === 1 ? '' : 's'}`;
  return from.length > 1 ? `${notes} from ${from.join(', ')}.` : `${notes} in this workspace.`;
}

/** The list flattened, for tests: each group, then its rows. */
export function flatten(list: NoteList): { id: string; label: string; group?: string }[] {
  const out: { id: string; label: string; group?: string }[] = [];
  for (const group of list.groups) {
    out.push({ id: group.id, label: group.label });
    for (const row of group.rows) {
      out.push({ id: row.id, label: row.title, group: group.label });
    }
  }
  return out;
}
