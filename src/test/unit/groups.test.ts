import * as assert from 'assert';
import { allGroups, normalizeGroup, parseGroup, setGroup } from '../../core/groups';
import { deriveTitle, parse, serialize } from '../../core/schema';
import { groupPrefix } from '../../core/editing';

describe('groups', () => {
  it('is the @name at the end of the first line', () => {
    assert.strictEqual(parseGroup('Session expires too early @auth/login\n\nmore'), 'auth/login');
    assert.strictEqual(parseGroup('Session expires too early@auth/login'), 'auth/login', 'no space needed');
    assert.strictEqual(parseGroup('\n\n# Heading @auth  \nbody'), 'auth', 'first line with text; trailing space ok');
  });

  it('is nothing anywhere else', () => {
    assert.strictEqual(parseGroup('Title\n@auth'), undefined, 'not on a later line');
    assert.strictEqual(parseGroup('ask @kian about this'), undefined, 'not in the middle');
    assert.strictEqual(parseGroup('Plain title'), undefined);
    assert.strictEqual(parseGroup(''), undefined);
  });

  it('is not an email, and not escaped', () => {
    assert.strictEqual(parseGroup('mail a@b.com'), undefined, 'a dot is not part of a group name');
    assert.strictEqual(parseGroup('mail a\\@b'), undefined, '\\@ is a plain @');
  });

  it('ignores case', () => {
    assert.strictEqual(parseGroup('x @Auth/Login'), 'auth/login');
  });

  it('is left out of the title, and escapes read as their symbols', () => {
    assert.strictEqual(deriveTitle('Session expires @auth/login\nbody'), 'Session expires');
    assert.strictEqual(deriveTitle('# Heading @auth'), 'Heading');
    assert.strictEqual(deriveTitle('mail a\\@b'), 'mail a@b');
    assert.strictEqual(deriveTitle('@auth'), 'Untitled note');
    const long = 'x'.repeat(130) + ' @auth';
    assert.ok(!deriveTitle(long).includes('@'), 'never cut off half way');
  });

  it('is set and removed by changing only the end of the first line', () => {
    assert.strictEqual(setGroup('Title\nbody', 'auth'), 'Title @auth\nbody');
    assert.strictEqual(setGroup('Title @old\nbody', 'new/sub'), 'Title @new/sub\nbody');
    assert.strictEqual(setGroup('Title @old\nbody', undefined), 'Title\nbody');
    assert.strictEqual(setGroup('\nTitle', 'a'), '\nTitle @a');
    assert.strictEqual(setGroup('', 'a'), '@a');
  });

  it('turns what is typed into a group name', () => {
    assert.strictEqual(normalizeGroup('@Auth / Login Flow'), 'auth/login-flow');
    assert.strictEqual(normalizeGroup('a//b/'), 'a/b');
    assert.strictEqual(normalizeGroup('!!'), '');
  });

  it('lists every group with its parents', () => {
    assert.deepStrictEqual(allGroups([{ group: 'a/b/c' }, { group: 'd' }, {}]), ['a', 'a/b', 'a/b/c', 'd']);
  });

  it('is read when a note file loads, and not written on its own', () => {
    const text = JSON.stringify({
      version: 1,
      notes: [
        { id: 'x1', title: 'Old title @auth', body: 'Old title @auth\nbody', tags: [], createdAt: '', updatedAt: '' }
      ]
    });
    const [note] = parse(text);
    assert.strictEqual(note.group, 'auth');
    assert.strictEqual(note.title, 'Old title', 'a title saved before groups is worked out again');
    assert.ok(!serialize([note]).includes('"group"'));
  });

  it('is offered after an @ being typed', () => {
    assert.deepStrictEqual(groupPrefix('Title @au'), { query: 'au', start: 6 });
    assert.strictEqual(groupPrefix('Title \\@au'), undefined);
  });
});
