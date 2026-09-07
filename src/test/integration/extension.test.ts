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
    assert.ok(bound.has('laxative.notesAtCursor'));
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
    afterEach(async () => {
      await vscode.workspace
        .getConfiguration('laxative')
        .update('storeFile', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('laxative.refresh');
    });

    it('stores notes wherever laxative.storeFile points', async () => {
      await vscode.workspace
        .getConfiguration('laxative')
        .update('storeFile', 'docs/annotations.json', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('laxative.refresh');

      const document = await vscode.workspace.openTextDocument(appUri());
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      await vscode.commands.executeCommand('laxative.addNote');

      const custom = vscode.Uri.joinPath(workspaceRoot(), 'docs', 'annotations.json');
      const stat = await waitFor(
        () => vscode.workspace.fs.stat(custom).then((s) => s, () => undefined),
        'the note file at the configured path'
      );
      assert.ok(stat.size > 0);
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceRoot(), 'docs'), {
        recursive: true
      });
    });

    it('registers the storage configuration command', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('laxative.configureStorage'));
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
