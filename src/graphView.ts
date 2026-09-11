import * as vscode from 'vscode';
import { NoteStore } from './store';
import { buildGraph } from './core/refs';
import { Diagnostics } from './diagnostics';
import { NotePanel } from './notePanel';
import { NOTE_SCHEME } from './noteDocuments';

/**
 * The note graph, living in the bottom panel next to Terminal and Problems the
 * way GitLens's commit graph does, rather than taking an editor tab.
 */
export class GraphView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'laxative.graphView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private sentFocus?: string | null;

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
      (msg: { type: string; id?: string; reveal?: boolean }) => {
        if (msg.type === 'ready') {
          this.push();
        } else if (msg.type === 'painted') {
          this.diagnostics.record('graph', msg as Record<string, unknown>);
        } else if (msg.type === 'open' && msg.id) {
          void this.open(msg.id, msg.reveal === true);
        } else if (msg.type === 'reveal' && msg.id) {
          void vscode.commands.executeCommand('laxative.revealNote', msg.id);
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
  <div class="menu-anchor">
    <button id="optionsButton" type="button" aria-haspopup="true" aria-expanded="false"
      aria-controls="options">Options <span aria-hidden="true">&#9662;</span></button>
    <div id="options" role="menu" aria-label="Graph options" hidden>
      <label role="menuitemcheckbox"><input id="showFiles" type="checkbox" checked> Link notes in the same file</label>
      <label role="menuitemcheckbox"><input id="showTags" type="checkbox" checked> Link notes sharing a hashtag</label>
      <label role="menuitemcheckbox"><input id="showTip" type="checkbox" checked> Show details on hover</label>
      <hr>
      <label role="menuitemcheckbox"><input id="openReveals" type="checkbox"> Go to code when opening a note</label>
    </div>
  </div>
  <button id="tidy" type="button" title="Lay the notes out automatically again">Tidy</button>
  <span id="stats"></span>
</div>
<canvas id="canvas"></canvas>
<div id="tip" hidden></div>
<script nonce="${nonce}" src="${media('graph.js')}"></script>
</body>
</html>`;
  }

  private push(): void {
    if (!this.view) {
      return;
    }
    const graph = buildGraph(this.store.all());
    void this.view.webview.postMessage({
      type: 'graph',
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        file: n.file,
        line: n.line,
        character: n.character,
        tags: n.tags,
        excerpt: n.body.slice(0, 240)
      })),
      edges: graph.edges,
      broken: graph.broken,
      focus: (this.sentFocus = this.focusedNote())
    });
  }

  /**
   * Opens a note from the graph, going to its code first when the graph's
   * "Go to code when opening" option is on: the code settles into its own
   * column before the reading panel opens beside it, as the Notes view does.
   */
  private async open(id: string, reveal: boolean): Promise<void> {
    if (reveal) {
      await vscode.commands.executeCommand('laxative.revealNote', id);
    }
    await vscode.commands.executeCommand('laxative.openNote', id);
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
