/**
 * Reading a VS Code file icon theme: which icon a file name gets.
 *
 * The Notes list is a webview, and a webview is not given the icon theme, so
 * the theme's own definition file is read instead. This is the pure half: the
 * document and the languages go in, an icon definition comes out.
 */

export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

export interface IconFont {
  id: string;
  src: { path: string; format?: string }[];
  weight?: string;
  style?: string;
  size?: string;
}

interface Associations {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface IconThemeDocument extends Associations {
  fonts?: IconFont[];
  iconDefinitions?: Record<string, IconDefinition>;
  light?: Associations;
  highContrast?: Associations;
}

/** A language as extensions contribute it: what it calls itself and what it claims. */
export interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
}

export interface LanguageIndex {
  byName: Map<string, string>;
  byExtension: Map<string, string>;
}

export function indexLanguages(languages: readonly LanguageContribution[]): LanguageIndex {
  const byName = new Map<string, string>();
  const byExtension = new Map<string, string>();
  for (const language of languages) {
    if (typeof language?.id !== 'string') {
      continue;
    }
    for (const name of language.filenames ?? []) {
      byName.set(String(name).toLowerCase(), language.id);
    }
    for (const extension of language.extensions ?? []) {
      // First come, first served: built-in languages are listed first.
      const key = String(extension).toLowerCase().replace(/^\./, '');
      if (!byExtension.has(key)) {
        byExtension.set(key, language.id);
      }
    }
  }
  return { byName, byExtension };
}

/** `a.test.ts` → `test.ts`, `ts`: longest first, as the workbench matches them. */
function extensionsOf(name: string): string[] {
  const out: string[] = [];
  let at = name.indexOf('.');
  while (at >= 0) {
    if (at < name.length - 1) {
      out.push(name.slice(at + 1));
    }
    at = name.indexOf('.', at + 1);
  }
  return out;
}

function lookup(
  associations: Associations | undefined,
  name: string,
  languages: LanguageIndex
): string | undefined {
  if (!associations) {
    return undefined;
  }
  const byName = associations.fileNames?.[name];
  if (byName) {
    return byName;
  }
  const extensions = extensionsOf(name);
  for (const extension of extensions) {
    const found = associations.fileExtensions?.[extension];
    if (found) {
      return found;
    }
  }
  const language =
    languages.byName.get(name) ??
    extensions.map((extension) => languages.byExtension.get(extension)).find(Boolean);
  return language ? associations.languageIds?.[language] : undefined;
}

/**
 * The icon for a file, or undefined when the theme has none for it. A light
 * colour theme looks in the theme's `light` section first, then falls back.
 */
export function iconFor(
  theme: IconThemeDocument,
  file: string,
  languages: LanguageIndex,
  light = false
): IconDefinition | undefined {
  const name = (file.split('/').pop() ?? file).toLowerCase();
  const id =
    (light ? lookup(theme.light, name, languages) : undefined) ??
    lookup(theme, name, languages) ??
    (light ? theme.light?.file : undefined) ??
    theme.file;
  return id ? theme.iconDefinitions?.[id] : undefined;
}

/** `"\\E001"` as themes write it → the character itself. */
export function glyphOf(fontCharacter: string): string {
  const hex = /^\\([0-9a-fA-F]+)$/.exec(fontCharacter.trim());
  return hex ? String.fromCodePoint(parseInt(hex[1], 16)) : fontCharacter;
}

/** Theme files are JSON, but some carry comments and trailing commas. */
export function parseTheme(text: string): IconThemeDocument {
  try {
    return JSON.parse(text) as IconThemeDocument;
  } catch {
    const stripped = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as IconThemeDocument;
  }
}
