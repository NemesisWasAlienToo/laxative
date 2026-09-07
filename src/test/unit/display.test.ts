import * as assert from 'assert';
import { noteDescription, noteLocation } from '../../core/display';

const note = { file: 'src/worker.ts', line: 10, character: 18 };

describe('display', () => {
  it('says nothing beside a note listed under its own file', () => {
    // The file row is right above it; ":11" on its own was just a puzzle.
    assert.strictEqual(noteDescription(note, false), undefined);
  });

  it('gives the full path:line when notes are grouped by hashtag', () => {
    assert.strictEqual(noteDescription(note, true), 'src/worker.ts:11');
  });

  it('spells the location out for the hover card', () => {
    assert.strictEqual(noteLocation(note), 'src/worker.ts, line 11, column 19');
  });

  it('counts lines and columns from one, the way the editor shows them', () => {
    assert.strictEqual(noteLocation({ file: 'a.ts', line: 0, character: 0 }), 'a.ts, line 1, column 1');
  });
});
