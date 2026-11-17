import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Annotations } from './annotations';
import { NotesView } from './notesView';
import { NotePanel } from './notePanel';
import { NoteDocuments } from './noteDocuments';
import {
  addNoteFile,
  configureStorage,
  deleteNoteFile,
  migrateLegacyFiles,
  pickNoteFile,
  renameNoteFile,
  selectNoteFiles
} from './storageSettings';
import { GraphView } from './graphView';
import { Diagnostics, showDiagnostics } from './diagnostics';
import { exportNotes, importNotes } from './portability';
import { Note } from './core/types';
import { located, noteAnchor } from './core/display';
import { tagIndex } from './core/tags';
import { AnchorTracker } from './tracking';
import { snapshotTimings } from './timing';
import { Snippet, snippetAt } from './core/anchoring';
import { allGroups, normalizeGroup, setGroup } from './core/groups';
import { insertImage, registerImageInput } from './assets';

/**
 * Asks which group to put notes in: the groups already used, a new one typed
 * into the box, or none. Undefined when dismissed; '' for no group.
 */
async function pickGroup(all: readonly Note[], notes: readonly Note[]): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { group: string };
  const counts = new Map<string, number>();
  for (const note of all) {
    for (const level of note.group ? allGroups([note]) : []) {
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
  }
  const current = new Set(notes.map((note) => note.group ?? ''));
  const existing: Item[] = allGroups(all).map((group) => ({
    label: `@${group}`,
    description: `${counts.get(group)} note${counts.get(group) === 1 ? '' : 's'}${
      current.size === 1 && current.has(group) ? ' · current' : ''
    }`,
    group
  }));
  const none: Item[] = notes.some((note) => note.group)
    ? [{ label: '$(close) No group', description: 'Take the @group off the first line', group: '' }]
    : [];
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = notes.length === 1 ? `Group for "${notes[0].title}"` : `Group for ${notes.length} notes`;
  pick.placeholder = 'Pick a group, or type a new one (use / for a group inside a group)';
  const refresh = () => {
    const typed = normalizeGroup(pick.value);
    const fresh: Item[] =
      typed && !existing.some((item) => item.group === typed)
        ? [{ label: `$(add) @${typed}`, description: 'New group', group: typed, alwaysShow: true }]
        : [];
    pick.items = [...fresh, ...existing, ...none];
  };
  refresh();
  pick.onDidChangeValue(refresh);
  const chosen = await new Promise<string | undefined>((done) => {
    pick.onDidAccept(() => done(pick.selectedItems[0]?.group));
    pick.onDidHide(() => done(undefined));
    pick.show();
  });
  pick.dispose();
  return chosen;
}

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

/** Kept so moves still waiting to be written are written when VS Code closes. */
let activeStore: NoteStore | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new NoteStore();
  activeStore = store;
  const annotations = new Annotations(store, context);
  const tree = new NotesView(store, context.extensionUri, context.workspaceState);
  const documents = new NoteDocuments(store);
  const diagnostics = new Diagnostics();
  const graph = new GraphView(store, context.extensionUri, diagnostics);
  // Before the store loads, so the first check, with its progress bar, runs.
  const tracker = new AnchorTracker(store);
  context.subscriptions.push(store, annotations, tree, documents, graph, tracker, ...registerImageInput());

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
        description: `${noteAnchor(note) ?? 'no location'}${
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
    // A note with no location points at nothing, so there is nowhere to go.
    if (!located(note)) {
      void vscode.window.setStatusBarMessage(
        `Laxative: "${note.title}" is not attached to a line of code.`,
        4000
      );
      return;
    }
    const uri = store.absoluteUri(note.file);
    if (!uri) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (note.lost) {
        // Its line number is from before the code went; open the file, but
        // don't pretend to know where in it.
        await vscode.window.showTextDocument(document, { preview: false });
        void vscode.window.showWarningMessage('Laxative: code not found.');
        return;
      }
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

  /**
   * Writes a new note and opens it for editing. `where` is the line it is
   * attached to, or nothing at all: a note with no location is a note about
   * the workspace rather than about a line in it, and everything else — the
   * list, the graph, references, hashtags, search — treats it the same.
   */
  const newNote = async (
    where: { file: string; line: number; character: number; snippet?: Snippet } | undefined,
    arg: unknown
  ): Promise<void> => {
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
    const note = await store.create({ ...where, body: '' }, target);
    if (!note) {
      void vscode.window.showWarningMessage(
        'Laxative: no note file is switched on. Run Laxative: Select Note Files.'
      );
      return;
    }
    annotations.refreshAll();
    await NoteDocuments.open(note);
    // Which file it landed in only matters when there is more than one.
    const which = store.enabledFiles().length > 1 ? ` Saved in ${note.store}.` : '';
    const attached = where ? '' : ' This one is not attached to any line of code.';
    void vscode.window.setStatusBarMessage(
      'Laxative: first line becomes the title. Save to keep the note; close it empty to discard.' +
        which +
        attached,
      6000
    );
  };

  command('laxative.addNote', async (arg: unknown) => {
    if (!requireStore()) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    // Adding a note that points nowhere has its own command now, so this one
    // says what it needs rather than quietly doing something else.
    if (!editor) {
      void vscode.window.showWarningMessage(
        'Laxative: put the cursor in a file first, or use Laxative: Add Note for a note about no particular line.'
      );
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
    // The code it is on, so the note can find it again after the file changes.
    const document = editor.document;
    const text = (line: number) =>
      line >= 0 && line < document.lineCount ? document.lineAt(line).text : '';
    const snippet = snippetAt([text(position.line - 1), text(position.line), text(position.line + 1)], 1);
    await newNote({ file, line: position.line, character: position.character, snippet }, arg);
  });

  /** A note about no particular line, wherever you are when you ask for it. */
  command('laxative.addLooseNote', async (arg: unknown) => {
    if (requireStore()) {
      await newNote(undefined, arg);
    }
  });

  command('laxative.openNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (note) {
      NotePanel.show(store, context.extensionUri, note.id, diagnostics);
    }
  });

  command('laxative.editNote', async (arg: unknown) => {
    const note = await resolve(arg);
    if (!note) {
      return;
    }
    // Reading this note? The editor takes the reading view's place rather
    // than opening beside it.
    const reading = NotePanel.columnShowing(note.id);
    const editor = await NoteDocuments.open(note, reading);
    if (editor && reading !== undefined) {
      NotePanel.close();
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
        { modal: true, detail: noteAnchor(note) ?? 'not attached to any line of code' },
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

  command('laxative.addNoteFile', async (arg: unknown) => {
    if (!requireStore()) {
      return;
    }
    const added = await addNoteFile(store, arg as { name?: unknown; path?: unknown } | undefined);
    if (added) {
      // A file you have just made is where your next note most likely belongs.
      await context.workspaceState.update('laxative.lastNoteFile', added);
    }
  });

  command('laxative.renameNoteFile', async (arg: unknown) => {
    if (requireStore()) {
      await renameNoteFile(store, arg as { name?: unknown; to?: unknown } | undefined);
    }
  });

  command('laxative.deleteNoteFile', async (arg: unknown) => {
    if (requireStore()) {
      await deleteNoteFile(store, arg as { name?: unknown } | undefined);
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

  /**
   * Puts notes in a group, by writing `@group` at the end of their first line.
   * Called with `{ ids }` from the graph's selection, `{ id }` or an id for one
   * note; with `group` as well (empty for none) there is nothing to ask.
   */
  command('laxative.moveToGroup', async (arg: unknown) => {
    const given = arg as { ids?: unknown; group?: unknown } | undefined;
    let notes: Note[];
    if (Array.isArray(given?.ids)) {
      notes = given.ids.map((id) => store.get(String(id))).filter((n): n is Note => n !== undefined);
    } else {
      const one = await resolve(arg);
      notes = one ? [one] : [];
    }
    if (notes.length === 0) {
      return;
    }
    const group =
      typeof given?.group === 'string'
        ? normalizeGroup(given.group)
        : await pickGroup(store.all(), notes);
    if (group === undefined) {
      return;
    }
    await store.updateBodies(notes.map((note) => ({ id: note.id, body: setGroup(note.body, group) })));
    const what = notes.length === 1 ? `"${notes[0].title}"` : `${notes.length} notes`;
    void vscode.window.setStatusBarMessage(
      group ? `Laxative: ${what} moved to @${group}.` : `Laxative: ${what} taken out of its group.`,
      4000
    );
  });

  command('laxative.insertImage', () => insertImage());

  command('laxative.showDiagnostics', () => {
    diagnostics.record('laxative', {
      version: String(context.extension.packageJSON?.version ?? 'unknown'),
      window: vscode.env.remoteName ? `remote (${vscode.env.remoteName})` : 'local'
    });
    diagnostics.record('file icons', tree.iconReport() as unknown as Record<string, unknown>);
    return showDiagnostics(diagnostics);
  });

  command('laxative._diagnostics', () => ({
    ...diagnostics.snapshot(),
    version: String(context.extension.packageJSON?.version ?? 'unknown'),
    remote: vscode.env.remoteName ?? null,
    icons: tree.iconReport(),
    timings: snapshotTimings()
  }));

  // Where the gutter and inline marks were last drawn, for the integration
  // tests: the API gives no way to read a decoration back out of an editor.
  command('laxative._marks', () => {
    const editor = vscode.window.activeTextEditor;
    return editor ? annotations.marks(editor.document) : undefined;
  });

  // Checks where notes are, for the integration tests and for measuring: one
  // file when given one, else every file with notes.
  command('laxative._checkAnchors', (arg: unknown) => {
    const file = (arg as { file?: unknown } | undefined)?.file;
    return typeof file === 'string' ? tracker.checkFiles([file]) : tracker.checkAll();
  });

  // How long the graph takes to draw at each zoom level, for the performance test.
  command('laxative._graphBenchmark', (scales: unknown) =>
    graph.benchmark(Array.isArray(scales) ? scales.map(Number) : [0.2, 0.5, 1, 2])
  );

  // Opens and closes groups in the graph, for the integration tests.
  command('laxative._graphGroups', (arg: unknown) => {
    const action = arg as { action?: unknown; path?: unknown; mode?: unknown } | undefined;
    graph.groups({
      action: String(action?.action ?? ''),
      path: typeof action?.path === 'string' ? action.path : undefined,
      mode: typeof action?.mode === 'string' ? action.mode : undefined
    });
  });

  // Runs the one-time clean-up of the old settings, for the integration tests.
  command('laxative._migrate', () => migrateLegacyFiles(store));

  // A window onto what the store currently holds, for the integration tests:
  // which notes are visible, and which file each of them came from.
  command('laxative._notes', () => ({
    notes: store.all().map((note) => ({
      id: note.id,
      store: note.store,
      file: note.file,
      line: note.line,
      lost: note.lost === true,
      title: note.title,
      group: note.group ?? null
    })),
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

  command('laxative.export', async (arg: unknown) => {
    if (requireStore()) {
      await exportNotes(store, arg as { uri?: unknown; format?: unknown } | undefined);
    }
  });

  command('laxative.import', async (arg: unknown) => {
    if (requireStore()) {
      await importNotes(store, arg as { uri?: unknown; mode?: unknown; split?: unknown } | undefined);
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

  void store
    .initialize()
    .then(() => annotations.refreshAll())
    // Note files used to be listed in settings; the folder is the list now.
    .then(() => migrateLegacyFiles(store));
}

export function deactivate(): Promise<void> | undefined {
  // Everything else goes with context.subscriptions.
  return activeStore?.writeMoves(true);
}
