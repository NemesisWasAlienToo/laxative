import * as vscode from 'vscode';
import { NoteStore } from './store';
import { buildGraph } from './core/refs';
import { Diagnostics } from './diagnostics';

/**
 * The note graph, living in the bottom panel next to Terminal and Problems the
 * way GitLens's commit graph does, rather than taking an editor tab.
 */
export class GraphView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'laxative.graphView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: NoteStore,
    private readonly extensionUri: vscode.Uri,
    private readonly diagnostics: Diagnostics
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(GraphView.viewType, this, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      store.onDidChange(() => this.push())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string }) => {
        if (msg.type === 'ready') {
          this.push();
        } else if (msg.type === 'painted') {
          this.diagnostics.record('graph', msg as Record<string, unknown>);
        } else if (msg.type === 'open' && msg.id) {
          void vscode.commands.executeCommand('laxative.openNote', msg.id);
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
  <label><input id="showFiles" type="checkbox" checked> link same file</label>
  <label><input id="showTags" type="checkbox" checked> link same hashtag</label>
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
      broken: graph.broken
    });
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
