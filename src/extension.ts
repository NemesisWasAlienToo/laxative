import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Annotations } from './annotations';
import { NotesView } from './notesView';
import { NotePanel } from './notePanel';
import { NoteDocuments } from './noteDocuments';
import {
  addNoteFile,
  configureStorage,
  pickNoteFile,
  removeNoteFile,
  selectNoteFiles
} from './storageSettings';
import { GraphView } from './graphView';
import { Diagnostics, showDiagnostics } from './diagnostics';
import { exportNotes, importNotes } from './portability';
import { Note } from './core/types';
import { tagIndex } from './core/tags';

/** The list and CodeLenses pass an id; the list's right-click menu passes `{ noteId }`. */
function noteIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  const record = arg as { note?: Note; id?: unknown; noteId?: unknown } | undefined;
  if (typeof record?.noteId === 'string') {
    return record.noteId;
  }
  // `{ id }` as well, so a command can be driven directly rather than clicked.
  if (typeof record?.id === 'string') {
    return record.id;
  }
  return record?.note?.id;
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new NoteStore();
  const annotations = new Annotations(store, context);
  const tree = new NotesView(store, context.extensionUri, context.workspaceState);
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
      tree.reveal(note.id);
    } catch {
      void vscode.window.showWarningMessage(
        `Laxative: cannot open ${note.file} — the file may have been moved or deleted.`
      );
    }
  };

  const command = (name: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler as never));

  /**
   * The note file a new note is most likely meant for: the one pinned in
   * settings, otherwise the one used last time, otherwise the first one on.
   */
  const preferredFile = (): string | undefined => {
    const enabled = store.enabledFiles().map((file) => file.name);
    const pinned = vscode.workspace.getConfiguration('laxative').get<string>('defaultNoteFile', '');
    const last = context.workspaceState.get<string>('laxative.lastNoteFile');
    return [pinned, last].find((name) => name && enabled.includes(name)) ?? enabled[0];
  };

  /**
   * With several note files on, a new note has to land in one of them, and
   * which one is the whole point of having several. So it is asked, with the
   * likely answer first: Enter takes it, and the choice is remembered so the
   * next note defaults to the same file.
   */
  const chooseTargetFile = async (): Promise<string | undefined> => {
    const enabled = store.enabledFiles();
    const preferred = preferredFile();
    const ask = vscode.workspace.getConfiguration('laxative').get<boolean>('askWhichNoteFile', true);
    if (enabled.length < 2 || !ask) {
      return preferred;
    }
    const ordered = [...enabled].sort(
      (a, b) => Number(b.name === preferred) - Number(a.name === preferred)
    );
    const picked = await vscode.window.showQuickPick(
      ordered.map((file) => ({
        label: file.name,
        description: file.name === preferred ? `${file.path} · last used` : file.path,
        name: file.name
      })),
      { title: 'Add the note to which note file?', placeHolder: 'Enter takes the first one' }
    );
    if (picked) {
      await context.workspaceState.update('laxative.lastNoteFile', picked.name);
    }
    return picked?.name;
  };

  command('laxative.addNote', async (arg: unknown) => {
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
    // Read before anything is asked: a prompt takes the focus with it.
    const position = editor.selection.active;
    // Called with { target } there is nothing to ask, which also lets a
    // keybinding be bound straight to one note file.
    const named = (arg as { target?: unknown } | undefined)?.target;
    const enabledNames = store.enabledFiles().map((f) => f.name);
    let target: string | undefined;
    if (typeof named === 'string') {
      if (!enabledNames.includes(named)) {
        void vscode.window.showWarningMessage(
          `Laxative: there is no note file called "${named}" switched on.`
        );
        return;
      }
      target = named;
    } else if (enabledNames.length > 0) {
      target = await chooseTargetFile();
      if (!target) {
        return; // Backed out of the question, so no note.
      }
    }
    // Straight into a real editor: the note is a markdown document, so writing
    // one gets the full editor rather than a single-line prompt.
    const note = await store.create(
      {
        file,
        line: position.line,
        character: position.character,
        body: ''
      },
      target
    );
    if (!note) {
      void vscode.window.showWarningMessage(
        'Laxative: no note file is switched on. Run Laxative: Select Note Files.'
      );
      return;
    }
    annotations.refreshAll();
    await NoteDocuments.open(note);
    // Which file it landed in only matters when there is more than one.
    const where = store.enabledFiles().length > 1 ? ` Saved in ${note.store}.` : '';
    void vscode.window.setStatusBarMessage(
      'Laxative: first line becomes the title. Save to keep the note; close it empty to discard.' +
        where,
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

  // The search box sits on top of the Notes list, which is also its results.
  command('laxative.searchNotes', async () => {
    if (requireStore()) {
      await tree.focusSearch();
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

  command('laxative.clearSearch', () => tree.setSearch({}));

  command('laxative.collapseAll', () => tree.collapseAll());

  // Drives the search without the box, for tests and for anything scripted.
  command('laxative.setSearch', (arg: unknown) => {
    const { query, exclude } = (arg ?? {}) as { query?: string; exclude?: string };
    tree.setSearch({ query, exclude });
  });

  command('laxative.selectNoteFiles', async () => {
    if (requireStore()) {
      await selectNoteFiles(store);
    }
  });

  command('laxative.addNoteFile', async () => {
    if (requireStore()) {
      await addNoteFile(store);
    }
  });

  command('laxative.removeNoteFile', async () => {
    if (requireStore()) {
      await removeNoteFile(store);
    }
  });

  command('laxative.moveNoteToFile', async (arg: unknown) => {
    const note = await resolve(arg);
    if (!note) {
      return;
    }
    // Called with { id, target } there is nothing to ask about.
    const named = (arg as { target?: unknown } | undefined)?.target;
    if (typeof named === 'string') {
      if (await store.moveToFile(note.id, named)) {
        annotations.refreshAll();
      }
      return;
    }
    if (store.enabledFiles().length < 2) {
      void vscode.window.showInformationMessage(
        'Laxative: there is only one note file switched on, so there is nowhere to move it to.'
      );
      return;
    }
    const target = await pickNoteFile(store, {
      title: `Move "${note.title}" to`,
      placeHolder: 'The note keeps its id, so references to it still work',
      except: note.store
    });
    if (!target || !(await store.moveToFile(note.id, target))) {
      return;
    }
    annotations.refreshAll();
    void vscode.window.setStatusBarMessage(`Laxative: note moved to ${target}.`, 4000);
  });

  command('laxative.showDiagnostics', () => showDiagnostics(diagnostics));

  command('laxative._diagnostics', () => diagnostics.snapshot());

  // A window onto what the store currently holds, for the integration tests:
  // which notes are visible, and which file each of them came from.
  command('laxative._notes', () => ({
    notes: store.all().map((note) => ({ id: note.id, store: note.store, file: note.file })),
    visible: tree.visibleIds(),
    files: store.noteFiles(),
    rows: tree.rows(),
    enabled: store.enabledFiles().map((file) => file.name),
    target: store.defaultFile()
  }));

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
    if (!requireStore()) {
      return;
    }
    const name = await pickNoteFile(store, { title: 'Open which note file?' });
    const uri = name ? store.uriOf(name) : undefined;
    if (!uri) {
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
  command('laxative.groupByStore', () => tree.setGroupBy('store'));

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
