import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { Note } from '../../core/types';
import { serialize } from '../../core/schema';

// Derived, not hard-coded: setting a real `publisher` before publishing changes
// the extension's id, and that must not break the tests.
const manifest = require('../../../package.json') as { publisher: string; name: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace must be open');
  return folder.uri;
}

const storeUri = () => vscode.Uri.joinPath(workspaceRoot(), '.laxative', 'notes.json');
const appUri = () => vscode.Uri.joinPath(workspaceRoot(), 'src', 'app.ts');

function makeNote(overrides: Partial<Note> = {}): Note {
  const now = new Date().toISOString();
  return {
    id: 'note0001',
    title: 'Race with the cache warmer',
    body: 'Race with the cache warmer\n\nThis **retries** silently.',
    file: 'src/app.ts',
    line: 1,
    character: 8,
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function writeStore(notes: Note[]): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot(), '.laxative'));
  await vscode.workspace.fs.writeFile(storeUri(), new TextEncoder().encode(serialize(notes)));
  await vscode.commands.executeCommand('laxative.refresh');
}

async function readStore(): Promise<Note[]> {
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(storeUri()));
  return JSON.parse(text).notes as Note[];
}

/**
 * Saving a file kicks off an asynchronous re-anchor that writes the store.
 * Waiting for those writes to stop keeps one test's tail from landing in the
 * middle of the next one.
 */
/** What the webviews report they actually put on screen. */
async function renderReport(): Promise<Record<string, any>> {
  return (await vscode.commands.executeCommand<Record<string, any>>('laxative._diagnostics')) ?? {};
}

async function settle(): Promise<void> {
  let previous = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = JSON.stringify(await tryReadStore());
    if (attempt > 0 && current === previous) {
      return;
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Polling helper: treats an unreadable file as "not there yet". */
async function tryReadStore(): Promise<Note[] | undefined> {
  try {
    return await readStore();
  } catch {
    return undefined;
  }
}

async function waitFor<T>(
  probe: () => Thenable<T | undefined> | T | undefined,
  what: string
): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await probe();
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('Laxative extension', function () {
  this.timeout(60000);

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
    await extension.activate();
    assert.ok(extension.isActive, 'extension should activate');
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await settle();
  });

  it('contributes rebindable keyboard shortcuts for adding and searching', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const keybindings = extension?.packageJSON?.contributes?.keybindings as
      | { command: string; key: string }[]
      | undefined;
    assert.ok(keybindings, 'keybindings are contributed');
    const bound = new Map(keybindings.map((binding) => [binding.command, binding.key]));
    assert.strictEqual(bound.get('laxative.addNote'), 'ctrl+alt+m');
    assert.strictEqual(bound.get('laxative.searchNotes'), 'ctrl+alt+shift+m');
    assert.strictEqual(bound.get('laxative.showGraph'), 'ctrl+alt+g');
    assert.strictEqual(
      bound.get('workbench.view.extension.laxativeGraph'),
      'ctrl+alt+g',
      'the panel tab shows the shortcut of the command that opens it, so that has the key too'
    );
    assert.ok(bound.has('laxative.notesAtCursor'));
    for (const binding of keybindings) {
      const mac = (binding as { mac?: string }).mac;
      assert.ok(mac && mac.startsWith('cmd+'), `${binding.command} has a mac binding`);
    }
  });

  it('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const name of [
      'laxative.addNote',
      'laxative.openNote',
      'laxative.editNote',
      'laxative.deleteNote',
      'laxative.revealNote',
      'laxative.searchNotes',
      'laxative.copyReference',
      'laxative.showGraph',
      'laxative.export',
      'laxative.import',
      'laxative.openStoreFile',
      'laxative.refresh'
    ]) {
      assert.ok(commands.includes(name), `${name} should be registered`);
    }
  });

  it('shows a CodeLens on the annotated line without changing the source file', async () => {
    const before = new TextDecoder().decode(await vscode.workspace.fs.readFile(appUri()));
    await writeStore([makeNote()]);
    const document = await vscode.workspace.openTextDocument(appUri());
    await vscode.window.showTextDocument(document);

    const lenses = await waitFor(
      () =>
        vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          appUri()
        ),
      'the CodeLens to appear'
    );
    const mine = lenses.filter((lens) => lens.command?.command === 'laxative.openNote');
    assert.strictEqual(mine.length, 1, 'exactly one note lens');
    assert.strictEqual(mine[0].range.start.line, 1, 'lens sits on the annotated line');
    assert.strictEqual(
      mine[0].command!.title,
      'Race with the cache warmer',
      'the lens is plain text: the gutter bubble is the only icon on the line'
    );
    assert.ok(
      !mine[0].command!.title.includes('$('),
      'no codicon in the lens, which would be a second icon beside the gutter one'
    );

    const after = new TextDecoder().decode(await vscode.workspace.fs.readFile(appUri()));
    assert.strictEqual(after, before, 'annotating must never modify the source file');
  });

  it('copies a reference token for a note', async () => {
    await writeStore([makeNote()]);
    await vscode.commands.executeCommand('laxative.copyReference', 'note0001');
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      '[[note0001|Race with the cache warmer]]'
    );
  });

  it('opens the store file on request', async () => {
    await writeStore([makeNote()]);
    await vscode.commands.executeCommand('laxative.openStoreFile');
    const active = await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.fsPath,
      'the store file to open'
    );
    assert.strictEqual(active, storeUri().fsPath);
  });

  it('reveals a note by putting the cursor at its line and character', async () => {
    await writeStore([makeNote({ line: 6, character: 5 })]);
    await vscode.commands.executeCommand('laxative.revealNote', 'note0001');
    const editor = await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath === appUri().fsPath
          ? vscode.window.activeTextEditor
          : undefined,
      'the annotated file to open'
    );
    assert.strictEqual(editor.selection.active.line, 6);
    assert.strictEqual(editor.selection.active.character, 5, 'lands on the exact column');
  });

  it('clamps a note whose column is past the end of a shortened line', async () => {
    await writeStore([makeNote({ line: 4, character: 200 })]);
    await vscode.commands.executeCommand('laxative.revealNote', 'note0001');
    const editor = await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath === appUri().fsPath
          ? vscode.window.activeTextEditor
          : undefined,
      'the annotated file to open'
    );
    assert.strictEqual(editor.selection.active.line, 4);
    assert.strictEqual(
      editor.selection.active.character,
      editor.document.lineAt(4).range.end.character
    );
  });

  it('records the exact line and character the cursor was on', async () => {
    await writeStore([]);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const document = await vscode.workspace.openTextDocument(appUri());
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(2, 9, 2, 9);
    await vscode.commands.executeCommand('laxative.addNote');

    const notes = await waitFor(async () => {
      const current = await tryReadStore();
      return current?.length === 1 ? current : undefined;
    }, 'the note to be stored');
    assert.strictEqual(notes[0].line, 2);
    assert.strictEqual(notes[0].character, 9);
    assert.ok(!('snippet' in notes[0]), 'no copy of the annotated code is stored');
  });

  it('derives hashtags from the body when the note is saved', async () => {
    await writeStore([]);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const document = await vscode.workspace.openTextDocument(appUri());
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('laxative.addNote');
    const noteEditor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'laxative'),
      'the note editor'
    );
    await noteEditor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), 'Warmer race #perf #bug')
    );
    await noteEditor.document.save();
    await settle();

    const notes = await readStore();
    assert.deepStrictEqual(notes[0].tags, ['perf', 'bug']);
  });

  it('switches the notes view between file and hashtag grouping', async () => {
    await writeStore([
      makeNote({ id: 'tagged01', body: 'One #perf' }),
      makeNote({ id: 'tagged02', file: 'src/other.ts', body: 'Two #perf #bug' })
    ]);
    await vscode.commands.executeCommand('laxative.groupByTag');
    await vscode.commands.executeCommand('laxative.filterByTag', 'perf');
    await vscode.commands.executeCommand('laxative.clearTagFilter');
    await vscode.commands.executeCommand('laxative.groupByFile');
    // Reaching here without a rejected promise means the view rebuilt cleanly
    // in both modes; the tree contents themselves are covered by unit tests.
    assert.ok(true);
  });

  it('actually renders the note markdown in the panel', async () => {
    await writeStore([
      makeNote({ body: 'Warmer race\n\nSome **bold** text and a [link](https://x.dev).' })
    ]);
    await vscode.commands.executeCommand('laxative.openNote', 'note0001');

    // The webview reports what it put on screen, so this fails if the script is
    // blocked, the message is lost, or the body renders empty.
    const report = await waitFor(async () => {
      const panel = (await renderReport()).notePanel;
      return panel?.bytes > 0 ? panel : undefined;
    }, 'the note panel to report a render');

    assert.strictEqual(report.empty, false, 'the note is not rendered as empty');
    assert.strictEqual(report.title, 'Warmer race');
    assert.ok(report.bytes > 200, `rendered markup looks substantial (${report.bytes} bytes)`);
  });

  it('paints the note graph in the panel area', async () => {
    await writeStore([
      makeNote({ id: 'graphaa1', body: 'One, links to [[graphbb2]]' }),
      makeNote({ id: 'graphbb2', file: 'src/other.ts', body: 'Two' })
    ]);
    await vscode.commands.executeCommand('laxative.showGraph');

    const report = await waitFor(async () => {
      const painted = (await renderReport()).graph;
      return painted?.nodes === 2 ? painted : undefined;
    }, 'the graph to report a paint');

    assert.strictEqual(report.nodes, 2);
    assert.strictEqual(report.edges, 1, 'the reference between them is drawn');
    assert.ok(report.width > 0 && report.height > 0, 'the canvas has a real drawing surface');
  });

  it('rings the note you have open in the graph', async () => {
    await writeStore([
      makeNote({ id: 'ringaaa1', body: 'One, links to [[ringbbb2]]' }),
      makeNote({ id: 'ringbbb2', file: 'src/other.ts', body: 'Two' })
    ]);
    await vscode.commands.executeCommand('laxative.showGraph');
    await waitFor(async () => ((await renderReport()).graph?.nodes === 2 ? true : undefined), 'the graph');

    await vscode.commands.executeCommand('laxative.openNote', 'ringbbb2');
    await waitFor(
      async () => ((await renderReport()).graph?.focus === 'ringbbb2' ? true : undefined),
      'the open note to be ringed'
    );

    // The panel is already open now, so only the panel saying what it shows
    // can move the ring: nothing about the panel's visibility changes.
    await vscode.commands.executeCommand('laxative.openNote', 'ringaaa1');
    await waitFor(
      async () => ((await renderReport()).graph?.focus === 'ringaaa1' ? true : undefined),
      'the ring to follow the reading panel to another note'
    );

    await vscode.commands.executeCommand('laxative.editNote', 'ringbbb2');
    await waitFor(
      async () => ((await renderReport()).graph?.focus === 'ringbbb2' ? true : undefined),
      'the ring to follow the note being edited'
    );

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(
      async () => ((await renderReport()).graph?.focus === null ? true : undefined),
      'the ring to go once no note is open'
    );
  });

  it('registers the graph as a view rather than an editor tab', () => {
    const views = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.contributes?.views;
    const graphViews = views?.laxativeGraph as { id: string; type: string }[] | undefined;
    assert.ok(graphViews, 'the graph lives in its own panel container');
    assert.strictEqual(graphViews[0].id, 'laxative.graphView');
    assert.strictEqual(graphViews[0].type, 'webview');
  });

  it('keeps the store file sorted and parseable after edits', async () => {
    await writeStore([
      makeNote({ id: 'zzzz9999', file: 'src/zeta.ts', line: 0 }),
      makeNote({ id: 'note0001', file: 'src/app.ts', line: 1 })
    ]);
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(storeUri()));
    assert.ok(text.indexOf('src/app.ts') < text.indexOf('src/zeta.ts'), 'sorted by file path');
    assert.strictEqual(JSON.parse(text).version, 1);
  });

  it('stores notes at a path the workspace can commit to git', async () => {
    await writeStore([makeNote()]);
    const relative = path.relative(workspaceRoot().fsPath, storeUri().fsPath);
    assert.strictEqual(relative.split(path.sep).join('/'), '.laxative/notes.json');
    const stat = await vscode.workspace.fs.stat(storeUri());
    assert.ok(stat.size > 0, 'the store file exists on disk');
  });

  describe('writing a note', () => {
    async function addNoteAtLine(line: number, character = 0): Promise<vscode.TextEditor> {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const document = await vscode.workspace.openTextDocument(appUri());
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(line, character, line, character);
      await vscode.commands.executeCommand('laxative.addNote');
      return waitFor(
        () =>
          vscode.window.visibleTextEditors.find(
            (candidate) => candidate.document.uri.scheme === 'laxative'
          ),
        'the note editor to open'
      );
    }

    it('opens a real, writable editor instead of an input box', async () => {
      await writeStore([]);
      const noteEditor = await addNoteAtLine(1);
      const document = noteEditor.document;

      assert.strictEqual(document.uri.scheme, 'laxative');
      assert.strictEqual(document.languageId, 'markdown', 'notes are markdown documents');
      assert.strictEqual(document.isUntitled, false);
      assert.strictEqual(document.getText(), '', 'a new note starts empty');

      // The decisive check: ordinary edits apply, which a webview textarea was
      // not able to offer.
      const applied = await noteEditor.edit((builder) => {
        builder.insert(new vscode.Position(0, 0), 'Cache warmer race\n\nTwo **lines** #bug #perf');
      });
      assert.ok(applied, 'the document accepts edits');
      assert.ok(document.isDirty, 'edits mark it dirty like any file');

      await document.save();
      const notes = await waitFor(async () => {
        const current = await tryReadStore();
        return current?.[0]?.body ? current : undefined;
      }, 'the note body to be saved');

      assert.strictEqual(notes.length, 1);
      assert.match(notes[0].body, /Two \*\*lines\*\*/);
      assert.strictEqual(notes[0].title, 'Cache warmer race', 'title comes from the first line');
      assert.deepStrictEqual(notes[0].tags, ['bug', 'perf']);
      assert.strictEqual(notes[0].line, 1, 'anchored where the cursor was');
    });

    it('names the tab after the code while empty, and after the first line once written', async () => {
      await writeStore([]);
      const noteEditor = await addNoteAtLine(1);
      assert.match(noteEditor.document.uri.path, /^\/app\.ts-2\.md$/);

      await noteEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), '# Warmer notes'));
      await noteEditor.document.save();
      await settle();

      assert.strictEqual(
        vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'laxative').length,
        1,
        'the editor is left alone while it is being written in'
      );

      const id = (await readStore())[0].id;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await settle();
      await vscode.commands.executeCommand('laxative.editNote', id);
      const reopened = await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'laxative'),
        'the note to reopen'
      );
      assert.strictEqual(reopened.document.uri.path, '/Warmer notes.md');
      assert.strictEqual(reopened.document.getText(), '# Warmer notes');
    });

    it('discards a note that is closed without any content', async () => {
      await writeStore([]);
      await addNoteAtLine(3);
      assert.strictEqual((await readStore()).length, 1, 'the placeholder note exists');

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor(async () => {
        const current = await tryReadStore();
        return current?.length === 0 ? 'discarded' : undefined;
      }, 'the empty note to be discarded');
      assert.deepStrictEqual(await readStore(), []);
    });

    it('shows the note again, rendered, when it is reopened', async () => {
      await writeStore([]);
      const noteEditor = await addNoteAtLine(1);
      await noteEditor.edit((builder) =>
        builder.insert(new vscode.Position(0, 0), 'Warmer race\n\nSome **bold** text.')
      );
      await noteEditor.document.save();
      await settle();

      const stored = await readStore();
      assert.match(stored[0].body, /Some \*\*bold\*\* text\./, 'the body reached the store');

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('laxative.openNote', stored[0].id);

      const report = await waitFor(async () => {
        const panel = (await renderReport()).notePanel;
        return panel?.title === 'Warmer race' ? panel : undefined;
      }, 'the reopened note to render');
      assert.strictEqual(report.empty, false, 'reopening shows content, not a blank note');
      assert.ok(report.bytes > 200);
    });

    it('never closes and reopens the editor while the note is being written', async () => {
      await writeStore([]);
      const noteEditor = await addNoteAtLine(1);
      const uri = noteEditor.document.uri.toString();

      const noteTabs = () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .filter((tab) => (tab.input as { uri?: vscode.Uri })?.uri?.scheme === 'laxative');
      assert.strictEqual(noteTabs().length, 1);

      for (const text of ['First title', '\n\nmore', '\n\nand more']) {
        await noteEditor.edit((builder) =>
          builder.insert(
            noteEditor.document.lineAt(noteEditor.document.lineCount - 1).range.end,
            text
          )
        );
        await noteEditor.document.save();
        await settle();
      }

      const tabs = noteTabs();
      assert.strictEqual(tabs.length, 1, 'still exactly one note tab');
      assert.strictEqual(
        (tabs[0].input as { uri: vscode.Uri }).uri.toString(),
        uri,
        'the same document stayed open across saves'
      );
    });

    it('previews unsaved edits in the reading panel', async () => {
      await writeStore([]);
      const noteEditor = await addNoteAtLine(1);
      await noteEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'Saved title'));
      await noteEditor.document.save();
      await settle();
      await vscode.commands.executeCommand('laxative.openNote', (await readStore())[0].id);

      // Typed, deliberately not saved.
      await noteEditor.edit((builder) =>
        builder.replace(new vscode.Range(0, 0, 0, 11), 'Live title')
      );
      const report = await waitFor(async () => {
        const panel = (await renderReport()).notePanel;
        return panel?.title === 'Live title' ? panel : undefined;
      }, 'the panel to follow unsaved edits');
      assert.strictEqual(report.title, 'Live title');
      assert.strictEqual((await readStore())[0].title, 'Saved title', 'the store is untouched');
    });

    it('suggests other notes after [[ and known hashtags after #', async () => {
      await writeStore([
        makeNote({
          id: 'target01',
          title: 'Eviction path',
          body: 'Eviction path #perf',
          file: 'src/app.ts',
          line: 6,
          character: 2
        })
      ]);
      const noteEditor = await addNoteAtLine(1);
      await noteEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'see [['));

      const refs = await waitFor(
        async () =>
          (
            await vscode.commands.executeCommand<vscode.CompletionList>(
              'vscode.executeCompletionItemProvider',
              noteEditor.document.uri,
              new vscode.Position(0, 6)
            )
          )?.items,
        'reference completions'
      );
      const target = refs.find((item) => item.label === 'Eviction path');
      assert.ok(target, 'the other note is offered');
      assert.strictEqual(target.insertText, '[[target01|Eviction path]]');
      assert.strictEqual(target.detail, 'src/app.ts:7');

      await noteEditor.edit((builder) => {
        builder.replace(new vscode.Range(0, 0, 0, 6), 'tagged #');
      });
      const tags = await waitFor(
        async () =>
          (
            await vscode.commands.executeCommand<vscode.CompletionList>(
              'vscode.executeCompletionItemProvider',
              noteEditor.document.uri,
              new vscode.Position(0, 8)
            )
          )?.items,
        'hashtag completions'
      );
      assert.ok(
        tags.some((item) => item.label === '#perf'),
        'a hashtag already in use is offered'
      );
    });
  });

  describe('storage settings', () => {
    it('takes its note files from the folder, with no list to keep in step', async () => {
      // Dropped in by hand, by a teammate or by a git pull: it is simply there.
      const put = vscode.Uri.joinPath(workspaceRoot(), '.laxative', 'from-a-pull.json');
      await vscode.workspace.fs.writeFile(put, new TextEncoder().encode(serialize([])));
      await vscode.commands.executeCommand('laxative.refresh');

      const files = await waitFor(async () => {
        const listed = (await vscode.commands.executeCommand('laxative._notes')) as {
          files: { name: string; path: string }[];
        };
        return listed.files.some((file) => file.name === 'from-a-pull') ? listed.files : undefined;
      }, 'the file that appeared in the folder');
      assert.deepStrictEqual(
        files.find((file) => file.name === 'from-a-pull')?.path,
        '.laxative/from-a-pull.json'
      );
      assert.strictEqual(
        vscode.workspace.getConfiguration('laxative').get('activeNoteFiles')?.toString(),
        '',
        'and nothing was written to settings to make that happen'
      );

      await vscode.workspace.fs.delete(put, { useTrash: false });
      await vscode.commands.executeCommand('laxative.refresh');
      const after = (await vscode.commands.executeCommand('laxative._notes')) as {
        files: { name: string }[];
      };
      assert.ok(
        !after.files.some((file) => file.name === 'from-a-pull'),
        'and deleting the file is all it takes to be rid of it'
      );
    });

    it('clears the old list of note files, now that the folder is the list', async () => {
      const config = vscode.workspace.getConfiguration('laxative');
      await config.update(
        'noteFiles',
        [{ name: 'whatever', path: '.laxative/notes.json', enabled: true }],
        vscode.ConfigurationTarget.Workspace
      );
      await vscode.commands.executeCommand('laxative._migrate');

      const cleared = await waitFor(
        () => {
          const listed = vscode.workspace
            .getConfiguration('laxative')
            .get<unknown[]>('noteFiles', []);
          return listed.length === 0 ? true : undefined;
        },
        'the old setting to be cleared'
      );
      assert.ok(cleared, 'nothing is left to keep in step with the folder');
      const still = (await vscode.commands.executeCommand('laxative._notes')) as {
        files: { name: string }[];
      };
      assert.ok(
        still.files.some((file) => file.name === 'notes'),
        'and the notes that file held are still there, found by looking'
      );
    });

    it('says why the rows are plain when the icon theme cannot be reached', async () => {
      // What a WSL or SSH window looks like from in here: the icon theme is
      // installed on the local side, and this extension host cannot see it.
      // No icons are drawn in its place; the report is how you find out why.
      const workbench = vscode.workspace.getConfiguration('workbench');
      const before = workbench.get<string | null>('iconTheme');
      await workbench.update(
        'iconTheme',
        'theme-from-another-machine',
        vscode.ConfigurationTarget.Workspace
      );
      try {
        const report = await waitFor(async () => {
          const icons = (
            (await vscode.commands.executeCommand('laxative._diagnostics')) as {
              icons: {
                wanted: string | null;
                found: boolean;
                problem?: string;
                available?: string[];
              };
            }
          ).icons;
          // Settled, not merely started: the report is published in one go.
          return icons.wanted === 'theme-from-another-machine' && icons.available
            ? icons
            : undefined;
        }, 'the icon theme report');

        assert.strictEqual(report.found, false, 'no other theme stands in for it');
        assert.match(
          report.problem ?? '',
          /No installed extension contributes/,
          'and it says why the one asked for was not used'
        );
        assert.ok(
          Array.isArray(report.available),
          `with the themes this host can see: ${JSON.stringify(report.available)}`
        );
      } finally {
        await workbench.update(
          'iconTheme',
          before ?? undefined,
          vscode.ConfigurationTarget.Workspace
        );
      }
    });

    it('registers the storage configuration command', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('laxative.configureStorage'));
    });
  });

  describe('the notes list', () => {
    const rows = async (): Promise<{ id: string; label: string; group?: string }[]> =>
      ((await vscode.commands.executeCommand('laxative._notes')) as {
        rows: { id: string; label: string; group?: string }[];
      }).rows;

    afterEach(async () => {
      await vscode.commands.executeCommand('laxative.groupByFile');
    });

    it('gives every row its own id, including a note filed under two hashtags', async () => {
      // A note with two hashtags is drawn under both, and a tree that is handed
      // the same id twice does not render reliably.
      await writeStore([
        makeNote({ id: 'twotag01', title: 'Both', body: 'Both #bug #perf' }),
        makeNote({ id: 'onetag01', title: 'One', body: 'One #bug', line: 3 })
      ]);
      await vscode.commands.executeCommand('laxative.groupByTag');

      const drawn = await rows();
      const ids = drawn.map((row) => row.id);
      assert.deepStrictEqual(
        [...new Set(ids)].length,
        ids.length,
        `every row has its own id: ${ids.join(', ')}`
      );
      const both = drawn.filter((row) => row.label === 'Both');
      assert.deepStrictEqual(
        both.map((row) => row.group).sort(),
        ['#bug', '#perf'],
        'and the note really is drawn under both of its hashtags'
      );
    });

    it('keeps the notes of a file in the order they appear in it', async () => {
      await writeStore([
        makeNote({ id: 'order003', title: 'Third', line: 30 }),
        makeNote({ id: 'order001', title: 'First', line: 1 }),
        makeNote({ id: 'order002', title: 'Second', line: 8 })
      ]);
      const listed = (await rows()).filter((row) => row.group).map((row) => row.label);
      assert.deepStrictEqual(listed, ['First', 'Second', 'Third']);
    });
  });

  describe('searching', () => {
    const visible = async (): Promise<string[]> =>
      ((await vscode.commands.executeCommand('laxative._notes')) as { visible: string[] }).visible;
    const setSearch = (query: string, exclude?: string) =>
      vscode.commands.executeCommand('laxative.setSearch', { query, exclude });

    beforeEach(async () => {
      // Titles as well as bodies: makeNote's default title mentions the cache,
      // which would match every search for it.
      await writeStore([
        makeNote({
          id: 'srch0001',
          title: 'Cache warmer race',
          body: 'Cache warmer race',
          file: 'src/app.ts'
        }),
        makeNote({
          id: 'srch0002',
          title: 'Cache eviction',
          body: 'Cache eviction, covered by a test',
          file: 'test/app.test.ts'
        }),
        makeNote({
          id: 'srch0003',
          title: 'Parsing the header',
          body: 'Parsing the header #wip',
          file: 'src/other.ts'
        })
      ]);
    });

    afterEach(async () => {
      await vscode.commands.executeCommand('laxative.clearSearch');
    });

    it('narrows the Notes list instead of opening a list of its own', async () => {
      assert.deepStrictEqual((await visible()).sort(), ['srch0001', 'srch0002', 'srch0003']);

      await setSearch('cache');
      assert.deepStrictEqual(
        (await visible()).sort(),
        ['srch0001', 'srch0002'],
        'the list shows what the search matched'
      );

      await setSearch('cache', 'test');
      assert.deepStrictEqual(
        await visible(),
        ['srch0001'],
        'and the exclude box takes the test file back out'
      );

      await setSearch('cache -test');
      assert.deepStrictEqual(
        await visible(),
        ['srch0001'],
        'a minus in the search itself excludes too, so one box can do both'
      );

      await setSearch('', '#wip');
      assert.deepStrictEqual(
        (await visible()).sort(),
        ['srch0001', 'srch0002'],
        'excluding on its own is a search too'
      );

      await vscode.commands.executeCommand('laxative.clearSearch');
      assert.strictEqual((await visible()).length, 3, 'clearing brings the whole list back');
    });

    it('searches the body, the path and the hashtags, not just titles', async () => {
      await setSearch('other.ts');
      assert.deepStrictEqual(await visible(), ['srch0003'], 'by path');

      await setSearch('#wip');
      assert.deepStrictEqual(await visible(), ['srch0003'], 'by hashtag');

      await setSearch('header');
      assert.deepStrictEqual(await visible(), ['srch0003'], 'by body');
    });
  });

  describe('several note files', () => {
    const TEAM = ['.laxative', 'team.json'] as const;
    const PRIVATE = ['.laxative', 'private.json'] as const;
    const uriOf = (parts: readonly string[]) => vscode.Uri.joinPath(workspaceRoot(), ...parts);

    /** What the store currently holds, and where each note came from. */
    async function state(): Promise<{
      notes: { id: string; store?: string; file: string }[];
      enabled: string[];
      target?: string;
    }> {
      return (await vscode.commands.executeCommand('laxative._notes')) as any;
    }

    async function writeNotes(parts: readonly string[], notes: Note[]): Promise<void> {
      await vscode.workspace.fs.createDirectory(uriOf([parts[0]]));
      await vscode.workspace.fs.writeFile(uriOf(parts), new TextEncoder().encode(serialize(notes)));
    }

    /** Which of the files in the folder are shown; nothing means all of them. */
    async function useFiles(active?: string[], defaultFile?: string): Promise<void> {
      const config = vscode.workspace.getConfiguration('laxative');
      await config.update('activeNoteFiles', active, vscode.ConfigurationTarget.Workspace);
      await config.update('defaultNoteFile', defaultFile, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('laxative.refresh');
    }

    beforeEach(async () => {
      // The folder is the list, so the file every other test uses would be a
      // third note file here.
      await vscode.workspace.fs.delete(storeUri(), { useTrash: false }).then(
        () => undefined,
        () => undefined
      );
      await writeNotes(TEAM, [
        makeNote({ id: 'teamaaa1', body: 'Team one' }),
        makeNote({ id: 'teamaaa2', body: 'Team two', line: 4 })
      ]);
      await writeNotes(PRIVATE, [
        makeNote({ id: 'privbbb1', body: 'Private one', file: 'src/other.ts' })
      ]);
    });

    afterEach(async () => {
      await useFiles(undefined, undefined);
      await vscode.workspace
        .getConfiguration('laxative')
        .update('askWhichNoteFile', undefined, vscode.ConfigurationTarget.Workspace);
      for (const parts of [TEAM, PRIVATE]) {
        await vscode.workspace.fs.delete(uriOf(parts), { useTrash: false }).then(
          () => undefined,
          () => undefined
        );
      }
      // Put back the file the rest of the tests work with.
      await writeStore([]);
    });

    it('shows the notes from every file that is switched on', async () => {
      await useFiles();
      const all = await waitFor(
        async () => ((await state()).notes.length === 3 ? await state() : undefined),
        'notes from both files'
      );
      assert.deepStrictEqual(
        all.notes.map((n) => `${n.id}:${n.store}`).sort(),
        ['privbbb1:private', 'teamaaa1:team', 'teamaaa2:team'],
        'each note knows which file it came from'
      );
      assert.deepStrictEqual(all.enabled, ['private', 'team'], 'in the folder\'s order');

      // Switching one off takes its notes out of everything at once.
      await useFiles(['team']);
      const left = await waitFor(
        async () => ((await state()).notes.length === 2 ? await state() : undefined),
        'only the team notes'
      );
      assert.deepStrictEqual(left.enabled, ['team']);
      assert.ok(left.notes.every((n) => n.store === 'team'));
    });

    it('puts a new note in the note file it is told to', async () => {
      // With several files on, adding a note asks which one it belongs to. The
      // same choice can be passed straight in, which is what a prompt cannot
      // be driven to do from here.
      await useFiles(undefined, 'private');
      await waitFor(
        async () => ((await state()).notes.length === 3 ? true : undefined),
        'both files loaded'
      );
      const document = await vscode.workspace.openTextDocument(appUri());
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(3, 0, 3, 0);

      await vscode.commands.executeCommand('laxative.addNote', { target: 'team' });
      const added = await waitFor(
        async () => ((await state()).notes.length === 4 ? await state() : undefined),
        'the new note'
      );
      const fresh = added.notes.find((n) => !['teamaaa1', 'teamaaa2', 'privbbb1'].includes(n.id));
      assert.strictEqual(fresh?.store, 'team', 'it went where it was sent, not to the default');

      await vscode.commands.executeCommand('laxative.addNote', { target: 'nowhere' });
      assert.strictEqual((await state()).notes.length, 4, 'a file that is not on gets no note');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('writes a new note to the default file and leaves the other alone', async () => {
      // Not asking is a setting; then the default file takes every new note.
      await vscode.workspace
        .getConfiguration('laxative')
        .update('askWhichNoteFile', false, vscode.ConfigurationTarget.Workspace);
      await useFiles(undefined, 'private');
      await waitFor(
        async () => ((await state()).target === 'private' ? true : undefined),
        'private to be the target'
      );
      const before = (await vscode.workspace.fs.stat(uriOf(TEAM))).size;

      const document = await vscode.workspace.openTextDocument(appUri());
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(2, 0, 2, 0);
      await vscode.commands.executeCommand('laxative.addNote');

      const added = await waitFor(
        async () => ((await state()).notes.length === 4 ? await state() : undefined),
        'the new note'
      );
      const fresh = added.notes.find((n) => !['teamaaa1', 'teamaaa2', 'privbbb1'].includes(n.id));
      assert.strictEqual(fresh?.store, 'private', 'the new note went to the default file');
      assert.strictEqual(
        (await vscode.workspace.fs.stat(uriOf(TEAM))).size,
        before,
        'the other file was not rewritten'
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('sends a deletion back to the file the note came from', async () => {
      await useFiles();
      await waitFor(
        async () => ((await state()).notes.length === 3 ? true : undefined),
        'both files loaded'
      );
      const privateBefore = (await vscode.workspace.fs.stat(uriOf(PRIVATE))).size;

      await vscode.workspace
        .getConfiguration('laxative')
        .update('confirmDelete', false, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('laxative.deleteNote', 'teamaaa1');

      await waitFor(
        async () => ((await state()).notes.length === 2 ? true : undefined),
        'the note to go'
      );
      const team = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uriOf(TEAM))));
      assert.deepStrictEqual(team.notes.map((n: Note) => n.id), ['teamaaa2']);
      assert.strictEqual(
        (await vscode.workspace.fs.stat(uriOf(PRIVATE))).size,
        privateBefore,
        'the file it was not in is untouched'
      );
      await vscode.workspace
        .getConfiguration('laxative')
        .update('confirmDelete', undefined, vscode.ConfigurationTarget.Workspace);
    });

    it('moves a note to another file, keeping its id so references survive', async () => {
      await useFiles();
      await waitFor(
        async () => ((await state()).notes.length === 3 ? true : undefined),
        'both files loaded'
      );

      await vscode.commands.executeCommand('laxative.moveNoteToFile', {
        id: 'teamaaa1',
        target: 'private'
      });
      await waitFor(
        async () =>
          (await state()).notes.find((n) => n.id === 'teamaaa1')?.store === 'private'
            ? true
            : undefined,
        'the note to move'
      );

      const read = async (parts: readonly string[]) =>
        JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uriOf(parts))))
          .notes.map((n: Note) => n.id);
      assert.deepStrictEqual(await read(TEAM), ['teamaaa2']);
      assert.deepStrictEqual((await read(PRIVATE)).sort(), ['privbbb1', 'teamaaa1']);
      assert.strictEqual((await state()).notes.length, 3, 'and it is not counted twice');
    });

    it('never writes the note file a note came from into the file itself', async () => {
      await useFiles();
      await waitFor(
        async () => ((await state()).notes.length === 3 ? true : undefined),
        'both files loaded'
      );
      await vscode.commands.executeCommand('laxative.moveNoteToFile', {
        id: 'teamaaa1',
        target: 'private'
      });
      const written = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(uriOf(PRIVATE)))
      );
      for (const note of written.notes) {
        assert.ok(
          !('store' in note),
          'which file a note is in is where it lives, not something it carries'
        );
      }
    });

    it('adds note files as files in the folder, named after the name given', async () => {
      await useFiles();
      // The name decides the file: it is what a note file is for.
      await vscode.commands.executeCommand('laxative.addNoteFile', { name: 'Design Notes' });
      await vscode.commands.executeCommand('laxative.addNoteFile', { name: 'review' });

      const listed = (await state()) as unknown as {
        files: { name: string; path: string; enabled: boolean }[];
        enabled: string[];
      };
      assert.deepStrictEqual(
        listed.files.map((file) => file.path),
        [
          '.laxative/design-notes.json',
          '.laxative/private.json',
          '.laxative/review.json',
          '.laxative/team.json'
        ],
        'a second and a third file, each written where its name says'
      );
      assert.deepStrictEqual(listed.enabled, listed.files.map((file) => file.name), 'all on');

      // They are files, not a list in settings: the folder is what it reads.
      const folder = await vscode.workspace.fs.readDirectory(uriOf(['.laxative']));
      assert.ok(
        folder.some(([name]) => name === 'design-notes.json'),
        `design-notes.json is there: ${folder.map(([name]) => name).join(', ')}`
      );

      // A name already in use addresses an existing file, so it is refused.
      await vscode.commands.executeCommand('laxative.addNoteFile', { name: 'review' });
      assert.strictEqual(
        ((await state()) as unknown as { files: unknown[] }).files.length,
        4,
        'nothing added twice'
      );

      for (const name of ['design-notes.json', 'review.json']) {
        await vscode.workspace.fs.delete(uriOf(['.laxative', name]), { useTrash: false });
      }
      await vscode.commands.executeCommand('laxative.refresh');
    });

    it('renames a note file by renaming the file, and deletes it by deleting it', async () => {
      await useFiles(['team']);
      await vscode.commands.executeCommand('laxative.addNoteFile', { name: 'scratch' });

      const named = await waitFor(
        async () => {
          const listed = (await state()) as unknown as { files: { name: string }[] };
          return listed.files.some((file) => file.name === 'scratch') ? listed : undefined;
        },
        'the new file'
      );
      assert.ok(named, 'added');

      // Renaming is the file moving; the chosen files follow it by name.
      await vscode.commands.executeCommand('laxative.renameNoteFile', {
        name: 'scratch',
        to: 'Sketches'
      });
      const after = (await state()) as unknown as {
        files: { name: string; path: string }[];
        enabled: string[];
      };
      assert.ok(
        after.files.some((file) => file.path === '.laxative/sketches.json'),
        `renamed on disk: ${after.files.map((file) => file.path).join(', ')}`
      );
      assert.ok(!after.files.some((file) => file.name === 'scratch'), 'and the old name is gone');
      assert.deepStrictEqual(after.enabled.sort(), ['sketches', 'team'], 'still switched on');

      await vscode.commands.executeCommand('laxative.deleteNoteFile', { name: 'sketches' });
      const gone = (await state()) as unknown as { files: { name: string }[] };
      assert.deepStrictEqual(
        gone.files.map((file) => file.name).sort(),
        ['private', 'team'],
        'deleting a note file takes the file with it'
      );
    });

    it('exports the note files as they are, and imports them back the same way', async () => {
      await useFiles();
      const exported = vscode.Uri.joinPath(workspaceRoot(), 'export.json');
      await vscode.commands.executeCommand('laxative.export', {
        uri: exported,
        format: 'json'
      });

      const doc = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(exported))
      ) as { notes: { id: string; store?: string }[] };
      assert.deepStrictEqual(
        doc.notes.map((note) => `${note.id}:${note.store}`).sort(),
        ['privbbb1:private', 'teamaaa1:team', 'teamaaa2:team'],
        'the export says which note file each note came from'
      );

      // Both files emptied: the import has to put each note back on its own.
      await writeNotes(TEAM, []);
      await writeNotes(PRIVATE, []);
      await vscode.commands.executeCommand('laxative.refresh');
      await waitFor(
        async () => ((await state()).notes.length === 0 ? true : undefined),
        'the notes to be cleared'
      );

      await vscode.commands.executeCommand('laxative.import', {
        uri: exported,
        mode: 'merge',
        split: true
      });
      const back = await waitFor(
        async () => ((await state()).notes.length === 3 ? await state() : undefined),
        'the notes to come back'
      );
      assert.deepStrictEqual(
        back.notes.map((note) => `${note.id}:${note.store}`).sort(),
        ['privbbb1:private', 'teamaaa1:team', 'teamaaa2:team'],
        'each one back in the file it was exported from'
      );

      await vscode.workspace.fs.delete(exported, { useTrash: false });
    });

    it('makes a note file the import needs but the workspace does not have', async () => {
      await useFiles();
      const exported = vscode.Uri.joinPath(workspaceRoot(), 'from-elsewhere.json');
      await vscode.workspace.fs.writeFile(
        exported,
        new TextEncoder().encode(
          serialize([makeNote({ id: 'elsew001', body: 'From another workspace' })]).replace(
            '"tags"',
            '"store": "handover", "tags"'
          )
        )
      );

      await vscode.commands.executeCommand('laxative.import', {
        uri: exported,
        mode: 'merge',
        split: true
      });
      const listed = await waitFor(async () => {
        const now = (await state()) as unknown as {
          files: { name: string }[];
          notes: { id: string; store?: string }[];
        };
        return now.files.some((file) => file.name === 'handover') ? now : undefined;
      }, 'the note file the import asked for');
      assert.strictEqual(
        listed.notes.find((note) => note.id === 'elsew001')?.store,
        'handover',
        'the note lands in the file it names'
      );

      await vscode.workspace.fs.delete(exported, { useTrash: false });
      await vscode.workspace.fs.delete(uriOf(['.laxative', 'handover.json']), { useTrash: false });
      await vscode.commands.executeCommand('laxative.refresh');
    });

    it('registers the search view and the note file commands', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const id of [
        'laxative.selectNoteFiles',
        'laxative.addNoteFile',
        'laxative.deleteNoteFile',
        'laxative.renameNoteFile',
        'laxative.moveNoteToFile',
        'laxative.groupByStore'
      ]) {
        assert.ok(commands.includes(id), `${id} is registered`);
      }
      const views = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.contributes.views;
      const sidebar = views?.laxative as { id: string; type?: string }[];
      assert.deepStrictEqual(
        sidebar.map((v) => v.id),
        ['laxative.notesView'],
        'one view: the search box is part of the list it searches'
      );
      // Not a TreeView: the workbench builds a context menu for every tree row
      // it draws, out of every extension's entries, and scrolling paid for it.
      assert.strictEqual(sidebar[0].type, 'webview');
      const menus = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.contributes.menus;
      assert.strictEqual(menus['view/item/context'], undefined, 'so there are no tree row menus');
      assert.ok(
        (menus['webview/context'] as { command: string }[]).some(
          (entry) => entry.command === 'laxative.deleteNote'
        ),
        'and the right-click menu is contributed to the webview instead'
      );
    });
  });

  describe('clicking a note in the list', () => {
    afterEach(async () => {
      await vscode.workspace
        .getConfiguration('laxative')
        .update('listClickAction', undefined, vscode.ConfigurationTarget.Workspace);
    });

    const setActions = (actions: string[]) =>
      vscode.workspace
        .getConfiguration('laxative')
        .update('listClickAction', actions, vscode.ConfigurationTarget.Workspace);

    it('jumps to the code when that is the configured action', async () => {
      await writeStore([makeNote({ line: 6, character: 4 })]);
      await setActions(['reveal']);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('laxative.activateNote', 'note0001');

      const editor = await waitFor(
        () =>
          vscode.window.activeTextEditor?.document.uri.fsPath === appUri().fsPath
            ? vscode.window.activeTextEditor
            : undefined,
        'the code to open'
      );
      assert.strictEqual(editor.selection.active.line, 6);
      assert.strictEqual(
        vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'laxative').length,
        0,
        'no markdown editor, because it was not asked for'
      );
    });

    it('opens the rendered note when that is the configured action', async () => {
      await writeStore([makeNote({ body: 'Preview me\n\nwith **content**.' })]);
      await setActions(['preview']);
      await vscode.commands.executeCommand('laxative.activateNote', 'note0001');

      const report = await waitFor(async () => {
        const panel = (await renderReport()).notePanel;
        return panel?.title === 'Preview me' ? panel : undefined;
      }, 'the reading panel to render the note');
      assert.strictEqual(report.empty, false);
    });

    it('accepts several actions at once', async () => {
      await writeStore([makeNote({ body: 'Both please' })]);
      await setActions(['reveal', 'edit']);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('laxative.activateNote', 'note0001');

      await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'laxative'),
        'the markdown editor to open'
      );
      assert.ok(
        vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === appUri().fsPath),
        'and the code as well'
      );
    });

    it('does nothing when the action list is empty', async () => {
      await writeStore([makeNote()]);
      await setActions([]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('laxative.activateNote', 'note0001');
      await settle();
      assert.strictEqual(vscode.window.visibleTextEditors.length, 0);
    });
  });

  describe('editor layout', () => {
    const groupCount = () => vscode.window.tabGroups.all.length;
    const columnOf = (predicate: (uri: vscode.Uri) => boolean) =>
      vscode.window.tabGroups.all.find((group) =>
        group.tabs.some((tab) => {
          const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
          return uri ? predicate(uri) : false;
        })
      )?.viewColumn;

    const openCode = async (line = 1) => {
      const document = await vscode.workspace.openTextDocument(appUri());
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      return editor;
    };

    it('keeps the reading panel in one column instead of moving it around', async () => {
      await writeStore([makeNote({ id: 'first001' }), makeNote({ id: 'second02', line: 6 })]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await openCode();
      await vscode.commands.executeCommand('laxative.openNote', 'first001');

      const panelTab = () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs.map((tab) => ({ tab, group })))
          .find(({ tab }) => tab.input instanceof vscode.TabInputWebview);
      const before = await waitFor(() => panelTab()?.group.viewColumn, 'the reading panel');

      // Put the focus in a group to the *right* of the panel. Revealing the
      // panel "beside" the focus used to shunt it into yet another column,
      // resizing every group in the window.
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(appUri()),
        vscode.ViewColumn.Three
      );
      const groupsBefore = groupCount();

      await vscode.commands.executeCommand('laxative.openNote', 'second02');
      await settle();

      assert.strictEqual(panelTab()?.group.viewColumn, before, 'panel did not change column');
      assert.strictEqual(groupCount(), groupsBefore, 'no extra editor group appeared');
    });

    it('does not split the editor again for every note edited', async () => {
      await writeStore([
        makeNote({ id: 'aaa00001', body: 'First note' }),
        makeNote({ id: 'bbb00002', body: 'Second note', line: 6 })
      ]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await openCode();

      await vscode.commands.executeCommand('laxative.editNote', 'aaa00001');
      await waitFor(
        () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'laxative'),
        'the first note editor'
      );
      const groupsAfterFirst = groupCount();
      const noteColumn = columnOf((uri) => uri.scheme === 'laxative');

      // The note editor is focused now; opening another note used to split
      // beside *it*, adding a third column and resizing everything.
      await vscode.commands.executeCommand('laxative.editNote', 'bbb00002');
      await waitFor(
        () =>
          vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.scheme === 'laxative' && e.document.uri.authority === 'bbb00002'
          ),
        'the second note editor'
      );

      assert.strictEqual(groupCount(), groupsAfterFirst, 'still the same number of groups');
      assert.strictEqual(
        columnOf((uri) => uri.scheme === 'laxative'),
        noteColumn,
        'notes share one column'
      );
    });

    it('reveals code in the group it is already open in', async () => {
      await writeStore([makeNote({ line: 6, character: 2 })]);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // Deliberately put the file somewhere other than column one.
      const document = await vscode.workspace.openTextDocument(appUri());
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Two);
      const before = columnOf((uri) => uri.fsPath === appUri().fsPath);
      const groupsBefore = groupCount();

      await vscode.commands.executeCommand('laxative.revealNote', 'note0001');
      await settle();

      assert.strictEqual(
        columnOf((uri) => uri.fsPath === appUri().fsPath),
        before,
        'the file stayed in the group the user had it in'
      );
      assert.strictEqual(groupCount(), groupsBefore, 'no group was added or removed');
      assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 6);
    });
  });
});
