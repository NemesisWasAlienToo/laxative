import * as assert from 'assert';
import {
  DEFAULT_PATH,
  enabledFiles,
  nameFromPath,
  normalisePath,
  parseNoteFiles,
  validateName,
  validatePath
} from '../../core/noteFiles';

describe('note files', () => {
  it('falls back to the single file the extension started with', () => {
    assert.deepStrictEqual(parseNoteFiles(undefined, '.laxative/notes.json'), [
      { name: 'notes', path: '.laxative/notes.json', enabled: true }
    ]);
    assert.deepStrictEqual(parseNoteFiles([], '.laxative/private.json'), [
      { name: 'private', path: '.laxative/private.json', enabled: true }
    ]);
    assert.strictEqual(parseNoteFiles([], '   ')[0].path, DEFAULT_PATH, 'even if that is unusable');
  });

  it('reads a list of named files', () => {
    assert.deepStrictEqual(
      parseNoteFiles(
        [
          { name: 'team', path: '.laxative/notes.json' },
          { name: 'private', path: '.laxative/notes.local.json', enabled: false }
        ],
        DEFAULT_PATH
      ),
      [
        { name: 'team', path: '.laxative/notes.json', enabled: true },
        { name: 'private', path: '.laxative/notes.local.json', enabled: false }
      ]
    );
  });

  it('names a file after its path when no name is given', () => {
    const [file] = parseNoteFiles([{ path: 'docs/architecture.json' }], DEFAULT_PATH);
    assert.strictEqual(file.name, 'architecture');
    assert.strictEqual(nameFromPath('.laxative/notes.local.json'), 'notes.local');
  });

  it('keeps names distinct, since a name is how a file is addressed', () => {
    const files = parseNoteFiles(
      [
        { name: 'notes', path: 'a/notes.json' },
        { name: 'notes', path: 'b/notes.json' },
        { name: 'notes', path: 'c/notes.json' }
      ],
      DEFAULT_PATH
    );
    assert.deepStrictEqual(files.map((f) => f.name), ['notes', 'notes 2', 'notes 3']);
  });

  it('drops entries it cannot use rather than refusing to start', () => {
    const files = parseNoteFiles(
      [
        'nonsense',
        null,
        { name: 'no path' },
        { name: 'escape', path: '../outside.json' },
        { name: 'absolute', path: '/etc/notes.json' },
        { name: 'windows', path: 'C:/notes.json' },
        { name: 'first', path: 'notes.json' },
        { name: 'again', path: './notes.json' },
        { name: 'good', path: 'second.json' }
      ],
      DEFAULT_PATH
    );
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ['notes.json', 'second.json'],
      'the same file twice counts once, and paths outside the workspace are refused'
    );
  });

  it('keeps one file switched on, so the views are never inexplicably empty', () => {
    const files = parseNoteFiles(
      [
        { name: 'a', path: 'a.json', enabled: false },
        { name: 'b', path: 'b.json', enabled: false }
      ],
      DEFAULT_PATH
    );
    assert.deepStrictEqual(files.map((f) => f.enabled), [true, false]);
  });

  it('reports which files are in use', () => {
    const files = parseNoteFiles(
      [
        { name: 'a', path: 'a.json' },
        { name: 'b', path: 'b.json', enabled: false },
        { name: 'c', path: 'c.json' }
      ],
      DEFAULT_PATH
    );
    assert.deepStrictEqual(enabledFiles(files).map((f) => f.name), ['a', 'c']);
  });

  it('normalises paths the way the store writes them', () => {
    assert.strictEqual(normalisePath('  .laxative\\notes.json '), '.laxative/notes.json');
    assert.strictEqual(normalisePath('./notes.json'), 'notes.json');
    for (const bad of ['', '   ', '/abs.json', 'C:/abs.json', 'a/../../b.json', 42, null]) {
      assert.strictEqual(normalisePath(bad as unknown), undefined, `${String(bad)} is refused`);
    }
  });

  it('explains why a name or path cannot be used', () => {
    assert.match(validateName('  ', []) ?? '', /name/i);
    assert.match(validateName('Team', ['team']) ?? '', /already/i);
    assert.strictEqual(validateName('other', ['team']), undefined);

    assert.match(validatePath('../x.json', []) ?? '', /inside the workspace/i);
    assert.match(validatePath('notes.json', ['notes.json']) ?? '', /already/i);
    assert.strictEqual(validatePath('notes.json', ['other.json']), undefined);
  });
});
