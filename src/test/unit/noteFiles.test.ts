import * as assert from 'assert';
import {
  DEFAULT_PATH,
  activeNames,
  discoverFiles,
  enabledFiles,
  nameFromPath,
  pathForName,
  validateName
} from '../../core/noteFiles';

/** What `.laxative/` holds, as the file system hands it over. */
const folder = ['review.json', 'notes.json', 'Architecture.json', 'notes.json.tmp', 'README.md'];

describe('note files', () => {
  it('is whatever the folder holds, notes first and the rest in order', () => {
    assert.deepStrictEqual(
      discoverFiles(folder, []).map((file) => `${file.name} ${file.path}`),
      [
        'notes .laxative/notes.json',
        'Architecture .laxative/Architecture.json',
        'review .laxative/review.json'
      ],
      'a half-written file and a file that is not notes are not note files'
    );
  });

  it('switches on the files named, and everything when none are', () => {
    assert.deepStrictEqual(
      discoverFiles(folder, []).map((file) => file.enabled),
      [true, true, true],
      'nothing chosen: everything is shown'
    );
    assert.deepStrictEqual(
      discoverFiles(folder, ['review', 'ARCHITECTURE']).map((file) => `${file.name}:${file.enabled}`),
      ['notes:false', 'Architecture:true', 'review:true'],
      'chosen by name, whatever the case'
    );
    assert.deepStrictEqual(
      discoverFiles(folder, ['deleted-last-week']).map((file) => file.enabled),
      [true, true, true],
      'a list naming nothing that is there would leave every view empty'
    );
  });

  it('offers the file the first note will be written to when the folder is empty', () => {
    assert.deepStrictEqual(discoverFiles([], []), [
      { name: 'notes', path: DEFAULT_PATH, enabled: true }
    ]);
    assert.deepStrictEqual(discoverFiles(['nothing.txt'], ['review']), [
      { name: 'notes', path: DEFAULT_PATH, enabled: true }
    ]);
  });

  it('takes one file per name, since a name is how a file is addressed', () => {
    const files = discoverFiles(['review.json', 'Review.json'], []);
    assert.deepStrictEqual(files.map((file) => file.path), ['.laxative/review.json']);
  });

  it('reads the chosen names however the setting was written', () => {
    assert.deepStrictEqual(activeNames(['a', ' b ', '', 3, null]), ['a', 'b']);
    assert.deepStrictEqual(activeNames(undefined), []);
    assert.deepStrictEqual(activeNames('review'), [], 'not a list, so nothing is chosen');
  });

  it('names the file on disk after the name you gave it', () => {
    // The name is the whole point of adding a file: it decides the file.
    assert.strictEqual(pathForName('architecture'), '.laxative/architecture.json');
    assert.strictEqual(pathForName('Design Notes'), '.laxative/design-notes.json');
    assert.strictEqual(pathForName('  Review  '), '.laxative/review.json');
    assert.strictEqual(pathForName('notes.json'), '.laxative/notes.json', 'a typed extension is not doubled');
  });

  it('keeps a name that cannot be a file name from becoming a path', () => {
    assert.strictEqual(pathForName('team/private'), '.laxative/team-private.json');
    assert.strictEqual(pathForName('../escape'), '.laxative/escape.json');
    assert.strictEqual(pathForName('a:b*c?'), '.laxative/a-b-c.json');
    assert.strictEqual(pathForName('...'), '.laxative/notes.json', 'and something is always left');
    assert.strictEqual(pathForName('aux'), '.laxative/aux-notes.json', 'aux is a device on Windows');
  });

  it('gives two names that sharpen down to the same file a file each', () => {
    const taken = ['.laxative/notes.json', '.laxative/my-notes.json'];
    assert.strictEqual(pathForName('My Notes', taken), '.laxative/my-notes-2.json');
    assert.strictEqual(
      pathForName('My Notes', [...taken, '.laxative/my-notes-2.json']),
      '.laxative/my-notes-3.json'
    );
    assert.strictEqual(pathForName('my notes'), '.laxative/my-notes.json', 'nothing taken, nothing suffixed');
  });

  it('explains why a name cannot be used', () => {
    const taken = ['.laxative/notes.json'];
    assert.strictEqual(validateName('review', taken), undefined);
    assert.match(validateName('', taken) ?? '', /Give the file a name/);
    assert.match(validateName('   ', taken) ?? '', /Give the file a name/);
    assert.match(validateName('notes', taken) ?? '', /already a note file called "notes"/);
    assert.match(
      validateName('NOTES', taken) ?? '',
      /already/,
      'the file name is what collides, not the spelling'
    );
  });

  it('names a file after the file it is', () => {
    assert.strictEqual(nameFromPath('.laxative/review.json'), 'review');
    assert.strictEqual(nameFromPath('.laxative/notes.local.json'), 'notes.local');
    assert.strictEqual(nameFromPath('.laxative/.json'), 'notes');
  });

  it('reports which files are in use', () => {
    const files = discoverFiles(folder, ['review']);
    assert.deepStrictEqual(enabledFiles(files).map((file) => file.name), ['review']);
  });
});
