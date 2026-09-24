import * as vscode from 'vscode';
import { NoteStore } from './store';
import { Query, isActive } from './core/search';
import { GroupBy, NoteList, buildList, describeList, flatten } from './core/noteList';
import { FileIcons, IconReport } from './fileIcons';

export type { GroupBy };

/** What a row in the list may ask the extension to run, and nothing else. */
const ROW_COMMANDS = new Set([
  'laxative.revealNote',
  'laxative.editNote',
  'laxative.filterByTag',
  'laxative.addNote',
  'laxative.addLooseNote',
  'laxative.import'
]);

interface FromList {
  type: string;
  query?: string;
  exclude?: string;
  noteId?: string;
  tag?: string;
  command?: string;
}

/**
 * The "Notes" view: every note in the workspace, grouped by file, hashtag or
 * note file, with the search box on top of it.
 *
 * It is a webview rather than a TreeView, and that is about scrolling. For
 * every row a TreeView draws, the workbench builds that row's context menu out
 * of every `view/item/context` entry of every installed extension — over a
 * thousand with GitLens installed — on the window's main thread, on every
 * scroll event. Measured, that pinned a core while scrolling a list of 64
 * notes. Here the rows are plain elements the browser scrolls by itself, and a
 * menu is only built when one is asked for.
 */
export class NotesView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'laxative.notesView';

  private view?: vscode.WebviewView;
  private ready = false;
  private groupBy: GroupBy;
  private tagFilter?: string;
  private search: Query = {};
  private list?: NoteList;
  /** Asked for before the webview existed; it is built lazily. */
  private pending: { focusSearch?: boolean; reveal?: string } = {};
  private readonly icons: FileIcons;
  /** The folders the webview was last allowed to read, to tell when that changes. */
  private allowed = '';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: NoteStore,
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento
  ) {
    this.groupBy = memento.get<GroupBy>('laxative.groupBy', 'file');
    this.icons = new FileIcons();
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(NotesView.viewType, this, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      store.onDidChange(() => this.refresh()),
      this.icons,
      this.icons.onDidChange(() => this.iconsChanged())
    );
    void this.icons.load();
    void this.setGroupBy(this.groupBy);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.onDidReceiveMessage((msg: FromList) => this.receive(msg), null, this.disposables);
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.ready = false;
      },
      null,
      this.disposables
    );
    this.load(view);
  }

  /** (Re)builds the page. The icon theme's folder has to be readable from it. */
  private load(view: vscode.WebviewView): void {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media'), ...this.icons.roots()];
    this.allowed = roots.map(String).join('\n');
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: roots };
    view.webview.html = this.shell(view.webview);
  }

  private iconsChanged(): void {
    if (!this.view) {
      return;
    }
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media'), ...this.icons.roots()];
    if (roots.map(String).join('\n') !== this.allowed) {
      // A different theme lives in a different folder, which only a rebuilt
      // page may read from. Folded groups and the selection survive it.
      this.load(this.view);
    } else {
      this.push();
    }
  }

  private receive(msg: FromList): void {
    if (msg.type === 'ready') {
      this.ready = true;
      this.push();
      // A webview that was rebuilt starts with empty boxes; the list may not be.
      if (isActive(this.search)) {
        this.post({
          type: 'search',
          query: this.search.query ?? '',
          exclude: this.search.exclude ?? ''
        });
      }
      if (this.pending.reveal) {
        this.post({ type: 'reveal', noteId: this.pending.reveal });
      }
      if (this.pending.focusSearch) {
        this.post({ type: 'focusSearch' });
      }
      this.pending = {};
    } else if (msg.type === 'search') {
      this.applySearch({ query: msg.query ?? '', exclude: msg.exclude ?? '' });
    } else if (msg.type === 'activate' && msg.noteId) {
      void vscode.commands.executeCommand('laxative.activateNote', msg.noteId);
    } else if (msg.type === 'command' && msg.command && ROW_COMMANDS.has(msg.command)) {
      const arg = msg.noteId ?? msg.tag;
      void vscode.commands.executeCommand(msg.command, ...(arg === undefined ? [] : [arg]));
    }
  }

  private post(message: unknown): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    }
  }

  async setGroupBy(groupBy: GroupBy): Promise<void> {
    this.groupBy = groupBy;
    await this.memento.update('laxative.groupBy', groupBy);
    await vscode.commands.executeCommand('setContext', 'laxative.groupBy', groupBy);
    this.refresh();
  }

  /** Narrows the list, and puts the search into the box so the two agree. */
  setSearch(search: Query): void {
    this.applySearch(search);
    this.post({ type: 'search', query: search.query ?? '', exclude: search.exclude ?? '' });
  }

  /** From the box itself: nothing to send back to it. */
  private applySearch(search: Query): void {
    this.search = search;
    void vscode.commands.executeCommand('setContext', 'laxative.hasSearch', isActive(search));
    this.refresh();
  }

  currentSearch(): Query {
    return this.search;
  }

  setTagFilter(tag: string | undefined): void {
    this.tagFilter = tag;
    void vscode.commands.executeCommand('setContext', 'laxative.hasTagFilter', tag !== undefined);
    this.refresh();
  }

  get filter(): string | undefined {
    return this.tagFilter;
  }

  private options() {
    return {
      groupBy: this.groupBy,
      query: this.search,
      tagFilter: this.tagFilter,
      storeOrder: this.store.enabledFiles().map((file) => file.name)
    };
  }

  /** Filtered and grouped once per change, not once per question asked of it. */
  private data(): NoteList {
    this.list ??= buildList(this.store.all(), this.options());
    return this.list;
  }

  refresh(): void {
    this.list = undefined;
    this.push();
  }

  private push(): void {
    const list = this.data();
    const webview = this.view?.webview;
    if (!webview || !this.ready) {
      return;
    }
    this.post({
      type: 'list',
      // The same icon the Explorer shows for the file, from the user's theme.
      groups: list.groups.map((group) =>
        group.file ? { ...group, icon: this.icons.iconFor(group.file, webview) } : group
      ),
      fonts: this.icons.fonts(webview),
      summary: describeList(list, this.options()),
      total: list.total,
      hasFolder: this.store.root !== undefined
    });
  }

  /** What the file icon theme did, for Show Rendering Diagnostics. */
  iconReport(): IconReport {
    return this.icons.describe();
  }

  /** The notes the list is showing, after the search and any tag filter. */
  visibleIds(): string[] {
    return this.data().visible;
  }

  /** Every row the list draws, for the integration tests. */
  rows(): { id: string; label: string; group?: string }[] {
    return flatten(this.data());
  }

  /** Selects a note's row and scrolls to it, if the list is there to see. */
  reveal(noteId: string): void {
    if (this.view && this.ready) {
      this.post({ type: 'reveal', noteId });
    }
  }

  collapseAll(): void {
    this.post({ type: 'collapseAll' });
  }

  /** Brings the list forward with the cursor in its search box. */
  async focusSearch(): Promise<void> {
    await vscode.commands.executeCommand(`${NotesView.viewType}.focus`);
    if (this.view && this.ready) {
      this.post({ type: 'focusSearch' });
    } else {
      this.pending.focusSearch = true;
    }
  }

  private shell(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const media = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    const cross =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${media('notes.css')}">
</head>
<body>
<div id="boxes">
  <button id="toggle" type="button" aria-expanded="false" aria-controls="excludeField" title="Show the exclude box">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
  </button>
  <div id="fields">
    <div class="field">
      <input id="query" type="text" placeholder="Search notes" aria-label="Search notes" spellcheck="false">
      <button class="clear" type="button" title="Clear" aria-label="Clear search">${cross}</button>
    </div>
    <div class="field" id="excludeField" hidden>
      <input id="exclude" type="text" placeholder="Exclude" aria-label="Exclude notes matching" spellcheck="false">
      <button class="clear" type="button" title="Clear" aria-label="Clear exclude">${cross}</button>
    </div>
  </div>
</div>
<div id="summary"></div>
<div id="list" role="tree" tabindex="0" aria-label="Notes"></div>
<div id="empty" hidden></div>
<script nonce="${nonce}" src="${media('notes.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
