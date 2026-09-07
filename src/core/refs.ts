import { Note } from './types';

export interface Ref {
  /** Target note id. */
  id: string;
  /** Display label: the `label` in `[[id|label]]`, otherwise undefined. */
  label?: string;
  /** Character offsets of the whole `[[...]]` token in the body. */
  start: number;
  end: number;
}

const REF_PATTERN = /\[\[\s*([A-Za-z0-9_-]+)\s*(?:\|([^\]]*))?\]\]/g;

export function parseRefs(body: string): Ref[] {
  const refs: Ref[] = [];
  REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_PATTERN.exec(body)) !== null) {
    refs.push({
      id: match[1],
      label: match[2]?.trim() || undefined,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return refs;
}

/** Unique target ids referenced by a note, in order of first appearance. */
export function refIds(body: string): string[] {
  const seen = new Set<string>();
  for (const ref of parseRefs(body)) {
    seen.add(ref.id);
  }
  return [...seen];
}

export interface Resolved {
  /** Markdown link target, or undefined to render the ref as broken. */
  href: string;
  label: string;
}

/**
 * Rewrites `[[id]]` tokens into ordinary markdown links so the body can be fed
 * to any markdown renderer. Unresolvable ids are rendered as `[[id]] (missing)`.
 */
export function expandRefs(body: string, resolve: (id: string) => Resolved | undefined): string {
  const refs = parseRefs(body);
  if (refs.length === 0) {
    return body;
  }
  let out = '';
  let cursor = 0;
  for (const ref of refs) {
    out += body.slice(cursor, ref.start);
    const target = resolve(ref.id);
    if (target) {
      const label = (ref.label ?? target.label).replace(/([[\]])/g, '\\$1');
      out += `[${label}](${target.href})`;
    } else {
      out += `\`[[${ref.id}]]\` _(missing note)_`;
    }
    cursor = ref.end;
  }
  return out + body.slice(cursor);
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: Note[];
  edges: GraphEdge[];
  /** References whose target does not exist, keyed by source note id. */
  broken: { from: string; to: string }[];
}

export function buildGraph(notes: readonly Note[]): Graph {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  const broken: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    for (const id of refIds(note.body)) {
      if (id === note.id) {
        continue;
      }
      const key = `${note.id}->${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      (byId.has(id) ? edges : broken).push({ from: note.id, to: id });
    }
  }
  return { nodes: [...notes], edges, broken };
}

/** Notes whose body references `id`. */
export function backlinks(notes: readonly Note[], id: string): Note[] {
  return notes.filter((n) => n.id !== id && refIds(n.body).includes(id));
}
