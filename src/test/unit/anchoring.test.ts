import * as assert from 'assert';
import { Anchor, CodeIndex, normalize, snippetAt } from '../../core/anchoring';
import { parse, serialize } from '../../core/schema';
import { noteAnchor, noteDescription } from '../../core/display';
import { Note } from '../../core/types';

const code = [
  'export function alpha() {',
  '  const value = compute();',
  '  return value;',
  '}',
  '',
  'export function beta() {',
  '  return 42;',
  '}'
];

/** A note made on `line` of `code`, the way the editor makes one. */
function anchorAt(line: number, character = 2) {
  return { line, character, snippet: snippetAt(code, line) };
}

const find = (lines: string[], anchor: Anchor) =>
  new CodeIndex(lines.join('\n')).find(anchor);

describe('anchoring', () => {
  it('keeps a note where it is when nothing moved', () => {
    assert.strictEqual(find(code, anchorAt(1))?.line, 1);
  });

  it('follows its line when lines are added or removed above it', () => {
    const added = ['// header', '// more', ...code];
    assert.strictEqual(find(added, anchorAt(6))?.line, 8);
    const removed = code.slice(4);
    assert.strictEqual(find(removed, anchorAt(6))?.line, 2);
  });

  it('ignores indentation and spacing', () => {
    const reformatted = code.map((line) => '    ' + line.replace(/ = /, '   =   '));
    assert.strictEqual(find(reformatted, anchorAt(1))?.line, 1);
  });

  it('tells repeated lines apart by the lines around them', () => {
    // Both functions end in `}`; the second one is the note's.
    const moved = ['// header', ...code];
    assert.strictEqual(find(moved, anchorAt(7))?.line, 8, 'the `}` after return 42');
    assert.strictEqual(find(moved, anchorAt(3))?.line, 4, 'the `}` after return value');
  });

  it('picks the copy nearest where it was when a line is duplicated', () => {
    const copied = [...code.slice(0, 2), code[1], ...code.slice(2)];
    assert.strictEqual(find(copied, anchorAt(1))?.line, 1);
  });

  it('moves a note on a repeated line the way the notes around it moved', () => {
    // Twenty identical functions: every `}` after `return result;` looks the
    // same, and the code moves further than one function is long.
    const fn = (i: number) => [`function f${i}() {`, `  work(${i});`, '  return result;', '}', ''];
    const file = Array.from({ length: 20 }, (_, i) => fn(i)).flat();
    const anchors = [
      { line: 41, character: 0, snippet: snippetAt(file, 41) }, // work(8): unique
      { line: 43, character: 0, snippet: snippetAt(file, 43) } // its `}`: one of twenty
    ];
    const moved = [...Array.from({ length: 12 }, (_, i) => `// new ${i}`), ...file];
    const placed = new CodeIndex(moved.join('\n')).findAll(anchors);
    assert.deepStrictEqual(
      placed.map((p) => p?.line),
      [53, 55],
      'both moved down 12, not to the nearest `}`'
    );
    // And checking again moves nothing.
    const again = new CodeIndex(moved.join('\n')).findAll(
      placed.map((p) => ({ line: p!.line, character: 0, snippet: p!.snippet }))
    );
    assert.deepStrictEqual(again.map((p) => p?.line), [53, 55]);
  });

  it('finds a line that was edited by the lines either side of it', () => {
    const edited = ['// header', ...code];
    edited[2] = '  const value = computeFaster();';
    const placed = find(edited, anchorAt(1));
    assert.strictEqual(placed?.line, 2);
    assert.strictEqual(placed?.snippet.line, 'const value = computeFaster();', 'and keeps the new text');
  });

  it('says the code is gone when it is', () => {
    const gone = code.filter((_, i) => i < 5);
    assert.strictEqual(find(gone, anchorAt(6)), undefined);
  });

  it('does not put a note on a blank line by the text alone', () => {
    const blank = { line: 4, character: 0, snippet: { above: 'x', line: '', below: 'y' } };
    assert.strictEqual(find(code, blank), undefined);
  });

  it('takes a snippet from the line a note without one says it is on', () => {
    const placed = find(code, { line: 1, character: 4 });
    assert.deepStrictEqual(placed?.snippet, snippetAt(code, 1));
  });

  it('keeps the column as it was, so a check alone never rewrites the note', () => {
    const placed = new CodeIndex(code.join('\n')).find({ ...anchorAt(4), character: 8 });
    assert.strictEqual(placed?.character, 8, 'past the end of a blank line, and left alone');
  });

  it('keeps snippets short', () => {
    assert.strictEqual(normalize('x'.repeat(1000)).length, 160);
  });

  it('writes the snippet to disk and reads it back', () => {
    const now = new Date().toISOString();
    const note: Note = {
      id: 'a1',
      title: 't',
      body: 't',
      file: 'src/a.ts',
      line: 1,
      character: 0,
      snippet: snippetAt(code, 1),
      lost: true,
      tags: [],
      createdAt: now,
      updatedAt: now
    };
    const text = serialize([note]);
    assert.ok(!text.includes('"lost"'), 'whether the code is there is worked out, not stored');
    assert.deepStrictEqual(parse(text)[0].snippet, note.snippet);
  });

  it('says "code not found" instead of a line number for a lost note', () => {
    const lost = { file: 'src/a.ts', line: 4, character: 0, lost: true };
    assert.strictEqual(noteAnchor(lost), 'src/a.ts · code not found');
    assert.strictEqual(noteDescription(lost, false), 'code not found');
  });

  it('finds 1000 notes in a 10,000-line file quickly', () => {
    // Realistic code: lots of repeated `}`, blank lines and near-duplicates.
    const big: string[] = [];
    for (let i = 0; i < 10000; i++) {
      big.push(i % 7 === 0 ? '}' : i % 11 === 0 ? '' : `  const v${i % 900} = call(${i});`);
    }
    const anchors = Array.from({ length: 1000 }, (_, i) => {
      const line = i * 10 + 3;
      return { line, character: 0, snippet: snippetAt(big, line) };
    });
    const shifted = [...Array.from({ length: 50 }, (_, i) => `// added ${i}`), ...big];
    const started = performance.now();
    const index = new CodeIndex(shifted.join('\n'));
    const placed = index.findAll(anchors);
    const ms = performance.now() - started;
    console.log(`      1000 notes, 10k lines, every note moved: ${ms.toFixed(1)} ms`);
    placed.forEach((p, i) => assert.strictEqual(p?.line, anchors[i].line + 50));
    assert.ok(ms < 500, `took ${ms} ms`);
  });
});

describe('note files from before snippets', () => {
  // Exactly what 0.8.0 wrote: a location, and no snippet.
  const old = JSON.stringify(
    {
      version: 1,
      notes: [
        {
          id: 'k3f9a2mx',
          title: 'Race with the cache warmer',
          body: 'Race with the cache warmer\n\n#bug',
          file: 'src/app.ts',
          line: 1,
          character: 2,
          tags: ['bug'],
          createdAt: '2026-09-01T09:00:00.000Z',
          updatedAt: '2026-09-01T09:00:00.000Z'
        },
        {
          id: 'loose001',
          title: 'Not about a line',
          body: 'Not about a line',
          tags: [],
          createdAt: '2026-09-01T09:00:00.000Z',
          updatedAt: '2026-09-01T09:00:00.000Z'
        }
      ]
    },
    null,
    2
  );

  it('load as they are', () => {
    const notes = parse(old);
    assert.strictEqual(notes.length, 2);
    const located = notes.find((n) => n.id === 'k3f9a2mx')!;
    assert.deepStrictEqual([located.file, located.line, located.character], ['src/app.ts', 1, 2]);
    assert.strictEqual(located.snippet, undefined);
    assert.strictEqual(notes.find((n) => n.id === 'loose001')!.file, undefined);
  });

  it('are written back unchanged when nothing about them changed', () => {
    // No snippet appears out of nowhere: a teammate on 0.8.0 sees no diff.
    assert.strictEqual(serialize(parse(old)), serialize(parse(serialize(parse(old)))));
    assert.ok(!serialize(parse(old)).includes('snippet'));
  });

  it('find their line, and take a snippet from it, the first time they are checked', () => {
    const note = parse(old)[0];
    const placed = new CodeIndex(code.join('\n')).find(note as Anchor);
    assert.strictEqual(placed?.line, 1, 'stays on the line it says');
    assert.deepStrictEqual(placed?.snippet, snippetAt(code, 1), 'and now knows its code');
  });
});
