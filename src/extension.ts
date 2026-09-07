import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Annotations } from './annotations';
import { NotesTree } from './tree';
import { NotePanel } from './notePanel';
import { NoteDocuments } from './noteDocuments';
import { configureStorage } from './storageSettings';
import { GraphView } from './graphView';
import { Diagnostics, showDiagnostics } from './diagnostics';
import { exportNotes, importNotes } from './portability';
import { Note } from './core/types';
import { tagIndex } from './core/tags';

/** Tree items and CodeLenses pass an id; menus may pass the item itself. */
function noteIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  const note = (arg as { note?: Note } | undefined)?.note;
  return note?.id;
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new NoteStore();
  const annotations = new Annotations(store, context);
  const tree = new NotesTree(store, context.workspaceState);
  const documents = new NoteDocuments(store);
  const diagnostics = new Diagnostics();
  const graph = new GraphView(store, context.extensionUri, diagnostics);
  context.subscriptions.push(store, annotations, tree, documents, graph);

  const requireStore = (): boolean => {
    if (store.root) {
      return true;
    }
    void vscode.window.showWarningMessage(
      'Laxative: open a folder or workspace first — notes are stored inside it.'
    );
    return false;
  };

  const resolve = async (arg: unknown): Promise<Note | undefined> => {
    const id = noteIdOf(arg);
    if (id) {
      return store.get(id);
    }
    return pickNote('Select a note');
  };

  const pickNote = async (title: string): Promise<Note | undefined> => {
    const notes = store.all();
    if (notes.length === 0) {
      void vscode.window.showInformationMessage('Laxative: there are no notes yet.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      notes.map((note) => ({
        label: `$(comment) ${note.title}`,
        description: `${note.file}:${note.line + 1}:${note.character + 1}${
          note.tags.length > 0 ? '  ' + note.tags.map((t) => '#' + t).join(' ') : ''
        }`,
        detail: note.body.split('\n').slice(1).join(' ').trim().slice(0, 120) || undefined,
        note
      })),
      { title, matchOnDescription: true, matchOnDetail: true }
    );
    return picked?.note;
  };

  const revealNote = async (note: Note): Promise<void> => {
    const uri = store.absoluteUri(note.file);
    if (!uri) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.min(note.line, Math.max(document.lineCount - 1, 0));
      const character = Math.min(note.character, document.lineAt(line).range.end.character);
      // Land the cursor exactly where the note was made, not just on the line.
      const anchor = new vscode.Position(line, character);
      // If the file is already open somewhere, show it there. Forcing a column
      // would move the user's editor out from under them.
      const openIn = vscode.window.tabGroups.all.find((group) =>
        group.tabs.some(
          (tab) =>
            (tab.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === uri.toString()
        )
      )?.viewColumn;
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: openIn ?? vscode.ViewColumn.One,
        selection: new vscode.Selection(anchor, anchor)
      });
      editor.revealRange(
        document.lineAt(line).range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
      void tree.reveal(note.id);
    } catch {
      void vscode.window.showWarningMessage(
        `Laxative: cannot open ${note.file} — the file may have been moved or deleted.`
      );
    }
  };

  const command = (name: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler as never));

  command('laxative.addNote', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !requireStore()) {
      return;
    }
    const file = store.relativePath(editor.document.uri);
    if (!file) {
      void vscode.window.showWarningMessage(
        'Laxative: that file is outside the workspace folder, so it cannot be annotated.'
      );
      return;
    }
    const position = editor.selection.active;
    // Straight into a real editor: the note is a markdown document, so writing
    // one gets the full editor rather than a single-line prompt.
    const note = await store.create({
      file,
      line: position.line,
      character: position.character,
      body: ''
    });
    annotations.refreshAll();
    await NoteDocuments.open(note);
    void vscode.window.setStatusBarMessage(
      'Laxative: first line becomes the title. Save to keep the note; close it empty to discard.',
      6000
    );
  });

  command('laxative.openNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (note) {
      NotePanel.show(store, context.extensionUri, note.id, diagnostics);
    }
  });

  command('laxative.editNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (note) {
      await NoteDocuments.open(note);
    }
  });

  command('laxative.deleteNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (!note) {
      return;
    }
    if (vscode.workspace.getConfiguration('laxative').get<boolean>('confirmDelete', true)) {
      const confirm = await vscode.window.showWarningMessage(
        `Delete note "${note.title}"?`,
        { modal: true, detail: `${note.file}:${note.line + 1}` },
        'Delete'
      );
      if (confirm !== 'Delete') {
        return;
      }
    }
    await store.remove(note.id);
    annotations.refreshAll();
  });

  /** What clicking a note in the Notes view does, per laxative.listClickAction. */
  command('laxative.activateNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (!note) {
      return;
    }
    const actions = vscode.workspace
      .getConfiguration('laxative')
      .get<string[]>('listClickAction', ['reveal', 'preview']);
    // Ordered so the code lands in the main column before anything opens beside it.
    if (actions.includes('reveal')) {
      await revealNote(note);
    }
    if (actions.includes('preview')) {
      NotePanel.show(store, context.extensionUri, note.id, diagnostics);
    }
    if (actions.includes('edit')) {
      await NoteDocuments.open(note);
    }
  });

  command('laxative.revealNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (note) {
      await revealNote(note);
    }
  });

  command('laxative.notesAtCursor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const notes = annotations.notesAt(editor);
    if (notes.length === 0) {
      void vscode.window.showInformationMessage('Laxative: no note on this line.');
      return;
    }
    if (notes.length === 1) {
      NotePanel.show(store, context.extensionUri, notes[0].id, diagnostics);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      notes.map((note) => ({ label: note.title, note })),
      { title: `${notes.length} notes on this line` }
    );
    if (picked) {
      NotePanel.show(store, context.extensionUri, picked.note.id, diagnostics);
    }
  });

  command('laxative.searchNotes', async () => {
    const note = await pickNote('Search notes');
    if (note) {
      await revealNote(note);
      NotePanel.show(store, context.extensionUri, note.id, diagnostics);
    }
  });

  command('laxative.copyReference', async (arg: unknown) => {
    const note = await resolve(arg);
    if (note) {
      await vscode.env.clipboard.writeText(`[[${note.id}|${note.title}]]`);
      void vscode.window.showInformationMessage('Laxative: reference copied to the clipboard.');
    }
  });

  command('laxative.showGraph', async () => {
    if (requireStore()) {
      await GraphView.focus();
    }
  });

  command('laxative.showDiagnostics', () => showDiagnostics(diagnostics));

  command('laxative._diagnostics', () => diagnostics.snapshot());

  command('laxative.configureStorage', async () => {
    if (requireStore()) {
      await configureStorage(store);
      annotations.refreshAll();
    }
  });

  command('laxative.export', async () => {
    if (requireStore()) {
      await exportNotes(store);
    }
  });

  command('laxative.import', async () => {
    if (requireStore()) {
      await importNotes(store);
      annotations.refreshAll();
    }
  });

  command('laxative.openStoreFile', async () => {
    const uri = store.storeUri;
    if (!uri) {
      requireStore();
      return;
    }
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } catch {
      void vscode.window.showInformationMessage(
        `Laxative: ${uri.fsPath} does not exist yet — it is written when you add your first note.`
      );
    }
  });

  command('laxative.groupByTag', () => tree.setGroupBy('tag'));
  command('laxative.groupByFile', () => tree.setGroupBy('file'));

  command('laxative.filterByTag', async (arg: unknown) => {
    // Invoked with a tag name, or with the tag group the user right-clicked.
    const fromItem = (arg as { tag?: unknown } | undefined)?.tag;
    const direct = typeof arg === 'string' ? arg : typeof fromItem === 'string' ? fromItem : undefined;
    if (direct) {
      tree.setTagFilter(direct.replace(/^#/, ''));
      return;
    }
    const tags = tagIndex(store.all());
    if (tags.length === 0) {
      void vscode.window.showInformationMessage(
        'Laxative: no hashtags yet — write #like-this inside a note to group it.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tags.map(({ tag, count }) => ({
        label: `$(tag) #${tag}`,
        description: `${count} note${count === 1 ? '' : 's'}`,
        tag
      })),
      { title: 'Filter notes by hashtag' }
    );
    if (picked) {
      await tree.setGroupBy('file');
      tree.setTagFilter(picked.tag);
    }
  });

  command('laxative.clearTagFilter', () => tree.setTagFilter(undefined));

  command('laxative.refresh', async () => {
    tree.setTagFilter(undefined);
    await store.reload();
    annotations.refreshAll();
  });

  void store.initialize().then(() => annotations.refreshAll());
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
