import * as vscode from 'vscode';
import { NoteStore } from './store';
import {
  NOTES_DIR,
  NoteFileConfig,
  nameFromPath,
  pathForName,
  validateName
} from './core/noteFiles';

interface Choice extends vscode.QuickPickItem {
  action: 'select' | 'add' | 'rename' | 'delete' | 'settings';
}

/**
 * The way in to everything about where notes live. Note files are the `.json`
 * files in `.laxative/` — the folder is the list — and any number of them can
 * be switched on at once.
 */
export async function configureStorage(store: NoteStore): Promise<void> {
  const files = store.noteFiles();
  const on = files.filter((file) => file.enabled);
  const picked = await vscode.window.showQuickPick<Choice>(
    [
      {
        label: '$(checklist) Select note files...',
        description: `${on.length} of ${files.length} switched on`,
        detail: 'Choose which files’ notes are shown. One or more at a time.',
        action: 'select'
      },
      {
        label: '$(add) Add a note file...',
        detail: `Name it; the file is created in ${NOTES_DIR}/ and switched on.`,
        action: 'add'
      },
      {
        label: '$(edit) Rename a note file...',
        detail: 'The name is the file name, so this renames the file itself.',
        action: 'rename'
      },
      {
        label: '$(trash) Delete a note file...',
        detail: 'Deletes the file and the notes in it, to the trash.',
        action: 'delete'
      },
      {
        label: '$(gear) Open Laxative settings',
        detail: 'All settings, including the icons shown in the editor.',
        action: 'settings'
      }
    ],
    { title: summarise(files) }
  );
  if (!picked) {
    return;
  }
  if (picked.action === 'select') {
    await selectNoteFiles(store);
  } else if (picked.action === 'add') {
    await addNoteFile(store);
  } else if (picked.action === 'rename') {
    await renameNoteFile(store);
  } else if (picked.action === 'delete') {
    await deleteNoteFile(store);
  } else {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'laxative');
  }
}

function summarise(files: readonly NoteFileConfig[]): string {
  const on = files.filter((file) => file.enabled).map((file) => file.name);
  return on.length === files.length
    ? `Notes come from ${on.join(', ')}`
    : `Notes come from ${on.join(', ')} (${files.length - on.length} switched off)`;
}

interface FileItem extends vscode.QuickPickItem {
  file: NoteFileConfig;
}

const countOf = (store: NoteStore, name: string): string => {
  const notes = store.all().filter((note) => note.store === name).length;
  return `${notes} note${notes === 1 ? '' : 's'}`;
};

/** Which files' notes are shown: a checklist, so several can be on at once. */
export async function selectNoteFiles(store: NoteStore): Promise<void> {
  const files = store.noteFiles();
  if (files.length === 1) {
    const add = await vscode.window.showInformationMessage(
      `Laxative: "${files[0].name}" is the only note file in ${NOTES_DIR}/. Add another to choose between them.`,
      'Add a note file...'
    );
    if (add) {
      await addNoteFile(store);
    }
    return;
  }
  const items: FileItem[] = files.map((file) => ({
    label: file.name,
    description: file.enabled ? countOf(store, file.name) : file.path,
    picked: file.enabled,
    file
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Show notes from',
    placeHolder: 'Pick one or more note files',
    canPickMany: true
  });
  if (!picked) {
    return;
  }
  if (picked.length === 0) {
    void vscode.window.showWarningMessage(
      'Laxative: at least one note file stays switched on, or there would be nothing to show.'
    );
  }
  await store.setEnabled(picked.map((item) => item.file.name));
  const now = store.enabledFiles().map((file) => file.name);
  void vscode.window.setStatusBarMessage(`Laxative: showing notes from ${now.join(', ')}`, 4000);
}

/** Asks for a name, saying as you type which file it will be. */
async function askName(
  store: NoteStore,
  options: { title: string; value?: string; except?: string }
): Promise<string | undefined> {
  // Renaming a file, its own name is not taken: it is the one being changed.
  const taken = store
    .noteFiles()
    .map((file) => file.path)
    .filter((path) => path !== options.except);
  const entered = await vscode.window.showInputBox({
    title: options.title,
    value: options.value ?? '',
    placeHolder: 'architecture, review, todo...',
    prompt: 'The name is the file name, and how the file is shown wherever notes are grouped.',
    validateInput: (value) => {
      const wrong = validateName(value, taken);
      if (wrong) {
        return wrong;
      }
      // Not a complaint: it says where the notes will end up, as you type.
      return {
        message: `${pathForName(value)}`,
        severity: vscode.InputBoxValidationSeverity.Info
      };
    }
  });
  return entered?.trim();
}

/**
 * Adds a note file: a name, and the file is created in the folder. Called with
 * `{ name }` it asks nothing, which is how tests and keybindings drive it.
 * Returns the name the new file ended up with.
 */
export async function addNoteFile(
  store: NoteStore,
  preset?: { name?: unknown }
): Promise<string | undefined> {
  const asked = typeof preset?.name === 'string' ? preset.name.trim() : undefined;
  const wrong = asked === undefined ? undefined : validateName(asked, store.noteFiles().map((f) => f.path));
  if (wrong) {
    void vscode.window.showWarningMessage(`Laxative: ${wrong}`);
    return undefined;
  }
  const name = asked ?? (await askName(store, { title: 'Name for the new note file' }));
  if (!name) {
    return undefined;
  }
  const added = await store.addNoteFile(name);
  if (!added) {
    void vscode.window.showWarningMessage('Laxative: open a folder first — note files live inside it.');
    return undefined;
  }
  if (asked === undefined) {
    const several = store.enabledFiles().length > 1;
    void vscode.window.showInformationMessage(
      `Laxative: ${added.path} added, and switched on.` +
        (several ? ' New notes ask which file they belong to.' : '')
    );
  }
  return added.name;
}

/**
 * Renames the file, since the file name is the name. Called with
 * `{ name, to }` it asks nothing.
 */
export async function renameNoteFile(
  store: NoteStore,
  preset?: { name?: unknown; to?: unknown }
): Promise<void> {
  const named =
    typeof preset?.name === 'string'
      ? store.noteFiles().find((file) => file.name === preset.name)
      : undefined;
  const file = named ?? (await pickFile(store, { title: 'Rename which note file?', all: true }));
  if (!file) {
    return;
  }
  const name =
    typeof preset?.to === 'string'
      ? preset.to.trim()
      : await askName(store, {
          title: `Rename "${file.name}" to`,
          value: file.name,
          except: file.path
        });
  if (!name || pathForName(name, []) === file.path) {
    return; // Unchanged, or only in ways a file name cannot carry.
  }
  const renamed = await store.renameNoteFile(file.name, name);
  if (renamed) {
    void vscode.window.setStatusBarMessage(
      `Laxative: ${file.path} is now ${renamed.path}.`,
      4000
    );
  }
}

/**
 * Deletes the file, notes and all. It goes to the trash, so it can come back.
 * Called with `{ name }` it deletes that file without asking, which is for
 * tests and for anything scripted — the command palette never passes one.
 */
export async function deleteNoteFile(
  store: NoteStore,
  preset?: { name?: unknown }
): Promise<void> {
  if (typeof preset?.name === 'string') {
    await store.deleteNoteFile(preset.name);
    return;
  }
  const files = store.noteFiles();
  if (files.length < 2) {
    void vscode.window.showInformationMessage(
      `Laxative: "${files[0]?.name ?? 'notes'}" is the only note file, so there is nothing to delete.`
    );
    return;
  }
  const file = await pickFile(store, {
    title: 'Delete which note file?',
    placeHolder: 'The file and its notes go to the trash',
    all: true
  });
  if (!file) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete the note file "${file.name}"?`,
    {
      modal: true,
      detail: `${file.path} and the ${countOf(store, file.name)} in it go to the trash. To stop showing them instead, switch the file off in Select Note Files.`
    },
    'Delete'
  );
  if (confirm !== 'Delete') {
    return;
  }
  await store.deleteNoteFile(file.name);
}

/** One of the note files, skipping the question when there is only one. */
async function pickFile(
  store: NoteStore,
  options: { title: string; placeHolder?: string; all?: boolean; except?: string }
): Promise<NoteFileConfig | undefined> {
  const files = (options.all ? store.noteFiles() : store.enabledFiles()).filter(
    (file) => file.name !== options.except
  );
  if (files.length === 0) {
    return undefined;
  }
  if (files.length === 1) {
    return files[0];
  }
  const picked = await vscode.window.showQuickPick<FileItem>(
    files.map((file) => ({
      label: file.name,
      description: countOf(store, file.name),
      detail: file.enabled ? undefined : 'switched off',
      file
    })),
    { title: options.title, placeHolder: options.placeHolder }
  );
  return picked?.file;
}

/** Asks which note file to use, skipping the question when there is one. */
export async function pickNoteFile(
  store: NoteStore,
  options: { title: string; placeHolder?: string; except?: string }
): Promise<string | undefined> {
  return (await pickFile(store, options))?.name;
}

/**
 * Note files used to be listed in settings, each with a path of its own. The
 * folder is the list now, so the old settings are cleared — but not before
 * anything they point at outside `.laxative/` has been brought in, or the
 * notes in it would simply stop appearing.
 */
export async function migrateLegacyFiles(store: NoteStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('laxative');
  const listed = config.get<{ path?: unknown }[]>('noteFiles', []);
  const single = config.get<string>('storeFile', '');
  if (!Array.isArray(listed) || (listed.length === 0 && single.trim() === '')) {
    return;
  }

  const paths = [...listed.map((entry) => entry?.path), single]
    .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
    .map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  const elsewhere: string[] = [];
  for (const path of new Set(paths)) {
    if (path.startsWith(`${NOTES_DIR}/`)) {
      continue; // Already in the folder: it is found by looking.
    }
    const uri = store.absoluteUri(path);
    if (uri && (await exists(uri))) {
      elsewhere.push(path);
    }
  }

  const forget = async () => {
    for (const setting of ['noteFiles', 'storeFile']) {
      await config.update(setting, undefined, vscode.ConfigurationTarget.Workspace);
      await config.update(setting, undefined, vscode.ConfigurationTarget.Global);
    }
  };

  if (elsewhere.length === 0) {
    await forget();
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    `Laxative keeps note files in ${NOTES_DIR}/ now, one per name. Move ${
      elsewhere.length === 1 ? `${elsewhere[0]} there` : `${elsewhere.length} note files there`
    }?`,
    { detail: elsewhere.join('\n'), modal: false },
    'Move',
    'Not now'
  );
  if (answer !== 'Move') {
    return; // Asked again next time, rather than leaving notes behind quietly.
  }
  for (const path of elsewhere) {
    const from = store.absoluteUri(path);
    const into = store.absoluteUri(pathForName(nameFromPath(path), store.noteFiles().map((f) => f.path)));
    if (!from || !into) {
      continue;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(into, '..'));
    await vscode.workspace.fs.rename(from, into, { overwrite: false });
  }
  await forget();
  await store.reload();
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
