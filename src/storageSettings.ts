import * as vscode from 'vscode';
import { NoteStore } from './store';
import { NoteFileConfig, nameFromPath, normalisePath, validateName, validatePath } from './core/noteFiles';

const SHARED = '.laxative/notes.json';
const PRIVATE = '.laxative/notes.local.json';

interface Choice extends vscode.QuickPickItem {
  action: 'select' | 'add' | 'remove' | 'settings';
}

/**
 * The way in to everything about where notes live. Notes can be spread over
 * several named files — shared with the team, private to you, one per area —
 * and any number of them can be switched on at once.
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
        detail: 'A shared one, a private one, or any path in the workspace.',
        action: 'add'
      },
      {
        label: '$(trash) Remove a note file...',
        detail: 'Takes it off the list. The file itself is left on disk.',
        action: 'remove'
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
  } else if (picked.action === 'remove') {
    await removeNoteFile(store);
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

/** Which files' notes are shown: a checklist, so several can be on at once. */
export async function selectNoteFiles(store: NoteStore): Promise<void> {
  const files = store.noteFiles();
  if (files.length === 1) {
    const add = await vscode.window.showInformationMessage(
      `Laxative: "${files[0].name}" is the only note file. Add another to choose between them.`,
      'Add a note file...'
    );
    if (add) {
      await addNoteFile(store);
    }
    return;
  }
  const items: FileItem[] = files.map((file) => ({
    label: file.name,
    description: file.path,
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

interface PathChoice extends vscode.QuickPickItem {
  action: 'shared' | 'private' | 'custom';
}

/** Adds a note file to the list, naming it and choosing where it lives. */
export async function addNoteFile(store: NoteStore): Promise<void> {
  const files = store.noteFiles();
  const usedPaths = files.map((file) => file.path);
  const usedNames = files.map((file) => file.name);

  const choices: PathChoice[] = [
    {
      label: 'Shared with the team',
      description: SHARED,
      detail: 'Commit it to git so everyone sees the same notes.',
      action: 'shared'
    },
    {
      label: 'Private to me',
      description: PRIVATE,
      detail: 'Kept out of git; offers to add it to .gitignore.',
      action: 'private'
    },
    {
      label: '$(edit) Custom path...',
      detail: 'Any path relative to the workspace root.',
      action: 'custom'
    }
  ];
  const choice = await vscode.window.showQuickPick<PathChoice>(
    // A path already in the list is not worth offering again.
    choices.filter((item) => item.action === 'custom' || !usedPaths.includes(item.description ?? '')),
    { title: 'Where should this note file live?' }
  );
  if (!choice) {
    return;
  }

  let path = choice.action === 'shared' ? SHARED : PRIVATE;
  if (choice.action === 'custom') {
    const entered = await vscode.window.showInputBox({
      title: 'Path for the new note file',
      value: '.laxative/',
      prompt: 'Relative to the workspace root.',
      validateInput: (value) => validatePath(value, usedPaths)
    });
    if (!entered) {
      return;
    }
    path = normalisePath(entered) as string;
  }

  const name = await vscode.window.showInputBox({
    title: 'Name for this note file',
    value: nameFromPath(path),
    prompt: 'How it is shown wherever notes are grouped.',
    validateInput: (value) => validateName(value, usedNames)
  });
  if (!name) {
    return;
  }

  await store.addNoteFile({ name: name.trim(), path, enabled: true });
  if (choice.action === 'private') {
    await offerGitignore(store, path);
  }
  void vscode.window.showInformationMessage(
    `Laxative: "${name.trim()}" added, and switched on. New notes go to ${
      store.defaultFile() ?? name.trim()
    }.`
  );
}

/** Takes a file off the list. The notes stay on disk, untouched. */
export async function removeNoteFile(store: NoteStore): Promise<void> {
  const files = store.noteFiles();
  if (files.length < 2) {
    void vscode.window.showInformationMessage(
      'Laxative: there is only one note file, so there is nothing to remove.'
    );
    return;
  }
  const picked = await vscode.window.showQuickPick<FileItem>(
    files.map((file) => ({ label: file.name, description: file.path, file })),
    { title: 'Remove which note file?', placeHolder: 'The file itself is left on disk' }
  );
  if (!picked) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Stop using the note file "${picked.file.name}"?`,
    {
      modal: true,
      detail: `Its notes disappear from Laxative, but ${picked.file.path} is left where it is.`
    },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }
  await store.removeNoteFile(picked.file.name);
}

/** Asks which note file to use, skipping the question when there is one. */
export async function pickNoteFile(
  store: NoteStore,
  options: { title: string; placeHolder?: string; except?: string }
): Promise<string | undefined> {
  const files = store.enabledFiles().filter((file) => file.name !== options.except);
  if (files.length === 0) {
    return undefined;
  }
  if (files.length === 1) {
    return files[0].name;
  }
  const picked = await vscode.window.showQuickPick<FileItem>(
    files.map((file) => ({ label: file.name, description: file.path, file })),
    { title: options.title, placeHolder: options.placeHolder }
  );
  return picked?.file.name;
}

async function offerGitignore(store: NoteStore, target: string): Promise<void> {
  const root = store.root;
  if (!root) {
    return;
  }
  const gitignore = vscode.Uri.joinPath(root, '.gitignore');
  let existing = '';
  try {
    existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignore));
  } catch {
    // No .gitignore yet; one will be created if the user agrees.
  }
  if (existing.split('\n').some((line) => line.trim() === target)) {
    return;
  }
  const answer = await vscode.window.showInformationMessage(
    `Add ${target} to .gitignore?`,
    'Add',
    'No thanks'
  );
  if (answer !== 'Add') {
    return;
  }
  const updated = existing === '' ? `${target}\n` : `${existing.replace(/\n*$/, '\n')}${target}\n`;
  await vscode.workspace.fs.writeFile(gitignore, new TextEncoder().encode(updated));
}
