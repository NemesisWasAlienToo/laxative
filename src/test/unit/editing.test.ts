import * as assert from 'assert';
import { refPrefix, slugForTitle, tagPrefix } from '../../core/editing';

describe('editing', () => {
  describe('slugForTitle', () => {
    it('keeps a readable title for the editor tab', () => {
      assert.strictEqual(slugForTitle('Race with the cache warmer'), 'Race with the cache warmer');
    });

    it('strips filename-unsafe characters and collapses the gaps they leave', () => {
      assert.strictEqual(slugForTitle('fix: cache/warmer <race?>'), 'fix cache warmer race');
    });

    it('falls back for empty or symbol-only titles', () => {
      assert.strictEqual(slugForTitle(''), 'Untitled note');
      assert.strictEqual(slugForTitle('###'), 'Untitled note');
    });

    it('truncates very long titles', () => {
      assert.ok(slugForTitle('x'.repeat(200)).length <= 60);
    });
  });

  describe('refPrefix', () => {
    it('detects an open [[ and captures what follows', () => {
      assert.deepStrictEqual(refPrefix('see [[cache'), { query: 'cache', start: 4 });
      assert.deepStrictEqual(refPrefix('[['), { query: '', start: 0 });
    });

    it('ignores a completed or absent reference', () => {
      assert.strictEqual(refPrefix('see [[abc]] done'), undefined);
      assert.strictEqual(refPrefix('nothing here'), undefined);
      assert.strictEqual(refPrefix('a [single] bracket'), undefined);
    });

    it('uses the last open reference on the line', () => {
      assert.deepStrictEqual(refPrefix('[[one]] and [[tw'), { query: 'tw', start: 12 });
    });
  });

  describe('tagPrefix', () => {
    it('detects a hashtag being typed', () => {
      assert.deepStrictEqual(tagPrefix('slow path #per'), { query: 'per', start: 10 });
      assert.deepStrictEqual(tagPrefix('#'), { query: '', start: 0 });
    });

    it('does not fire where a hashtag would not be one', () => {
      assert.strictEqual(tagPrefix('## heading'), undefined);
      assert.strictEqual(tagPrefix('url.dev/x#fra'), undefined);
      assert.strictEqual(tagPrefix('[jump](#sec'), undefined);
      assert.strictEqual(tagPrefix('&#16'), undefined);
      assert.strictEqual(tagPrefix('no hash at all'), undefined);
    });

    it('reports a range that covers the # itself', () => {
      const line = 'text #bug';
      const prefix = tagPrefix(line);
      assert.ok(prefix);
      assert.strictEqual(line.slice(prefix.start), '#bug');
    });
  });
});
