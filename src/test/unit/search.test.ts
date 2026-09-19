import * as assert from 'assert';
import { compile, haystack, isActive, matches, searchNotes, terms } from '../../core/search';

const note = (over: Partial<Parameters<typeof haystack>[0]> = {}) => ({
  title: 'Race with the cache warmer',
  body: 'Race with the cache warmer\n\nTwo writers interleave. #bug #perf/hot-path',
  file: 'src/cache.ts',
  tags: ['bug', 'perf/hot-path'],
  ...over
});

describe('search', () => {
  it('splits a box into terms, however they are separated', () => {
    assert.deepStrictEqual(terms('  cache   Warmer '), ['cache', 'warmer']);
    assert.deepStrictEqual(terms('a, b,,c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(terms(''), []);
    assert.deepStrictEqual(terms(undefined), []);
  });

  it('looks at the title, body, path and hashtags', () => {
    const text = haystack(note());
    for (const part of ['race with the cache', 'interleave', 'src/cache.ts', '#perf/hot-path']) {
      assert.ok(text.includes(part), `${part} is searchable`);
    }
  });

  it('needs every search term to match, anywhere in the note', () => {
    assert.ok(matches(note(), { query: 'cache warmer' }));
    assert.ok(matches(note(), { query: 'WARMER Cache' }), 'case and order do not matter');
    assert.ok(matches(note(), { query: 'cach' }), 'substrings match');
    assert.ok(!matches(note(), { query: 'cache elephant' }), 'one missing term is enough to miss');
    assert.ok(matches(note(), {}), 'an empty search matches everything');
  });

  it('drops a note matching any exclude term, whatever the search says', () => {
    assert.ok(!matches(note(), { query: 'cache', exclude: 'warmer' }));
    assert.ok(!matches(note(), { exclude: 'nothing bug' }), 'any one term is enough');
    assert.ok(!matches(note(), { query: 'cache', exclude: 'src/cache.ts' }), 'paths too');
    assert.ok(!matches(note(), { exclude: '#bug' }), 'and hashtags');
    assert.ok(matches(note(), { query: 'cache', exclude: 'elephant' }), 'an unrelated exclude keeps it');
  });

  it('treats a leading minus in the search as an exclude, so one box can do both', () => {
    assert.deepStrictEqual(compile({ query: 'cache -test -#wip' }), {
      include: ['cache'],
      exclude: ['test', '#wip']
    });
    assert.ok(matches(note(), { query: 'cache -elephant' }));
    assert.ok(!matches(note(), { query: 'cache -warmer' }), 'the minus term takes it out');
    assert.ok(!matches(note(), { query: '-#bug' }), 'on its own, and against a hashtag');
    assert.ok(matches(note(), { query: 'hot-path' }), 'a minus inside a term is just a character');
    assert.deepStrictEqual(
      compile({ query: 'cache -', exclude: 'old' }),
      { include: ['cache'], exclude: ['old'] },
      'a lone minus is someone part-way through typing, and the exclude box still counts'
    );
  });

  it('knows when a query would narrow nothing down', () => {
    assert.ok(!isActive({}));
    assert.ok(!isActive({ query: '  ', exclude: ' , ' }));
    assert.ok(!isActive({ query: '-' }));
    assert.ok(isActive({ query: 'a' }));
    assert.ok(isActive({ exclude: 'a' }));
    assert.ok(isActive({ query: '-a' }));
  });

  it('filters a list, keeping its order', () => {
    const notes = [
      note({ title: 'One', file: 'src/a.ts', tags: [], body: 'about parsing' }),
      note({ title: 'Two', file: 'src/b.ts', tags: ['wip'], body: 'about parsing, later' }),
      note({ title: 'Three', file: 'test/b.test.ts', tags: [], body: 'about parsing tests' })
    ];
    assert.deepStrictEqual(
      searchNotes(notes, { query: 'parsing' }).map((n) => n.title),
      ['One', 'Two', 'Three']
    );
    assert.deepStrictEqual(
      searchNotes(notes, { query: 'parsing', exclude: 'test #wip' }).map((n) => n.title),
      ['One'],
      'excludes take out the test file and anything tagged wip'
    );
  });
});
