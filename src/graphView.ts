import * as vscode from 'vscode';
import { NoteStore } from './store';
import { buildGraph } from './core/refs';
import { Diagnostics } from './diagnostics';
import { NotePanel } from './notePanel';
import { NOTE_SCHEME } from './noteDocuments';
import { record, timed } from './timing';

/** What a note's context menu in the graph may ask for, and nothing else. */
const NODE_COMMANDS = new Set([
  'laxative.openNote',
  'laxative.revealNote',
  'laxative.editNote',
  'laxative.copyReference',
  'laxative.deleteNote'
]);

/**
 * The note graph, living in the bottom panel next to Terminal and Problems the
 * way GitLens's commit graph does, rather than taking an editor tab.
 */
export class GraphView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'laxative.graphView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private sentFocus?: string | null;
  /** When the notes were last sent, to time the frame that draws them. */
  private sentAt?: number;
  private benchmarkReply?: (results: unknown) => void;

  /**
   * Has the graph time its own drawing at each zoom level, in the real
   * webview: how long a frame takes to draw is only measurable where it is
   * drawn. For the performance tests.
   */
  benchmark(scales: number[]): Promise<unknown> {
    const view = this.view;
    if (!view) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      // A webview that never answers must not leave the caller waiting forever.
      const timer = setTimeout(() => {
        this.benchmarkReply = undefined;
        resolve(undefined);
      }, 30000);
      this.benchmarkReply = (results) => {
        clearTimeout(timer);
        resolve(results);
      };
      void view.webview.postMessage({ type: 'benchmark', scales });
    });
  }

  /** Opens or closes groups in the graph, the way its menu does. For the tests. */
  groups(action: { action: string; path?: string; mode?: string }): void {
    void this.view?.webview.postMessage({ type: 'groups', ...action });
  }

  constructor(
    private readonly store: NoteStore,
    private readonly extensionUri: vscode.Uri,
    private readonly diagnostics: Diagnostics
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(GraphView.viewType, this, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      store.onDidChange(() => this.push()),
      NotePanel.onDidChange(() => this.pushFocus()),
      vscode.window.onDidChangeActiveTextEditor(() => this.pushFocus())
    );
  }

  /**
   * The note you are looking at: the one whose editor is active, or else the
   * one on show in the reading panel. The graph rings it, so you can see where
   * the note you have open sits among the others.
   */
  private focusedNote(): string | null {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === NOTE_SCHEME && this.store.get(uri.authority)) {
      return uri.authority;
    }
    return NotePanel.shownNote() ?? null;
  }

  private pushFocus(): void {
    const focus = this.focusedNote();
    if (!this.view || focus === this.sentFocus) {
      return;
    }
    this.sentFocus = focus;
    void this.view.webview.postMessage({ type: 'focus', id: focus });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string; reveal?: boolean; open?: boolean; command?: string }) => {
        if (msg.type === 'ready') {
          this.push();
        } else if (msg.type === 'painted') {
          this.diagnostics.record('graph', msg as Record<string, unknown>);
          // From sending the notes to the first frame that shows them.
          // A frame only reports when what it shows changes, so only a frame
          // with the notes just sent ends the timing.
          if (
            this.sentAt !== undefined &&
            (msg as { nodes?: unknown }).nodes === this.store.all().length
          ) {
            record('graph paint', performance.now() - this.sentAt);
            this.sentAt = undefined;
          }
        } else if (msg.type === 'benchmark') {
          this.benchmarkReply?.((msg as { results?: unknown }).results);
          this.benchmarkReply = undefined;
        } else if (msg.type === 'open' && msg.id) {
          void this.open(msg.id, msg.reveal === true, msg.open !== false);
        } else if (msg.type === 'reveal' && msg.id) {
          void vscode.commands.executeCommand('laxative.revealNote', msg.id);
        } else if (msg.type === 'group' && Array.isArray((msg as { ids?: unknown }).ids)) {
          void vscode.commands.executeCommand('laxative.moveToGroup', {
            ids: (msg as unknown as { ids: unknown[] }).ids.map(String)
          });
        } else if (msg.type === 'note' && msg.id && msg.command && NODE_COMMANDS.has(msg.command)) {
          void vscode.commands.executeCommand(msg.command, msg.id);
        }
      },
      null,
      this.disposables
    );
    view.onDidDispose(() => (this.view = undefined), null, this.disposables);
    view.webview.html = this.shell(view.webview);
    this.push();
  }

  private shell(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const media = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${media('graph.css')}">
</head>
<body>
<div id="hud">
  <input id="filter" type="text" placeholder="Filter notes...">
  <input id="exclude" type="text" placeholder="Exclude..." title="Hide notes matching any of these terms">
  <span id="stats"></span>
</div>
<canvas id="canvas"></canvas>
<div id="options" class="menu" role="menu" aria-label="Graph options" hidden>
  <div id="groupHead" hidden></div>
  <label role="menuitemcheckbox" title="Notes ending their first line in @name are grouped by it; @a/b is group b inside group a"><input id="groupByMark" type="checkbox" checked><span class="mark"></span>Group by @group</label>
  <label role="menuitemcheckbox" title="Notes grouped by the folders and file they are on"><input id="groupByPath" type="checkbox"><span class="mark"></span>Group by folder and file</label>
  <button id="expandAll" type="button" role="menuitem"><span class="mark"></span>Expand all groups</button>
  <button id="collapseAll" type="button" role="menuitem"><span class="mark"></span>Collapse all groups</button>
  <hr>
  <label role="menuitemcheckbox"><input id="showFiles" type="checkbox" checked><span class="mark"></span>Link notes in the same file</label>
  <label role="menuitemcheckbox"><input id="showTags" type="checkbox" checked><span class="mark"></span>Link notes sharing a hashtag</label>
  <label role="menuitemcheckbox" title="Off: linked notes stay wherever you put them. Links are still drawn, and Tidy still lays notes out by them."><input id="linkPull" type="checkbox" checked><span class="mark"></span>Links pull notes together</label>
  <label role="menuitemcheckbox"><input id="showTip" type="checkbox" checked><span class="mark"></span>Show details on hover</label>
  <hr>
  <label role="menuitemcheckbox"><input id="openNote" type="checkbox" checked><span class="mark"></span>Double-click opens the note</label>
  <label role="menuitemcheckbox"><input id="openReveals" type="checkbox"><span class="mark"></span>Double-click goes to the code</label>
  <hr>
  <button id="tidy" type="button" role="menuitem"><span class="mark"></span>Lay the notes out again</button>
</div>
<div id="nodeMenu" class="menu" role="menu" aria-label="Note" hidden></div>
<div id="tip" hidden></div>
<script nonce="${nonce}" src="${media('graph.js')}"></script>
</body>
</html>`;
  }

  private push(): void {
    // Before the notes are read, an empty graph would say there are none; the
    // view says it is loading until the first real one arrives.
    if (!this.view || !this.store.ready) {
      return;
    }
    const started = performance.now();
    const graph = buildGraph(this.store.all());
    this.sentAt = started;
    const view = this.view;
    timed('graph send', () => void view.webview.postMessage({
      type: 'graph',
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        file: n.file,
        line: n.line,
        character: n.character,
        lost: n.lost === true,
        tags: n.tags,
        group: n.group ?? null,
        excerpt: n.body.slice(0, 240)
      })),
      edges: graph.edges,
      broken: graph.broken,
      focus: (this.sentFocus = this.focusedNote())
    }));
  }

  /**
   * Opens a note from the graph, going to its code first when the graph's
   * "Go to code when opening" option is on: the code settles into its own
   * column before the reading panel opens beside it, as the Notes view does.
   */
  private async open(id: string, reveal: boolean, open: boolean): Promise<void> {
    if (reveal) {
      await vscode.commands.executeCommand('laxative.revealNote', id);
    }
    if (open) {
      await vscode.commands.executeCommand('laxative.openNote', id);
    }
  }

  /** Brings the graph tab forward in the bottom panel. */
  static async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${GraphView.viewType}.focus`);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
