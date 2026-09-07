import * as vscode from 'vscode';
import { NoteStore } from './store';

const SHARED = '.laxative/notes.json';
const PRIVATE = '.laxative/notes.local.json';

interface Choice extends vscode.QuickPickItem {
  action: 'shared' | 'private' | 'custom' | 'settings';
}

/**
 * Guided way to change where notes are stored, since the answer differs per
 * project: shared with the team, private to you, or somewhere of your own.
 * Whatever is picked is written to `laxative.storeFile` in workspace settings.
 */
export async function configureStorage(store: NoteStore): Promise<void> {
  const config = vscode.workspace.getConfiguration('laxative');
  const current = config.get<string>('storeFile', SHARED);
  const mark = (path: string) => (path === current ? '$(check) ' : '');

  const picked = await vscode.window.showQuickPick<Choice>(
    [
      {
        label: `${mark(SHARED)}Shared with the team`,
        description: SHARED,
        detail: 'Commit it to git so everyone sees the same notes.',
        action: 'shared'
      },
      {
        label: `${mark(PRIVATE)}Private to me`,
        description: PRIVATE,
        detail: 'Kept out of git; offers to add it to .gitignore.',
        action: 'private'
      },
      {
        label: '$(edit) Custom path...',
        description: current,
        detail: 'Any path relative to the workspace root.',
        action: 'custom'
      },
      {
        label: '$(gear) Open Laxative settings',
        detail: 'All settings, including the icons shown in the editor.',
        action: 'settings'
      }
    ],
    { title: `Notes are stored in ${current}` }
  );
  if (!picked) {
    return;
  }
  if (picked.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'laxative');
    return;
  }

  let target = picked.action === 'shared' ? SHARED : PRIVATE;
  if (picked.action === 'custom') {
    const entered = await vscode.window.showInputBox({
      title: 'Store notes in',
      value: current,
      prompt: 'Path relative to the workspace root.',
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed === '') {
          return 'Enter a path.';
        }
        if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.includes('..')) {
          return 'Use a path inside the workspace, without "..".';
        }
        return undefined;
      }
    });
    if (!entered) {
      return;
    }
    target = entered.trim().replace(/\\/g, '/');
  }
  if (target === current) {
    return;
  }

  const previous = store.storeUri;
  await vscode.workspace
    .getConfiguration('laxative')
    .update('storeFile', target, vscode.ConfigurationTarget.Workspace);

  await moveExistingNotes(store, previous, target);
  if (picked.action === 'private') {
    await offerGitignore(store, target);
  }
  void vscode.window.showInformationMessage(`Laxative: notes are now stored in ${target}.`);
}

/** Offers to carry the existing notes file over to the new location. */
async function moveExistingNotes(
  store: NoteStore,
  previous: vscode.Uri | undefined,
  target: string
): Promise<void> {
  const destination = store.storeUri;
  if (!previous || !destination || previous.toString() === destination.toString()) {
    return;
  }
  let content: Uint8Array;
  try {
    content = await vscode.workspace.fs.readFile(previous);
  } catch {
    return; // Nothing stored yet.
  }
  const answer = await vscode.window.showInformationMessage(
    `Move your existing notes to ${target}?`,
    { modal: true, detail: `From ${vscode.workspace.asRelativePath(previous)}` },
    'Move',
    'Leave them'
  );
  if (answer !== 'Move') {
    await store.reload();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, '..'));
  await vscode.workspace.fs.writeFile(destination, content);
  await vscode.workspace.fs.delete(previous);
  await store.reload();
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
