import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Note } from './core/types';
import { parse, serialize } from './core/schema';

function defaultName(extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `laxative-${stamp}.${extension}`;
}

/** Human-readable export: one markdown section per note, refs kept intact. */
function toMarkdown(notes: readonly Note[]): string {
  const lines = ['# Laxative export', '', `Exported ${new Date().toISOString()}`, ''];
  for (const note of notes) {
    lines.push(
      `## ${note.title}`,
      '',
      `- id: \`${note.id}\``,
      `- location: \`${note.file}:${note.line + 1}:${note.character + 1}\``,
      `- updated: ${note.updatedAt}`,
      '',
      note.body,
      '',
      '---',
      ''
    );
  }
  return lines.join('\n');
}

export async function exportNotes(store: NoteStore): Promise<void> {
  const notes = store.all();
  if (notes.length === 0) {
    void vscode.window.showInformationMessage('Laxative: there are no notes to export.');
    return;
  }
  const format = await vscode.window.showQuickPick(
    [
      { label: 'JSON', description: 'Round-trips back through Import', value: 'json' as const },
      { label: 'Markdown', description: 'For reading and sharing; not importable', value: 'md' as const }
    ],
    { title: `Export ${notes.length} notes as...` }
  );
  if (!format) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Export notes',
    defaultUri: vscode.Uri.joinPath(store.root ?? vscode.Uri.file('.'), defaultName(format.value)),
    filters: format.value === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] }
  });
  if (!target) {
    return;
  }
  const text = format.value === 'json' ? serialize([...notes]) : toMarkdown(notes);
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  const open = await vscode.window.showInformationMessage(
    `Laxative: exported ${notes.length} notes.`,
    'Open file'
  );
  if (open) {
    await vscode.window.showTextDocument(target);
  }
}

export async function importNotes(store: NoteStore): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import notes',
    canSelectMany: false,
    filters: { JSON: ['json'] }
  });
  const source = picked?.[0];
  if (!source) {
    return;
  }
  let incoming: Note[];
  try {
    incoming = parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(source)));
  } catch (err) {
    void vscode.window.showErrorMessage(`Laxative: could not read that file: ${String(err)}`);
    return;
  }
  if (incoming.length === 0) {
    void vscode.window.showWarningMessage('Laxative: that file contains no notes.');
    return;
  }
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: 'Merge',
        description: `Add new notes, keep the ${store.all().length} already here`,
        value: 'merge' as const
      },
      {
        label: 'Replace',
        description: 'Discard existing notes and use only the imported ones',
        value: 'replace' as const
      }
    ],
    { title: `Import ${incoming.length} notes` }
  );
  if (!mode) {
    return;
  }
  const count = await store.importNotes(incoming, mode.value);
  void vscode.window.showInformationMessage(
    mode.value === 'merge'
      ? `Laxative: imported ${count} new notes (${incoming.length - count} already existed).`
      : `Laxative: replaced all notes with ${count} imported ones.`
  );
}
