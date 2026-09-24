import * as assert from 'assert';
import {
  deriveTitle,
  newId,
  parse,
  serialize,
  serializeExport,
  sortNotes
} from '../../core/schema';
import { Note } from '../../core/types';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'aaaa1111',
    title: 'A note',
    body: 'A note',
    file: 'src/a.ts',
    line: 3,
    character: 2,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('schema', () => {
  it('keeps the note file in an export, and nowhere else', () => {
    const notes = [
      note({ id: 'aaaa1111', store: 'team' }),
      note({ id: 'bbbb2222', file: 'src/b.ts', store: 'ideas' })
    ];
    // A store file never says which file it is: it is that file.
    assert.ok(!serialize(notes).includes('team'), 'not in the notes file itself');

    const exported = serializeExport(notes);
    const doc = JSON.parse(exported);
    assert.deepStrictEqual(
      doc.notes.map((n: { id: string; store?: string }) => `${n.id}:${n.store}`),
      ['aaaa1111:team', 'bbbb2222:ideas'],
      'an export stands in for several files, so it has to say which'
    );
    assert.ok(doc.exportedAt, 'and when it was made');

    // Which is what lets an import put them back rather than pour them in.
    assert.deepStrictEqual(
      parse(exported).map((n) => `${n.id}:${n.store}`),
      ['aaaa1111:team', 'bbbb2222:ideas']
    );
    assert.strictEqual(
      parse(serialize(notes))[0].store,
      undefined,
      'a note read from a store file carries nothing of the sort'
    );
  });

  it('derives a title from the first meaningful markdown line', () => {
    assert.strictEqual(deriveTitle('## Heading\n\nbody'), 'Heading');
    assert.strictEqual(deriveTitle('\n\n- bullet item\nmore'), 'bullet item');
    assert.strictEqual(deriveTitle('   '), 'Untitled note');
    assert.strictEqual(deriveTitle('x'.repeat(200)).length, 120);
  });

  it('mints unique ids', () => {
    const taken = new Set(['abc']);
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newId(taken);
      assert.ok(!taken.has(id));
      ids.add(id);
      taken.add(id);
    }
    assert.strictEqual(ids.size, 200);
  });

  it('orders notes by file, then line, then character, then id', () => {
    const notes = [
      note({ id: 'b', file: 'src/b.ts', line: 1 }),
      note({ id: 'a3', file: 'src/a.ts', line: 9, character: 0 }),
      note({ id: 'a2', file: 'src/a.ts', line: 2, character: 40 }),
      note({ id: 'a1', file: 'src/a.ts', line: 2, character: 4 })
    ];
    assert.deepStrictEqual(
      sortNotes(notes).map((n) => n.id),
      ['a1', 'a2', 'a3', 'b']
    );
    // Sorting must not mutate the input array.
    assert.strictEqual(notes[0].id, 'b');
  });

  it('round-trips through serialize/parse', () => {
    const notes = [note({ id: 'one' }), note({ id: 'two', file: 'src/z.ts', body: 'see [[one]]' })];
    const parsed = parse(serialize(notes));
    assert.deepStrictEqual(parsed, sortNotes(notes));
  });

  it('writes a trailing newline and two-space indentation for git-friendly diffs', () => {
    const text = serialize([note()]);
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.includes('\n  "notes": ['));
  });

  it('repairs damaged entries instead of discarding the whole file', () => {
    const parsed = parse(
      JSON.stringify({
        version: 1,
        notes: [
          { file: 'src\\win.ts', line: 0, character: 0, body: '# Title\nrest' },
          { id: 'dup', file: 'a.ts', line: -5, character: -3 },
          { id: 'dup', file: 'b.ts', line: 2.7, character: 9.6 },
          { body: 'no file: a note about no line in particular' },
          null
        ]
      })
    );
    assert.strictEqual(parsed.length, 4);
    const win = parsed.find((n) => n.file === 'src/win.ts')!;
    assert.strictEqual(win.file, 'src/win.ts', 'backslashes are normalised');
    assert.strictEqual(win.title, 'Title', 'missing titles are derived');
    assert.ok(win.id.length > 0, 'missing ids are minted');
    const a = parsed.find((n) => n.file === 'a.ts')!;
    assert.strictEqual(a.line, 0, 'negative lines clamp to 0');
    assert.strictEqual(a.character, 0, 'negative columns clamp to 0');
    const b = parsed.find((n) => n.file === 'b.ts')!;
    assert.strictEqual(b.line, 2, 'fractional lines floor');
    assert.strictEqual(b.character, 9, 'fractional columns floor');
    assert.strictEqual(new Set(parsed.map((n) => n.id)).size, 4, 'duplicate ids are re-minted');
  });

  it('keeps a note that points at no line of code, and writes it back that way', () => {
    // Not damage to be repaired: a note may be about the workspace rather than
    // about a line in it.
    const loose = parse(
      JSON.stringify({ version: 1, notes: [{ id: 'loose001', body: 'Just a note' }] })
    );
    assert.strictEqual(loose.length, 1);
    assert.deepStrictEqual(
      [loose[0].file, loose[0].line, loose[0].character],
      [undefined, undefined, undefined],
      'no location at all, rather than an empty path at line 0'
    );

    const written = JSON.parse(serialize(loose)) as { notes: Record<string, unknown>[] };
    assert.ok(!('file' in written.notes[0]), 'and nothing is written for it');
    assert.ok(!('line' in written.notes[0]));
    assert.deepStrictEqual(parse(serialize(loose))[0], loose[0], 'it round-trips');
  });

  it('takes half a location for none: all three of file, line and character', () => {
    // There is no flag for "no location". A note has one when it carries all
    // three, so a half-written one is a note about the workspace, not a note
    // pinned to column 0 of a line nobody chose.
    const parsed = parse(
      JSON.stringify({
        version: 1,
        notes: [
          { id: 'nofile001', line: 4, character: 2, body: 'no file' },
          { id: 'noline001', file: 'src/a.ts', character: 2, body: 'no line' },
          { id: 'nochar001', file: 'src/a.ts', line: 4, body: 'no character' },
          { id: 'whole0001', file: 'src/a.ts', line: 4, character: 2, body: 'all three' },
          { id: 'broken001', file: 'src/a.ts', line: 'x', character: null, body: 'nonsense' }
        ]
      })
    );
    const by = new Map(parsed.map((n) => [n.id, n]));
    for (const id of ['nofile001', 'noline001', 'nochar001']) {
      assert.deepStrictEqual(
        [by.get(id)!.file, by.get(id)!.line, by.get(id)!.character],
        [undefined, undefined, undefined],
        `${id} points nowhere, and keeps no half of a location`
      );
    }
    assert.deepStrictEqual(
      [by.get('whole0001')!.file, by.get('whole0001')!.line, by.get('whole0001')!.character],
      ['src/a.ts', 4, 2]
    );
    // A value that is there but nonsense is still repaired: only a missing
    // one means the note is about no line at all.
    assert.strictEqual(by.get('broken001')!.file, undefined, 'a null column is a missing one');
    const half = parse(
      JSON.stringify({ version: 1, notes: [{ id: 'half0001', file: 'a.ts', line: 'x', character: -3 }] })
    );
    assert.deepStrictEqual([half[0].file, half[0].line, half[0].character], ['a.ts', 0, 0]);
  });

  it('puts notes with no location after the ones that have one', () => {
    const notes = [
      note({ id: 'loose002', title: 'Zebra', file: undefined, line: undefined, character: undefined }),
      note({ id: 'anchor01', title: 'Anchored', file: 'src/b.ts', line: 3 }),
      note({ id: 'loose001', title: 'Apple', file: undefined, line: undefined, character: undefined }),
      note({ id: 'anchor02', title: 'Also anchored', file: 'src/a.ts', line: 9 })
    ];
    assert.deepStrictEqual(
      sortNotes(notes).map((n) => n.id),
      ['anchor02', 'anchor01', 'loose001', 'loose002'],
      'files first in path order, then the loose ones by title'
    );
  });

  it('derives tags from the body so the file cannot drift out of sync', () => {
    const parsed = parse(
      JSON.stringify({
        version: 1,
        notes: [{ id: 'x', file: 'a.ts', body: 'slow path #perf #bug', tags: ['stale'] }]
      })
    );
    assert.deepStrictEqual(parsed[0].tags, ['perf', 'bug']);
  });

  it('accepts a bare array and an empty file', () => {
    assert.deepStrictEqual(parse(''), []);
    assert.strictEqual(parse(JSON.stringify([note()])).length, 1);
  });
});
