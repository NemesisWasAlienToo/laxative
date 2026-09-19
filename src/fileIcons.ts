import * as vscode from 'vscode';
import {
  IconThemeDocument,
  LanguageContribution,
  LanguageIndex,
  glyphOf,
  iconFor,
  indexLanguages,
  parseTheme
} from './core/iconTheme';

/** An icon as the Notes list draws it: a glyph from a font, or an image. */
export type ListIcon =
  | { kind: 'font'; glyph: string; font: string; color?: string; size?: string }
  | { kind: 'image'; src: string };

export interface ListFont {
  id: string;
  src: string;
  weight?: string;
  style?: string;
}

interface Loaded {
  document: IconThemeDocument;
  /** The folder the theme file is in: its paths are relative to it. */
  base: vscode.Uri;
  /** What the webview has to be allowed to load from. */
  root: vscode.Uri;
}

/**
 * The user's file icon theme, read from the extension that contributes it, so
 * the Notes list can show the same icon for `cache.ts` that the Explorer does.
 * A webview is not given the theme; this is the only way to it.
 */
export class FileIcons implements vscode.Disposable {
  private loaded?: Loaded;
  private languages: LanguageIndex = indexLanguages([]);
  private readonly emitter = new vscode.EventEmitter<void>();
  /** The theme, or what it says about a file, may have changed. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.iconTheme')) {
          void this.load();
        }
      }),
      vscode.extensions.onDidChange(() => void this.load()),
      // Themes can name different icons for light colour themes.
      vscode.window.onDidChangeActiveColorTheme(() => this.emitter.fire())
    );
  }

  async load(): Promise<void> {
    this.loaded = await this.read();
    this.languages = indexLanguages(
      vscode.extensions.all.flatMap(
        (extension) =>
          (extension.packageJSON?.contributes?.languages as LanguageContribution[] | undefined) ?? []
      )
    );
    this.emitter.fire();
  }

  private async read(): Promise<Loaded | undefined> {
    const wanted = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
    if (!wanted) {
      return undefined;
    }
    for (const extension of vscode.extensions.all) {
      const themes = extension.packageJSON?.contributes?.iconThemes as
        | { id?: string; path?: string }[]
        | undefined;
      const theme = themes?.find((candidate) => candidate.id === wanted);
      if (!theme?.path) {
        continue;
      }
      try {
        const file = vscode.Uri.joinPath(extension.extensionUri, theme.path);
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        return {
          document: parseTheme(text),
          base: vscode.Uri.joinPath(file, '..'),
          root: extension.extensionUri
        };
      } catch {
        return undefined; // A theme that cannot be read is a list with plain icons.
      }
    }
    return undefined;
  }

  /** Folders the webview needs read access to for the icons to load. */
  roots(): vscode.Uri[] {
    return this.loaded ? [this.loaded.root] : [];
  }

  fonts(webview: vscode.Webview): ListFont[] {
    const loaded = this.loaded;
    if (!loaded) {
      return [];
    }
    return (loaded.document.fonts ?? [])
      .filter((font) => font.src?.[0]?.path)
      .map((font) => ({
        id: font.id,
        src: webview.asWebviewUri(vscode.Uri.joinPath(loaded.base, font.src[0].path)).toString(),
        weight: font.weight,
        style: font.style
      }));
  }

  iconFor(file: string, webview: vscode.Webview): ListIcon | undefined {
    const loaded = this.loaded;
    if (!loaded) {
      return undefined;
    }
    const light =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
    const definition = iconFor(loaded.document, file, this.languages, light);
    if (definition?.iconPath) {
      return {
        kind: 'image',
        src: webview.asWebviewUri(vscode.Uri.joinPath(loaded.base, definition.iconPath)).toString()
      };
    }
    if (definition?.fontCharacter) {
      const fonts = loaded.document.fonts ?? [];
      const font = fonts.find((candidate) => candidate.id === definition.fontId) ?? fonts[0];
      if (!font) {
        return undefined;
      }
      return {
        kind: 'font',
        glyph: glyphOf(definition.fontCharacter),
        font: font.id,
        color: definition.fontColor,
        size: definition.fontSize ?? font.size
      };
    }
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
