import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Note } from './core/types';
import { tagIndex } from './core/tags';
import { noteDescription, noteLocation } from './core/display';

export type GroupBy = 'file' | 'tag';
const UNTAGGED = Symbol('untagged');

class FileItem extends vscode.TreeItem {
  constructor(readonly file: string, count: number) {
    super(file.split('/').pop() ?? file, vscode.TreeItemCollapsibleState.Expanded);
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    this.description = `${dir} · ${count}`.trim();
    this.resourceUri = vscode.Uri.file(file);
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = 'laxativeFile';
    this.id = `file:${file}`;
  }
}

class TagItem extends vscode.TreeItem {
  constructor(readonly tag: string | typeof UNTAGGED, count: number) {
    const label = tag === UNTAGGED ? 'untagged' : `#${String(tag)}`;
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(tag === UNTAGGED ? 'circle-outline' : 'tag');
    this.contextValue = tag === UNTAGGED ? 'laxativeUntagged' : 'laxativeTag';
    this.id = `tag:${tag === UNTAGGED ? ' untagged' : String(tag)}`;
  }
}

class NoteItem extends vscode.TreeItem {
  constructor(readonly note: Note, showFile: boolean) {
    super(note.title, vscode.TreeItemCollapsibleState.None);
    this.description = noteDescription(note, showFile);
    this.iconPath = new vscode.ThemeIcon('comment');
    this.contextValue = 'laxative';
    this.id = `note:${note.id}:${showFile ? 'tag' : 'file'}`;
    // The location moves into the hover, spelled out, rather than sitting in
    // the list as a bare number nobody can read.
    const tooltip = new vscode.MarkdownString(
      `$(location) ${noteLocation(note)}\n\n---\n\n${note.body || '_empty note_'}`
    );
    tooltip.supportThemeIcons = true;
    this.tooltip = tooltip;
    this.command = {
      command: 'laxative.activateNote',
      title: 'Open Note',
      arguments: [note.id]
    };
  }
}

type Item = FileItem | TagItem | NoteItem;

/** The "Notes" view: every note in the workspace, grouped by file or by hashtag. */
export class NotesTree implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<Item>;
  private readonly disposables: vscode.Disposable[] = [];
  private groupBy: GroupBy;
  private tagFilter?: string;

  constructor(
    private readonly store: NoteStore,
    private readonly memento: vscode.Memento
  ) {
    this.groupBy = memento.get<GroupBy>('laxative.groupBy', 'file');
    this.view = vscode.window.createTreeView('laxative.notesView', {
      treeDataProvider: this,
      showCollapseAll: true
    });
    this.disposables.push(
      this.view,
      this.emitter,
      store.onDidChange(() => this.refresh())
    );
    void this.setGroupBy(this.groupBy);
  }

  async setGroupBy(groupBy: GroupBy): Promise<void> {
    this.groupBy = groupBy;
    await this.memento.update('laxative.groupBy', groupBy);
    await vscode.commands.executeCommand('setContext', 'laxative.groupBy', groupBy);
    this.refresh();
  }

  setTagFilter(tag: string | undefined): void {
    this.tagFilter = tag;
    void vscode.commands.executeCommand('setContext', 'laxative.hasTagFilter', tag !== undefined);
    this.refresh();
  }

  get filter(): string | undefined {
    return this.tagFilter;
  }

  /** Notes the view is currently showing, after any tag filter. */
  private visible(): readonly Note[] {
    const all = this.store.all();
    return this.tagFilter ? all.filter((n) => n.tags.includes(this.tagFilter as string)) : all;
  }

  refresh(): void {
    const count = this.visible().length;
    const total = this.store.all().length;
    if (total === 0) {
      this.view.message = undefined;
    } else if (this.tagFilter) {
      this.view.message = `#${this.tagFilter}: ${count} of ${total} notes.`;
    } else {
      this.view.message = `${total} note${total === 1 ? '' : 's'} in this workspace.`;
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Item): Item[] {
    const visible = this.visible();
    if (!element) {
      return this.groupBy === 'tag' ? this.tagGroups(visible) : this.fileGroups(visible);
    }
    if (element instanceof FileItem) {
      return this.notesOf(
        visible.filter((n) => n.file === element.file).sort((a, b) => a.line - b.line),
        false
      );
    }
    if (element instanceof TagItem) {
      const notes =
        element.tag === UNTAGGED
          ? visible.filter((n) => n.tags.length === 0)
          : visible.filter((n) => n.tags.includes(element.tag as string));
      return this.notesOf(notes, true);
    }
    return [];
  }

  private fileGroups(notes: readonly Note[]): Item[] {
    const files = [...new Set(notes.map((n) => n.file))].sort();
    return files.map((file) => new FileItem(file, notes.filter((n) => n.file === file).length));
  }

  private tagGroups(notes: readonly Note[]): Item[] {
    const groups: Item[] = tagIndex(notes).map(({ tag, count }) => new TagItem(tag, count));
    const untagged = notes.filter((n) => n.tags.length === 0).length;
    if (untagged > 0) {
      groups.push(new TagItem(UNTAGGED, untagged));
    }
    return groups;
  }

  private notesOf(notes: readonly Note[], showFile: boolean): NoteItem[] {
    return notes.map((note) => new NoteItem(note, showFile));
  }

  getParent(element: Item): Item | undefined {
    if (!(element instanceof NoteItem) || this.groupBy === 'tag') {
      return undefined;
    }
    return new FileItem(
      element.note.file,
      this.store.all().filter((n) => n.file === element.note.file).length
    );
  }

  async reveal(noteId: string): Promise<void> {
    const note = this.store.get(noteId);
    if (!note || !this.view.visible || this.groupBy === 'tag') {
      return;
    }
    const item = new NoteItem(note, false);
    try {
      await this.view.reveal(item, { select: true, focus: false });
    } catch {
      // reveal() is best-effort; the item may not be materialised yet.
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
