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

/** Why the list is drawing plain page icons, when it is. */
export interface IconReport {
  /** `workbench.iconTheme`, or null for "None". */
  wanted: string | null;
  found: boolean;
  /** The extension the theme came from, when one was found. */
  from?: string;
  definitions?: number;
  fonts?: number;
  /** What stopped it, when something did. */
  problem?: string;
  /** Every icon theme this extension host can see, which in a remote window
   *  is not the same set the workbench is drawing the Explorer with. */
  available?: string[];
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
  private report: IconReport = { wanted: null, found: false };
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

  /** What the icon theme did, for Show Rendering Diagnostics. */
  describe(): IconReport {
    return this.report;
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
    const wanted = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme') ?? null;
    // Built up here and published in one go at the end: a report read while it
    // was still being filled in would say the theme had failed when it had
    // only not been tried yet.
    const report: IconReport = { wanted, found: false };
    try {
      if (!wanted) {
        // Asked for no icons; drawing some anyway would be worse than none.
        report.problem = 'No file icon theme is chosen (workbench.iconTheme is None).';
        return undefined;
      }
      report.available = vscode.extensions.all.flatMap((extension) =>
        ((extension.packageJSON?.contributes?.iconThemes as { id?: string }[] | undefined) ?? [])
          .map((theme) => theme.id)
          .filter((id): id is string => typeof id === 'string')
      );
      // Your theme or nothing: a different theme's icons would not be the
      // ones the Explorer is showing, and standing in for them is worse than
      // leaving the rows plain and saying why.
      return await this.readTheme(wanted, report);
    } finally {
      this.report = report;
    }
  }

  private async readTheme(wanted: string, report: IconReport): Promise<Loaded | undefined> {
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
        const document = parseTheme(text);
        report.found = true;
        report.from = `${extension.id} (${extension.extensionUri.scheme})`;
        report.definitions = Object.keys(document.iconDefinitions ?? {}).length;
        report.fonts = (document.fonts ?? []).length;
        return {
          document,
          base: vscode.Uri.joinPath(file, '..'),
          root: extension.extensionUri
        };
      } catch (err) {
        // A theme that cannot be read is a list with plain icons, but silence
        // here is exactly what makes "my icons are gone" unanswerable. The
        // first thing to go wrong is the interesting one: it is about the
        // theme actually asked for.
        report.problem = `${theme.path} could not be read: ${String(err)}`;
        return undefined;
      }
    }
    // Themes are UI extensions: over a remote connection they are installed on
    // the local side, where this extension host cannot see them at all.
    report.problem =
      `No installed extension contributes the icon theme "${wanted}". ` +
      (vscode.env.remoteName
        ? `This window is connected to ${vscode.env.remoteName}, and an icon theme installed locally is not visible to a remote extension host.`
        : 'It may be disabled in this workspace.');
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
