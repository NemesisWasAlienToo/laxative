import * as assert from 'assert';
import { parseTags, tagIndex } from '../../core/tags';

describe('tags', () => {
  it('collects hashtags in order, lower-cased and de-duplicated', () => {
    assert.deepStrictEqual(
      parseTags('Fix the #Cache warmer #race, see #cache again'),
      ['cache', 'race']
    );
  });

  it('supports nested tags and dashes', () => {
    assert.deepStrictEqual(parseTags('#perf/hot-path #tech-debt'), ['perf/hot-path', 'tech-debt']);
  });

  describe('does not collide with markdown', () => {
    it('ignores ATX headings', () => {
      assert.deepStrictEqual(parseTags('# Title\n\n### Deeper heading\n\ntext'), []);
    });

    it('ignores fenced code blocks', () => {
      assert.deepStrictEqual(parseTags('```sh\n# not a tag\necho "#nope"\n```\n#yes'), ['yes']);
    });

    it('ignores unterminated fences', () => {
      assert.deepStrictEqual(parseTags('#before\n```\n#inside'), ['before']);
    });

    it('ignores inline code', () => {
      assert.deepStrictEqual(parseTags('use `#define` here, but #real counts'), ['real']);
    });

    it('keeps tags in indented list items, which are not code blocks in a note', () => {
      assert.deepStrictEqual(parseTags('- outer\n    - nested #deep'), ['deep']);
    });

    it('ignores heading anchors and url fragments', () => {
      assert.deepStrictEqual(parseTags('[jump](#section) and https://x.dev/a#frag'), []);
    });

    it('ignores html entities and escaped hashes', () => {
      assert.deepStrictEqual(parseTags('&#160; and \\#literal'), []);
    });

    it('ignores issue references and hex colours', () => {
      assert.deepStrictEqual(parseTags('closes #123, colour #a1b2c3 and #ff00aa99'), []);
    });

    it('still tags at the start of a line, in lists and in parentheses-free prose', () => {
      assert.deepStrictEqual(parseTags('#top\n- item #bug\n> quote #perf'), ['top', 'bug', 'perf']);
    });

    it('tags immediately after punctuation that is not markdown-significant', () => {
      assert.deepStrictEqual(parseTags('done. #ship, or... #wait!'), ['ship', 'wait']);
    });
  });

  it('indexes tags by usage, most used first', () => {
    const notes = [
      { tags: ['bug', 'perf'] },
      { tags: ['bug'] },
      { tags: ['bug', 'api'] },
      { tags: [] }
    ];
    assert.deepStrictEqual(tagIndex(notes), [
      { tag: 'bug', count: 3 },
      { tag: 'api', count: 1 },
      { tag: 'perf', count: 1 }
    ]);
  });

  it('returns nothing for an empty body', () => {
    assert.deepStrictEqual(parseTags(''), []);
    assert.deepStrictEqual(tagIndex([]), []);
  });
});
