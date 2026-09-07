import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Note } from './core/types';
import { hoverMarkdown } from './markdown';

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
  readonly onDidChangeCodeLenses = this.lensChanged.event;

  constructor(
    private readonly store: NoteStore,
    context: vscode.ExtensionContext
  ) {
    const icon = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'media', name);
    this.gutter = vscode.window.createTextEditorDecorationType({
      gutterIconSize: 'contain',
      light: { gutterIconPath: icon('note-light.svg') },
      dark: { gutterIconPath: icon('note-dark.svg') }
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
      vscode.window.onDidChangeTextEditorSelection((e) => this.updateCursorContext(e.textEditor)),
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

  private updateCursorContext(editor: vscode.TextEditor): void {
    void vscode.commands.executeCommand(
      'setContext',
      'laxative.hasNoteAtCursor',
      this.notesAt(editor).length > 0
    );
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
      return;
    }
    const config = vscode.workspace.getConfiguration('laxative');
    const all = this.store.all();
    const byLine = new Map<number, Note[]>();
    for (const note of this.store.byFile(file)) {
      const line = Math.min(note.line, Math.max(editor.document.lineCount - 1, 0));
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
      const line = Math.min(note.line, Math.max(document.lineCount - 1, 0));
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
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
