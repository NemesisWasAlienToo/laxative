import * as assert from 'assert';
import { backlinks, buildGraph, expandRefs, parseRefs, refIds } from '../../core/refs';
import { Note } from '../../core/types';

function note(id: string, body: string, file = 'src/a.ts'): Note {
  return {
    id,
    title: body.split('\n')[0],
    body,
    file,
    line: 0,
    character: 0,
    tags: [],
    createdAt: '',
    updatedAt: ''
  };
}

describe('refs', () => {
  it('parses plain and labelled references', () => {
    const refs = parseRefs('see [[abc]] and [[def|the other one]] done');
    assert.deepStrictEqual(
      refs.map((r) => [r.id, r.label]),
      [
        ['abc', undefined],
        ['def', 'the other one']
      ]
    );
    assert.strictEqual('see [[abc]] and [[def|the other one]] done'.slice(refs[0].start, refs[0].end), '[[abc]]');
  });

  it('ignores malformed tokens', () => {
    assert.deepStrictEqual(parseRefs('[[]] [[ ]] [single] [[a b]] text'), []);
  });

  it('deduplicates reference ids in order', () => {
    assert.deepStrictEqual(refIds('[[b]] [[a]] [[b]]'), ['b', 'a']);
  });

  it('expands references into markdown links', () => {
    const notes = [note('t1', 'Target one')];
    const out = expandRefs('before [[t1]] after', (id) => {
      const target = notes.find((n) => n.id === id);
      return target ? { href: `laxative:${target.id}`, label: target.title } : undefined;
    });
    assert.strictEqual(out, 'before [Target one](laxative:t1) after');
  });

  it('keeps a custom label and marks missing targets', () => {
    const resolve = (id: string) =>
      id === 'known' ? { href: 'laxative:known', label: 'Known' } : undefined;
    assert.strictEqual(expandRefs('[[known|My label]]', resolve), '[My label](laxative:known)');
    assert.strictEqual(expandRefs('[[gone]]', resolve), '`[[gone]]` _(missing note)_');
  });

  it('leaves bodies without references untouched', () => {
    assert.strictEqual(expandRefs('plain **markdown**', () => undefined), 'plain **markdown**');
  });

  it('builds a graph, separating broken links and dropping self-links', () => {
    const notes = [
      note('a', 'links to [[b]] and [[b]] again and [[ghost]]'),
      note('b', 'links to [[a]] and [[b]]', 'src/b.ts')
    ];
    const graph = buildGraph(notes);
    assert.deepStrictEqual(graph.edges, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }
    ]);
    assert.deepStrictEqual(graph.broken, [{ from: 'a', to: 'ghost' }]);
    assert.strictEqual(graph.nodes.length, 2);
  });

  it('finds backlinks', () => {
    const notes = [note('a', 'see [[c]]'), note('b', 'see [[c]]'), note('c', 'see [[c]]')];
    assert.deepStrictEqual(
      backlinks(notes, 'c').map((n) => n.id),
      ['a', 'b']
    );
  });
});
