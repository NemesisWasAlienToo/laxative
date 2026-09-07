import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Note } from './core/types';
import { deriveTitle } from './core/schema';
import { parseTags } from './core/tags';
import { renderHtml } from './markdown';
import { NOTE_SCHEME } from './noteDocuments';
import { Diagnostics } from './diagnostics';

/**
 * The reading view for a note: rendered markdown, its hashtags, what it
 * references and what references it. Writing happens in a real text editor
 * (see NoteDocuments), which this panel links out to.
 */
export class NotePanel {
  private static current?: NotePanel;
  private readonly disposables: vscode.Disposable[] = [];
  private noteId: string;
  private previewTimer?: NodeJS.Timeout;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: NoteStore,
    private readonly extensionUri: vscode.Uri,
    noteId: string,
    private readonly diagnostics: Diagnostics
  ) {
    this.noteId = noteId;
    // Listener first: the webview announces itself as soon as its script runs.
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.html = this.shell();
    this.disposables.push(
      store.onDidChange(() => this.push()),
      // Follow whichever note is being edited, and render it as it is typed, so
      // the panel works as a live preview beside the editor.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const id = editor?.document.uri;
        if (id?.scheme === NOTE_SCHEME && this.store.get(id.authority)) {
          this.noteId = id.authority;
          this.push();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === NOTE_SCHEME && e.document.uri.authority === this.noteId) {
          this.schedulePreview();
        }
      })
    );
  }

  private schedulePreview(): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.push(), 200);
  }

  /**
   * What to render: the text of the open editor when there is one, so unsaved
   * edits show up, otherwise what is stored.
   */
  private bodyFor(note: Note): string {
    const open = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === NOTE_SCHEME &&
        document.uri.authority === note.id &&
        !document.isClosed
    );
    return open ? open.getText() : note.body;
  }

  static show(
    store: NoteStore,
    extensionUri: vscode.Uri,
    noteId: string,
    diagnostics: Diagnostics
  ): NotePanel | undefined {
    if (!store.get(noteId)) {
      void vscode.window.showWarningMessage(`Laxative: note "${noteId}" no longer exists.`);
      return undefined;
    }
    if (NotePanel.current) {
      NotePanel.current.noteId = noteId;
      // Reveal where it already is. Passing a column here would *move* the
      // panel next to whatever happens to be focused, re-splitting the editor
      // area and resizing every other group.
      NotePanel.current.panel.reveal(NotePanel.current.panel.viewColumn, true);
      NotePanel.current.push();
      return NotePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'laxative.note',
      'Note',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    NotePanel.current = new NotePanel(panel, store, extensionUri, noteId, diagnostics);
    NotePanel.current.push();
    return NotePanel.current;
  }

  private media(name: string): vscode.Uri {
    return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
  }

  private shell(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${this.media('panel.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${this.media('panel.js')}"></script>
</body>
</html>`;
  }

  /** Sends the note as it currently reads to the webview. */
  private push(): void {
    const note = this.store.get(this.noteId);
    if (!note) {
      this.panel.title = 'Note (deleted)';
      void this.panel.webview.postMessage({ type: 'missing' });
      return;
    }
    const all = this.store.all();
    const body = this.bodyFor(note);
    const title = deriveTitle(body);
    this.panel.title = title;
    void this.panel.webview.postMessage({
      type: 'render',
      note: { id: note.id, title, file: note.file, line: note.line },
      html: renderHtml(body, all),
      empty: body.trim() === '',
      meta: {
        file: note.file,
        line: note.line + 1,
        character: note.character + 1,
        updatedAt: note.updatedAt,
        tags: parseTags(body)
      }
    });
  }

  private async onMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        return;
      case 'rendered':
        this.diagnostics.record('notePanel', msg as Record<string, unknown>);
        return;
      case 'edit':
        await vscode.commands.executeCommand('laxative.editNote', this.noteId);
        return;
      case 'delete':
        await vscode.commands.executeCommand('laxative.deleteNote', this.noteId);
        return;
      case 'copyRef':
        await vscode.commands.executeCommand('laxative.copyReference', this.noteId);
        return;
      case 'open':
        this.noteId = String(msg.id);
        this.push();
        return;
      case 'reveal':
        await vscode.commands.executeCommand('laxative.revealNote', this.noteId);
        return;
      case 'filterTag':
        await vscode.commands.executeCommand('laxative.filterByTag', String(msg.tag));
        await vscode.commands.executeCommand('laxative.notesView.focus');
        return;
      default:
        return;
    }
  }

  dispose(): void {
    clearTimeout(this.previewTimer);
    if (NotePanel.current === this) {
      NotePanel.current = undefined;
    }
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
