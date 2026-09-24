import * as assert from 'assert';
import { ListNote, buildList, describeList, flatten } from '../../core/noteList';

const note = (over: Partial<ListNote> & { id: string }): ListNote => ({
  title: over.id,
  body: `${over.title ?? over.id}\n\nbody`,
  file: 'src/a.ts',
  line: 0,
  character: 0,
  tags: [],
  ...over
});

// As the store hands them over: by file, then line.
const notes = [
  note({ id: 'a1', title: 'Cache race', file: 'src/a.ts', line: 1, tags: ['bug'], store: 'team' }),
  note({ id: 'a2', title: 'Eviction', file: 'src/a.ts', line: 9, tags: ['bug', 'perf'], store: 'mine' }),
  note({ id: 'b1', title: 'Header parsing', file: 'src/deep/b.ts', line: 3, store: 'team' })
];

describe('the notes list', () => {
  it('groups by file, in path order, each file in reading order', () => {
    const list = buildList(notes, { groupBy: 'file' });
    assert.deepStrictEqual(flatten(list), [
      { id: 'file:src/a.ts', label: 'a.ts' },
      { id: 'note:file:src/a.ts:a1', label: 'Cache race', group: 'a.ts' },
      { id: 'note:file:src/a.ts:a2', label: 'Eviction', group: 'a.ts' },
      { id: 'file:src/deep/b.ts', label: 'b.ts' },
      { id: 'note:file:src/deep/b.ts:b1', label: 'Header parsing', group: 'b.ts' }
    ]);
    assert.strictEqual(list.groups[1].description, 'src/deep · 1', 'folder and count beside the name');
    assert.strictEqual(list.groups[0].rows[0].description, undefined, 'the group already names the file');
  });

  it('gathers notes that point at no line of code into a group of their own', () => {
    const loose = { ...note({ id: 'loose1', title: 'Just a thought' }) } as ListNote;
    delete loose.file;
    delete loose.line;
    delete loose.character;
    const list = buildList([...notes, loose], { groupBy: 'file' });

    assert.deepStrictEqual(
      list.groups.map((group) => `${group.kind}:${group.label}`),
      ['file:a.ts', 'file:b.ts', 'unlocated:no location'],
      'after the files, since it belongs to no file'
    );
    const row = list.groups[2].rows[0];
    assert.strictEqual(row.noteId, 'loose1');
    assert.strictEqual(row.description, undefined, 'and there is no line to point at');
    assert.match(row.tooltip, /Not attached to any line of code/);

    // Everywhere else it is a note like any other.
    assert.ok(list.visible.includes('loose1'));
    assert.deepStrictEqual(
      buildList([...notes, loose], { groupBy: 'tag' }).groups.map((g) => g.label),
      ['#bug', '#perf', 'untagged'],
      'grouped by hashtag it sits with the untagged notes'
    );
    assert.deepStrictEqual(
      buildList([...notes, loose], { groupBy: 'file', query: { query: 'thought' } }).visible,
      ['loose1'],
      'and it is searched like any other'
    );
  });

  it('groups by hashtag, giving a note under two hashtags two rows with ids of their own', () => {
    const list = buildList(notes, { groupBy: 'tag' });
    assert.deepStrictEqual(
      list.groups.map((g) => [g.label, g.rows.map((r) => r.noteId)]),
      [
        ['#bug', ['a1', 'a2']],
        ['#perf', ['a2']],
        ['untagged', ['b1']]
      ]
    );
    const ids = flatten(list).map((row) => row.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.deepStrictEqual(list.visible, ['a1', 'a2', 'b1'], 'but each note is counted once');
    assert.strictEqual(list.groups[0].tag, 'bug', 'a tag group can offer to filter by its tag');
    assert.strictEqual(list.groups[0].rows[1].description, 'src/a.ts:10', 'and rows say where they are');
  });

  it('groups by note file, in the order the files are configured', () => {
    const list = buildList(notes, { groupBy: 'store', storeOrder: ['team', 'mine'] });
    assert.deepStrictEqual(
      list.groups.map((g) => [g.label, g.description]),
      [
        ['team', '2'],
        ['mine', '1']
      ]
    );
    assert.match(list.groups[1].rows[0].tooltip, /· mine/, 'with two files on, the hover says which');
    assert.doesNotMatch(
      buildList(notes, { groupBy: 'store', storeOrder: ['team'] }).groups[0].rows[0].tooltip,
      /· team/,
      'with one there is nothing to tell apart'
    );
  });

  it('says which note file a row is in, when that is not already obvious', () => {
    const rowsOf = (options: Parameters<typeof buildList>[1]) =>
      buildList(notes, options).groups.flatMap((group) => group.rows.map((row) => row.store));

    assert.deepStrictEqual(
      rowsOf({ groupBy: 'file', storeOrder: ['team', 'mine'] }),
      ['team', 'mine', 'team'],
      'grouped by file, each row carries its note file'
    );
    assert.deepStrictEqual(
      rowsOf({ groupBy: 'tag', storeOrder: ['team', 'mine'] }),
      ['team', 'mine', 'mine', 'team'],
      'and grouped by hashtag, where the notes come from everywhere'
    );
    assert.deepStrictEqual(
      rowsOf({ groupBy: 'store', storeOrder: ['team', 'mine'] }),
      [undefined, undefined, undefined],
      'grouped by note file, the group says it already'
    );
    assert.deepStrictEqual(
      rowsOf({ groupBy: 'file', storeOrder: ['team'] }),
      [undefined, undefined, undefined],
      'with one file on there is nothing to tell apart'
    );
  });

  it('narrows to a search and a hashtag filter, dropping groups left empty', () => {
    const searched = buildList(notes, { groupBy: 'file', query: { query: 'src -eviction' } });
    assert.deepStrictEqual(searched.visible, ['a1', 'b1']);

    const filtered = buildList(notes, { groupBy: 'file', tagFilter: 'perf' });
    assert.deepStrictEqual(
      filtered.groups.map((g) => g.id),
      ['file:src/a.ts']
    );
    assert.deepStrictEqual(filtered.visible, ['a2']);
    assert.strictEqual(filtered.total, 3);
  });

  it('keeps a long note out of the hover', () => {
    const long = note({ id: 'long', body: 'x'.repeat(5000) });
    const tooltip = buildList([long], { groupBy: 'file' }).groups[0].rows[0].tooltip;
    assert.ok(tooltip.length < 800, `${tooltip.length} characters`);
    assert.ok(tooltip.endsWith('…'));
  });

  it('says what the list is showing', () => {
    const say = (options: Parameters<typeof describeList>[1]) =>
      describeList(buildList(notes, { groupBy: 'file', ...options }), options);
    assert.strictEqual(say({}), '3 notes in this workspace.');
    assert.strictEqual(say({ storeOrder: ['team', 'mine'] }), '3 notes from team, mine.');
    assert.strictEqual(say({ tagFilter: 'bug' }), '#bug: 2 of 3 notes.');
    assert.strictEqual(
      say({ query: { query: 'cache', exclude: 'test' } }),
      '1 of 3 notes match cache, excluding test.'
    );
    assert.strictEqual(say({ query: { query: 'elephant' } }), 'No notes match elephant.');
    assert.strictEqual(describeList(buildList([], { groupBy: 'file' }), {}), '');
  });
});
