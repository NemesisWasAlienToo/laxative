import * as vscode from 'vscode';
import { NoteStore } from './store';
import { CodeIndex, Placement } from './core/anchoring';
import { located } from './core/display';
import { record } from './timing';

/** How long a check took, for the integration tests and for measuring. */
export interface CheckReport {
  files: number;
  notes: number;
  /** How many notes are on a different line or column than before. */
  moved: number;
  ms: number;
}

/**
 * Edits in an editor: wait until you have stopped typing for a moment, rather
 * than moving notes on every key.
 */
const EDIT_DELAY = 1500;
/** A pull or a checkout writes many files at once; one look at each. */
const DISK_DELAY = 100;
/** Files read at the same time during a full check. */
const PARALLEL_READS = 16;

/**
 * Keeps notes on their code. A file is checked when it changes — on disk, from
 * a terminal, a patch or git, or in an editor — and only that file. Every file
 * with notes is checked once when the notes are loaded (at startup, and when a
 * note file changes on disk), since anything could have happened while the
 * window was closed.
 */
export class AnchorTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Files waiting to be checked. A pull changes many files a few milliseconds
   * apart; they are checked together, and the note file written once, rather
   * than rewritten once for every file.
   */
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  /** Checks run one at a time, so an older result never lands after a newer one. */
  private queue: Promise<unknown> = Promise.resolve();
  private startedUp = false;

  constructor(private readonly store: NoteStore) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const fromDisk = (uri: vscode.Uri) => this.schedule(uri, DISK_DELAY);
    this.disposables.push(
      watcher,
      watcher.onDidChange(fromDisk),
      watcher.onDidCreate(fromDisk),
      watcher.onDidDelete(fromDisk),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.schedule(e.document.uri, EDIT_DELAY);
        }
      }),
      // Closed without saving: what counts again is what is on disk.
      vscode.workspace.onDidCloseTextDocument((document) => this.schedule(document.uri, 0)),
      // A safety net for a change the watcher missed (on Linux, a folder made
      // in the same instant as its parent can go unwatched): the file you open
      // is checked, so its marks are never drawn on the wrong lines.
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document.uri, 0)),
      store.onDidLoad(() => void this.checkAll())
    );
  }

  private schedule(uri: vscode.Uri, delay: number): void {
    const file = this.store.relativePath(uri);
    // Most files have no notes; those cost a map look-up and nothing else.
    if (!file || this.store.byFile(file).length === 0) {
      return;
    }
    this.pending.add(file);
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const files = [...this.pending];
      this.pending.clear();
      void this.checkFiles(files, undefined, files.length === 1 ? 'check one file' : 'check changed files');
    }, delay);
  }

  /** What the user sees: the editor's text when the file is open, else the disk. */
  private async textOf(file: string, open: Map<string, vscode.TextDocument>): Promise<string | undefined> {
    const uri = this.store.absoluteUri(file);
    if (!uri) {
      return undefined;
    }
    const document = open.get(uri.toString());
    if (document) {
      return document.getText();
    }
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined; // Deleted, or on another branch: its notes are lost for now.
    }
  }

  /** Re-anchors the notes on these files. Runs after any check already going. */
  checkFiles(
    files: readonly string[],
    onFile?: () => void,
    label = files.length === 1 ? 'check one file' : 'check all files'
  ): Promise<CheckReport> {
    const run = this.queue.then(() => this.check(files, label, onFile));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async check(
    files: readonly string[],
    label: string,
    onFile?: () => void
  ): Promise<CheckReport> {
    const started = performance.now();
    const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    const placements = new Map<string, Placement | null>();
    let notes = 0;
    for (let i = 0; i < files.length; i += PARALLEL_READS) {
      const batch = files.slice(i, i + PARALLEL_READS);
      const texts = await Promise.all(batch.map((file) => this.textOf(file, open)));
      batch.forEach((file, j) => {
        const text = texts[j];
        // All of a file's notes at once: where its other notes went says where
        // a note on a repeated line went.
        const onLines = this.store.byFile(file).filter(located);
        const found = text === undefined ? [] : new CodeIndex(text).findAll(onLines);
        onLines.forEach((note, k) => placements.set(note.id, found[k] ?? null));
        notes += onLines.length;
        onFile?.();
      });
    }
    const moved = await this.store.reanchor(placements);
    const ms = performance.now() - started;
    if (files.length > 0) {
      record(label, ms);
    }
    return { files: files.length, notes, moved, ms };
  }

  /**
   * Every file with notes. The first time, at startup, with a progress bar;
   * afterwards in the status bar, so a teammate's pull doesn't pop anything up.
   */
  checkAll(): Promise<CheckReport> {
    const files = this.store.files();
    const first = !this.startedUp;
    this.startedUp = true;
    if (files.length === 0) {
      return this.checkFiles(files); // Nothing to show a bar for.
    }
    return Promise.resolve(
      vscode.window.withProgress(
        {
          location: first ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: 'Laxative: finding where notes are'
        },
        (progress) => {
          let done = 0;
          return this.checkFiles(files, () => {
            done++;
            progress.report({
              increment: 100 / Math.max(files.length, 1),
              message: `${done} of ${files.length} files`
            });
          });
        }
      )
    );
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
