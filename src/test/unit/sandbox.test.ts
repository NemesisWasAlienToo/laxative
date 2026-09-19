import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from '../../core/schema';
import { parseTags } from '../../core/tags';
import { buildGraph } from '../../core/refs';

/**
 * `docker/try-it.sh` writes a sample project and seeds it with notes, so the
 * sandbox has something to look at the moment it opens. Those notes are hand
 * written JSON inside a shell script, and they point at line numbers in sample
 * files written a few lines further up — both of which rot silently. This
 * checks them with the extension's own parser instead of by opening a browser.
 */
describe('the try-it sandbox seed', () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, '../../../docker/try-it.sh'),
    'utf8'
  );

  /** The heredocs the script writes into the sample project, by path. */
  const files = new Map<string, string>();
  const heredoc = /cat > "\$SANDBOX\/project\/([^"]+)" <<'SAMPLE'\n([\s\S]*?)\nSAMPLE\n/g;
  for (let m = heredoc.exec(script); m; m = heredoc.exec(script)) {
    files.set(m[1], m[2]);
  }

  /** Every seeded notes file, by the path try-it.sh writes it to. */
  const seededFiles = [...files.keys()].filter((path) => path.startsWith('.laxative/'));
  const seeded = files.get('.laxative/notes.json');
  const notes = seededFiles.flatMap((path) => parse(files.get(path) as string));

  it('writes a notes file the store can read', () => {
    assert.ok(seeded, 'try-it.sh seeds .laxative/notes.json');
    assert.deepStrictEqual(
      seededFiles.sort(),
      ['.laxative/ideas.json', '.laxative/notes.json'],
      'two files, so having several can be tried out'
    );
    assert.strictEqual(notes.length, 8, 'all eight notes survive parsing');
    const seededIds = seededFiles.flatMap((path) =>
      JSON.parse(files.get(path) as string).notes.map((n: { id: string }) => n.id)
    );
    assert.deepStrictEqual(
      seededIds.sort(),
      notes.map((n) => n.id).sort(),
      'no note is dropped or re-issued an id, so [[refs]] keep pointing somewhere'
    );
  });

  it('anchors every note to the line of code it talks about', () => {
    // Editing a sample file without moving the notes would leave the sandbox
    // pointing at the wrong lines, which is exactly the thing being checked by
    // eye when you open it.
    const anchoredTo: Record<string, string> = {
      d8m2rk44: 'export async function prime',
      i9k2p001: 'export async function prime',
      i9k2p002: 'while (attempt < 3)',
      zz10lost: 'export function read',
      k3f9a2mx: 'set(key: string',
      t7q4zz10: 'evictAll()',
      p1x8dd02: 'while (attempt < 3)',
      w0b5neq7: 'async function load'
    };
    assert.deepStrictEqual(
      notes.map((n) => n.id).sort(),
      Object.keys(anchoredTo).sort(),
      'every seeded note is accounted for here'
    );
    for (const note of notes) {
      const source = files.get(note.file);
      assert.ok(source, `${note.file} is one of the seeded files`);
      const lines = (source as string).split('\n');
      assert.ok(
        note.line < lines.length,
        `${note.id} points at ${note.file}:${note.line + 1}, which has ${lines.length} lines`
      );
      assert.ok(
        lines[note.line].includes(anchoredTo[note.id]),
        `${note.id} should sit on "${anchoredTo[note.id]}", found "${lines[note.line].trim()}"`
      );
      assert.ok(
        note.character <= lines[note.line].length,
        `${note.id} points inside its line, not past the end of it`
      );
    }
  });

  it('keeps the written tags in step with the note bodies', () => {
    // The file carries a `tags` array for readability; the store always
    // re-derives it, so a stale one here would quietly mislead whoever edits it.
    for (const path of seededFiles) {
      for (const note of JSON.parse(files.get(path) as string).notes) {
        assert.deepStrictEqual(note.tags, parseTags(note.body), `${note.id} tags in ${path}`);
      }
    }
  });

  it('shows off the visuals it is there to show off', () => {
    const graph = buildGraph(notes);
    assert.ok(new Set(notes.map((n) => n.file)).size >= 3, 'several files, so several node colours');
    assert.ok(notes.some((n) => n.tags.length === 0), 'one note is untagged, for the untagged group');
    assert.ok(notes.some((n) => n.tags.some((t) => t.includes('/'))), 'a nested tag');
    assert.ok(notes.some((n) => n.body.includes('```')), 'a note with a code fence to render');

    const degree = (id: string) =>
      graph.edges.filter((e) => e.from === id || e.to === id).length;
    const hub = notes.map((n) => n.id).sort((a, b) => degree(b) - degree(a))[0];
    assert.ok(degree(hub) >= 3, 'one note is a visible hub in the graph');

    assert.deepStrictEqual(
      graph.broken.map((e) => e.to),
      ['nosuchnote'],
      'exactly one dangling reference, the deliberate one'
    );
    assert.ok(
      graph.edges.some((e) => e.from === 'i9k2p002' && e.to === 'p1x8dd02'),
      'a note in one file can reference a note in the other'
    );
  });
});
