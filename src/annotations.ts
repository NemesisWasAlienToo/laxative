import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Note } from './core/types';
import { hoverMarkdown } from './markdown';

/** The lines a document's marks were last drawn on, and how many times. */
export interface Marks {
  gutter: number[];
  inline: number[];
  draws: number;
}

/**
 * Everything the user sees inside a text editor: the gutter icon, the dimmed
 * title at the end of the line, the hover card, and the CodeLens. Also keeps
 * anchors glued to their code as files change.
 */
export class Annotations implements vscode.Disposable, vscode.CodeLensProvider {
  private readonly gutter: vscode.TextEditorDecorationType;
  private readonly inline: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private hasNoteAtCursor?: boolean;
  /** Coalesces the redraws a burst of typing would otherwise ask for. */
  private pending?: ReturnType<typeof setTimeout>;
  /** What each document's marks were last drawn from, for the integration
   *  tests: a decoration that has drifted cannot be read back from the API. */
  private readonly drawn = new Map<string, Marks>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;

  constructor(
    private readonly store: NoteStore,
    context: vscode.ExtensionContext
  ) {
    const icon = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'media', name);
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconSize: 'contain',
      light: { gutterIconPath: icon('note-light.svg') },
      dark: { gutterIconPath: icon('note-dark.svg') },
      // A decoration is a live range that the editor moves with the text. An
      // edit at the mark's own position -- duplicating the line it is on --
      // would otherwise widen it over both copies, and the gutter draws its
      // icon on every line the range touches, so one note showed two icons.
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    this.inline = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 1.5rem'
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
    });

    this.disposables.push(
      this.gutter,
      this.inline,
      this.lensChanged,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      // The notes say which line they are on; the editor's own tracking of the
      // marks only approximates that, and an edit can leave a mark on the
      // wrong line or on two. Drawing them again from the notes after an edit
      // is what used to take reloading the window.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0 && this.store.relativePath(e.document.uri)) {
          this.scheduleRefresh();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.updateCursorContext(e.textEditor)),
      // Switching between two editors that are both on screen moves no cursor.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.updateCursorContext(editor);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('laxative')) {
          this.refreshAll();
        }
      }),
      store.onDidChange(() => {
        this.refreshAll();
        this.lensChanged.fire();
      })
    );
  }

  /**
   * Runs on every cursor movement, so every keystroke. Setting a context key
   * is a round trip to the workbench that re-evaluates menus and keybindings,
   * so it is only done when the answer has actually changed.
   */
  private updateCursorContext(editor: vscode.TextEditor): void {
    const has = this.notesAt(editor).length > 0;
    if (has === this.hasNoteAtCursor) {
      return;
    }
    this.hasNoteAtCursor = has;
    void vscode.commands.executeCommand('setContext', 'laxative.hasNoteAtCursor', has);
  }

  /** Notes on the line the cursor currently sits on. */
  notesAt(editor: vscode.TextEditor): Note[] {
    const file = this.store.relativePath(editor.document.uri);
    if (!file) {
      return [];
    }
    const line = editor.selection.active.line;
    return this.store.byFile(file).filter((n) => n.line === line);
  }

  /** One redraw for a burst of edits, on the next quiet moment. */
  private scheduleRefresh(): void {
    if (this.pending !== undefined) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.refreshAll();
    }, 100);
  }

  /** Where this document's marks were last drawn, and how often. */
  marks(document: vscode.TextDocument): Marks {
    return this.drawn.get(document.uri.toString()) ?? { gutter: [], inline: [], draws: 0 };
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor);
    }
    const active = vscode.window.activeTextEditor;
    if (active) {
      this.updateCursorContext(active);
    }
  }

  private refresh(editor: vscode.TextEditor): void {
    const file = this.store.relativePath(editor.document.uri);
    if (!file) {
      editor.setDecorations(this.gutter, []);
      editor.setDecorations(this.inline, []);
      this.record(editor, [], []);
      return;
    }
    const config = vscode.workspace.getConfiguration('laxative');
    const all = this.store.all();
    const byLine = new Map<number, Note[]>();
    for (const note of this.store.byFile(file)) {
      const line = Math.min(note.line ?? 0, Math.max(editor.document.lineCount - 1, 0));
      byLine.set(line, [...(byLine.get(line) ?? []), note]);
    }

    const gutterRanges: vscode.DecorationOptions[] = [];
    const inlineRanges: vscode.DecorationOptions[] = [];
    const showGutter = config.get<boolean>('showGutterIcon', true);
    const showInline = config.get<boolean>('showInlineTitle', true);

    for (const [line, notes] of byLine) {
      const hoverMessage = hoverMarkdown(notes, all);
      if (showGutter) {
        gutterRanges.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage });
      }
      if (showInline) {
        const end = editor.document.lineAt(line).range.end;
        const label =
          notes.length === 1 ? notes[0].title : `${notes.length} notes: ${notes[0].title}`;
        inlineRanges.push({
          range: new vscode.Range(end, end),
          hoverMessage,
          renderOptions: { after: { contentText: label } }
        });
      }
    }
    editor.setDecorations(this.gutter, gutterRanges);
    editor.setDecorations(this.inline, inlineRanges);
    this.record(editor, gutterRanges, inlineRanges);
  }

  private record(
    editor: vscode.TextEditor,
    gutter: vscode.DecorationOptions[],
    inline: vscode.DecorationOptions[]
  ): void {
    const key = editor.document.uri.toString();
    this.drawn.set(key, {
      gutter: gutter.map((mark) => mark.range.start.line),
      inline: inline.map((mark) => mark.range.start.line),
      draws: (this.drawn.get(key)?.draws ?? 0) + 1
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('laxative').get<boolean>('showCodeLens', true)) {
      return [];
    }
    const file = this.store.relativePath(document.uri);
    if (!file) {
      return [];
    }
    return this.store.byFile(file).map((note) => {
      const line = Math.min(note.line ?? 0, Math.max(document.lineCount - 1, 0));
      // Plain text on purpose: the gutter bubble is the note's only icon, and
      // a codicon here would put a second one on the same line.
      return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: note.title,
        tooltip: 'Open this note',
        command: 'laxative.openNote',
        arguments: [note.id]
      });
    });
  }

  dispose(): void {
    if (this.pending !== undefined) {
      clearTimeout(this.pending);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
