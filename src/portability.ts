import * as vscode from 'vscode';
import { NoteStore } from './store';
import { pickNoteFile } from './storageSettings';
import { Note } from './core/types';
import { parse, serializeExport } from './core/schema';
import { located } from './core/display';

function defaultName(extension: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `laxative-${stamp}.${extension}`;
}

/** Human-readable export: one markdown section per note, refs kept intact. */
function toMarkdown(notes: readonly Note[], severalFiles: boolean): string {
  const lines = ['# Laxative export', '', `Exported ${new Date().toISOString()}`, ''];
  for (const note of notes) {
    lines.push(
      `## ${note.title}`,
      '',
      `- id: \`${note.id}\``,
      ...(located(note)
        ? [`- location: \`${note.file}:${note.line + 1}:${note.character + 1}\``]
        : ['- no location']),
      ...(severalFiles && note.store ? [`- note file: ${note.store}`] : []),
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

/** The note files the notes came from, in the order they are listed. */
function filesIn(notes: readonly Note[]): string[] {
  const names: string[] = [];
  for (const note of notes) {
    if (note.store && !names.includes(note.store)) {
      names.push(note.store);
    }
  }
  return names;
}

/**
 * Exports every note that is switched on. Called with `{ uri, format }` it
 * asks nothing, which is how tests and anything scripted drive it.
 */
export async function exportNotes(
  store: NoteStore,
  preset?: { uri?: unknown; format?: unknown }
): Promise<void> {
  const notes = store.all();
  if (notes.length === 0) {
    void vscode.window.showInformationMessage('Laxative: there are no notes to export.');
    return;
  }
  const from = filesIn(notes);
  const chosen =
    preset?.format === 'json' || preset?.format === 'md'
      ? { value: preset.format }
      : await vscode.window.showQuickPick(
          [
            {
              label: 'JSON',
              description:
                from.length > 1
                  ? `Round-trips back through Import, ${from.length} note files and all`
                  : 'Round-trips back through Import',
              value: 'json' as const
            },
            {
              label: 'Markdown',
              description: 'For reading and sharing; not importable',
              value: 'md' as const
            }
          ],
          { title: `Export ${notes.length} notes as...` }
        );
  if (!chosen) {
    return;
  }
  const format = chosen.value;
  const target =
    preset?.uri instanceof vscode.Uri
      ? preset.uri
      : await vscode.window.showSaveDialog({
          title: 'Export notes',
          defaultUri: vscode.Uri.joinPath(store.root ?? vscode.Uri.file('.'), defaultName(format)),
          filters: format === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] }
        });
  if (!target) {
    return;
  }
  // Which note file each note came from travels with it, so an import can put
  // them back rather than pouring several files into one.
  const text = format === 'json' ? serializeExport(notes) : toMarkdown(notes, from.length > 1);
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  if (preset?.uri instanceof vscode.Uri) {
    return;
  }
  const open = await vscode.window.showInformationMessage(
    from.length > 1
      ? `Laxative: exported ${notes.length} notes from ${from.join(', ')}.`
      : `Laxative: exported ${notes.length} notes.`,
    'Open file'
  );
  if (open) {
    await vscode.window.showTextDocument(target);
  }
}

/**
 * The note file called `name`, made if it is not there and switched on if it
 * is off, so notes coming back from an export land where they were.
 */
async function ensureFile(store: NoteStore, name: string): Promise<string | undefined> {
  const known = store.noteFiles().find((file) => file.name.toLowerCase() === name.toLowerCase());
  if (!known) {
    return (await store.addNoteFile(name))?.name;
  }
  if (!known.enabled) {
    await store.setEnabled([...store.enabledFiles().map((file) => file.name), known.name]);
  }
  return known.name;
}

/**
 * Imports notes from a JSON export. Called with `{ uri, mode, split }` it asks
 * nothing. `split` keeps the note files the export came from.
 */
export async function importNotes(
  store: NoteStore,
  preset?: { uri?: unknown; mode?: unknown; split?: unknown }
): Promise<void> {
  const source =
    preset?.uri instanceof vscode.Uri
      ? preset.uri
      : (
          await vscode.window.showOpenDialog({
            title: 'Import notes',
            canSelectMany: false,
            filters: { JSON: ['json'] }
          })
        )?.[0];
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

  // An export says which note file each note was in. Offered, not assumed:
  // pouring someone else's five files into your workspace may not be wanted.
  const from = filesIn(incoming);
  const asked = typeof preset?.split === 'boolean' ? preset.split : undefined;
  let split = asked ?? false;
  let target: string | undefined;
  if (asked === undefined && from.length > 1) {
    const where = await vscode.window.showQuickPick(
      [
        {
          label: `$(files) Keep their note files`,
          description: from.join(', '),
          detail: 'Files that are not here yet are created.',
          value: true
        },
        {
          label: '$(file) Put them all in one file...',
          detail: 'Pick the file they should all go into.',
          value: false
        }
      ],
      { title: `Import ${incoming.length} notes from ${from.length} note files` }
    );
    if (!where) {
      return;
    }
    split = where.value;
  }
  if (!split) {
    target = await pickNoteFile(store, {
      title: `Import ${incoming.length} notes into which note file?`
    });
    if (!target) {
      return;
    }
  }

  const mode =
    preset?.mode === 'merge' || preset?.mode === 'replace'
      ? preset.mode
      : (
          await vscode.window.showQuickPick(
            [
              {
                label: 'Merge',
                description: `Add new notes, keep the ${store.all().length} already here`,
                value: 'merge' as const
              },
              {
                label: 'Replace',
                description: split
                  ? 'Discard the notes in each of those files and use only the imported ones'
                  : `Discard the notes in ${target} and use only the imported ones`,
                value: 'replace' as const
              }
            ],
            { title: `Import ${incoming.length} notes` }
          )
        )?.value;
  if (!mode) {
    return;
  }

  let count = 0;
  const landed: string[] = [];
  if (split) {
    // One group per note file named in the export, each back where it was.
    for (const name of from.length > 0 ? from : [store.defaultFile() ?? '']) {
      const into = await ensureFile(store, name);
      if (!into) {
        continue;
      }
      count += await store.importNotes(
        incoming.filter((note) => note.store === name),
        mode,
        into
      );
      landed.push(into);
    }
    const loose = incoming.filter((note) => !note.store);
    if (loose.length > 0) {
      count += await store.importNotes(loose, 'merge', store.defaultFile());
    }
  } else {
    count = await store.importNotes(incoming, mode, target);
    landed.push(target ?? '');
  }

  if (preset?.uri instanceof vscode.Uri) {
    return;
  }
  const where = landed.length > 1 ? ` into ${landed.join(', ')}` : '';
  void vscode.window.showInformationMessage(
    mode === 'merge'
      ? `Laxative: imported ${count} new notes${where} (${incoming.length - count} already existed).`
      : `Laxative: replaced all notes with ${count} imported ones${where}.`
  );
}
