import * as assert from 'assert';
import { glyphOf, iconFor, indexLanguages, parseTheme } from '../../core/iconTheme';

const theme = {
  file: '_default',
  fileNames: { 'package.json': '_npm', makefile: '_make' },
  fileExtensions: { ts: '_ts', 'test.ts': '_test', md: '_md' },
  languageIds: { python: '_python', dockerfile: '_docker' },
  light: { file: '_default_light', fileExtensions: { ts: '_ts_light' } },
  iconDefinitions: {
    _default: { fontCharacter: '\\E001' },
    _default_light: { fontCharacter: '\\E002' },
    _npm: { iconPath: './icons/npm.svg' },
    _make: { fontCharacter: '\\E010' },
    _ts: { fontCharacter: '\\E020', fontColor: '#519aba' },
    _ts_light: { fontCharacter: '\\E020', fontColor: '#498ba7' },
    _test: { fontCharacter: '\\E021' },
    _md: { fontCharacter: '\\E030' },
    _python: { fontCharacter: '\\E040' },
    _docker: { fontCharacter: '\\E050' }
  }
};
const languages = indexLanguages([
  { id: 'python', extensions: ['.py', '.pyw'] },
  { id: 'dockerfile', filenames: ['Dockerfile'], extensions: ['.dockerfile'] },
  { id: 'nothing-to-index' },
  {}
]);
const of = (file: string, light = false) => iconFor(theme, file, languages, light);

describe('reading a file icon theme', () => {
  it('matches a whole file name before anything else, whatever its case', () => {
    assert.deepStrictEqual(of('web/package.json'), { iconPath: './icons/npm.svg' });
    assert.strictEqual(of('Makefile')?.fontCharacter, '\\E010');
  });

  it('matches the longest extension first', () => {
    assert.strictEqual(of('src/cache.test.ts')?.fontCharacter, '\\E021');
    assert.strictEqual(of('src/cache.ts')?.fontColor, '#519aba');
    assert.strictEqual(of('src/a.b.md')?.fontCharacter, '\\E030');
  });

  it('falls back to the language an extension or file name belongs to', () => {
    assert.strictEqual(of('tools/run.py')?.fontCharacter, '\\E040');
    assert.strictEqual(of('docker/Dockerfile')?.fontCharacter, '\\E050');
  });

  it('gives anything else the theme\'s plain file icon', () => {
    assert.strictEqual(of('LICENSE')?.fontCharacter, '\\E001');
    assert.strictEqual(of('data.unknown')?.fontCharacter, '\\E001');
    assert.strictEqual(iconFor({}, 'a.ts', languages), undefined, 'and nothing if there is none');
  });

  it('prefers the light variants under a light colour theme, then the ordinary ones', () => {
    assert.strictEqual(of('src/cache.ts', true)?.fontColor, '#498ba7');
    assert.strictEqual(of('notes.md', true)?.fontCharacter, '\\E030', 'no light variant: the usual');
    assert.strictEqual(of('LICENSE', true)?.fontCharacter, '\\E002');
  });

  it('turns an escaped code point into the character', () => {
    assert.strictEqual(glyphOf('\\E0A5'), '');
    assert.strictEqual(glyphOf('\\1F600'), '\u{1F600}');
    assert.strictEqual(glyphOf('x'), 'x');
  });

  it('reads theme files that carry comments and trailing commas', () => {
    const parsed = parseTheme(`{
      // generated
      "file": "_default", /* the fallback */
      "fileExtensions": { "ts": "_ts", },
      "iconDefinitions": { "_ts": { "iconPath": "./a//b.svg" } },
    }`);
    assert.strictEqual(parsed.fileExtensions?.ts, '_ts');
    assert.strictEqual(parsed.iconDefinitions?._ts.iconPath, './a//b.svg', 'slashes in strings survive');
  });
});
