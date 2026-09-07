import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Note } from './core/types';
import { tagIndex } from './core/tags';
import { refPrefix, slugForTitle, tagPrefix } from './core/editing';

export const NOTE_SCHEME = 'laxative';

/**
 * Backs note bodies with real, editable text documents (`laxative://<id>/Title.md`)
 * so writing a note uses the actual VS Code editor — multi-line, markdown
 * highlighting, your own keybindings — instead of a cramped input box. Ctrl+S
 * writes straight back into the notes store.
 */
export class NoteDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: NoteStore) {
    this.disposables.push(
      this.emitter,
      vscode.workspace.registerFileSystemProvider(NOTE_SCHEME, this, {
        isCaseSensitive: true
      }),
      vscode.languages.registerCompletionItemProvider(
        { scheme: NOTE_SCHEME },
        new NoteCompletions(store),
        '[',
        '#'
      ),
      // A note opened and closed without typing anything leaves nothing behind.
      // Tab events are used rather than onDidCloseTextDocument, which VS Code
      // does not fire promptly for provider-backed documents.
      vscode.window.tabGroups.onDidChangeTabs((e) => void this.discardEmpty(e.closed)),
      // Closing the editor of a deleted note keeps stale tabs from lingering.
      store.onDidChange(() => this.closeOrphanedEditors())
    );
  }

  /**
   * The document URI for a note. The id lives in the authority, so the visible
   * filename can be something readable: the note's title, or the code it
   * annotates while it is still empty.
   */
  static uriFor(note: Note): vscode.Uri {
    const name =
      note.body.trim() === ''
        ? `${note.file.split('/').pop() ?? 'note'}-${note.line + 1}`
        : slugForTitle(note.title);
    return vscode.Uri.from({
      scheme: NOTE_SCHEME,
      authority: note.id,
      path: `/${name}.md`
    });
  }

  /** An already-open editor for this note, whatever name its tab was given. */
  private static openTabFor(id: string): vscode.Tab | undefined {
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => {
        const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
        return uri?.scheme === NOTE_SCHEME && uri.authority === id;
      });
  }

  /**
   * Where a note editor should open. Notes share whichever group already holds
   * one, so editing note after note never keeps splitting the editor area and
   * resizing everything else; only the first one splits.
   */
  private static columnForNotes(): vscode.ViewColumn {
    for (const group of vscode.window.tabGroups.all) {
      const holdsNote = group.tabs.some(
        (tab) => (tab.input as { uri?: vscode.Uri } | undefined)?.uri?.scheme === NOTE_SCHEME
      );
      if (holdsNote) {
        return group.viewColumn;
      }
    }
    return vscode.ViewColumn.Beside;
  }

  /**
   * Opens a note in a text editor, beside the code it annotates. An open editor
   * is reused rather than duplicated, and the tab is never closed and reopened
   * behind the user's back: its name is settled when the note is opened.
   */
  static async open(note: Note): Promise<vscode.TextEditor | undefined> {
    const existing = NoteDocuments.openTabFor(note.id);
    const uri =
      (existing?.input as { uri?: vscode.Uri } | undefined)?.uri ?? NoteDocuments.uriFor(note);
    const viewColumn = existing ? existing.group.viewColumn : NoteDocuments.columnForNotes();
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return await vscode.window.showTextDocument(document, {
        viewColumn,
        preview: false
      });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Laxative: could not open that note for editing (${String(err)}).`
      );
      return undefined;
    }
  }

  /** Drops placeholder notes whose editor was closed before anything was written. */
  private async discardEmpty(closed: readonly vscode.Tab[]): Promise<void> {
    for (const tab of closed) {
      const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (uri?.scheme !== NOTE_SCHEME) {
        continue;
      }
      const note = this.store.get(idOf(uri));
      // Another tab may still hold the same note, in which case it is not gone.
      const stillOpen = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((other) => (other.input as { uri?: vscode.Uri })?.uri?.authority === uri.authority);
      if (note && !stillOpen && note.body.trim() === '') {
        await this.store.remove(note.id);
      }
    }
  }

  private closeOrphanedEditors(): void {
    for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      const uri = input?.uri;
      if (uri?.scheme === NOTE_SCHEME && !this.store.get(idOf(uri))) {
        void vscode.window.tabGroups.close(tab);
      }
    }
  }

  private require(uri: vscode.Uri): Note {
    const note = this.store.get(idOf(uri));
    if (!note) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return note;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const note = this.require(uri);
    const time = Date.parse(note.updatedAt) || Date.now();
    return {
      type: vscode.FileType.File,
      ctime: Date.parse(note.createdAt) || time,
      mtime: time,
      size: new TextEncoder().encode(note.body).byteLength
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return new TextEncoder().encode(this.require(uri).body);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const note = this.require(uri);
    await this.store.update(note.id, { body: new TextDecoder().decode(content) });
  }

  watch(): vscode.Disposable {
    // Notes only change through this provider or the store, both of which
    // already notify the rest of the extension.
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Notes have no directories.');
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      `Use the Laxative view to delete "${idOf(uri)}".`
    );
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions(
      'A note is renamed by changing its first line.'
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function idOf(uri: vscode.Uri): string {
  return uri.authority;
}

/** `[[` suggests other notes; `#` suggests hashtags already in use. */
class NoteCompletions implements vscode.CompletionItemProvider {
  constructor(private readonly store: NoteStore) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const upToCursor = document.lineAt(position.line).text.slice(0, position.character);
    const self = document.uri.authority;

    const ref = refPrefix(upToCursor);
    if (ref) {
      const range = new vscode.Range(position.line, ref.start, position.line, position.character);
      return this.store
        .all()
        .filter((note) => note.id !== self)
        .map((note) => {
          const item = new vscode.CompletionItem(note.title, vscode.CompletionItemKind.Reference);
          item.detail = `${note.file}:${note.line + 1}`;
          item.documentation = new vscode.MarkdownString(note.body.slice(0, 400));
          item.filterText = `${note.title} ${note.file} ${note.id}`;
          item.insertText = `[[${note.id}|${note.title}]]`;
          item.range = range;
          return item;
        });
    }

    const tag = tagPrefix(upToCursor);
    if (tag) {
      const range = new vscode.Range(position.line, tag.start, position.line, position.character);
      return tagIndex(this.store.all()).map(({ tag: name, count }) => {
        const item = new vscode.CompletionItem(`#${name}`, vscode.CompletionItemKind.Keyword);
        item.detail = `${count} note${count === 1 ? '' : 's'}`;
        item.insertText = `#${name}`;
        item.range = range;
        return item;
      });
    }
    return [];
  }
}
