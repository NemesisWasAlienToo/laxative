import * as vscode from 'vscode';
import { Note } from './core/types';
import { deriveTitle, newId, parse, serialize, sortNotes } from './core/schema';
import { parseTags } from './core/tags';

export type ImportMode = 'merge' | 'replace';

/**
 * Owns the on-disk notes file. Everything else in the extension reads notes
 * from here and reacts to `onDidChange`.
 */
export class NoteStore implements vscode.Disposable {
  private notes: Note[] = [];
  private lastWritten = '';
  /** Guards against reloading stale content while our own write is in flight. */
  private writesInFlight = 0;
  private writeGeneration = 0;
  private watcher?: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('laxative.storeFile')) {
          void this.reload();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reload())
    );
  }

  /** Notes are anchored relative to the first workspace folder. */
  get root(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  get storeUri(): vscode.Uri | undefined {
    const root = this.root;
    if (!root) {
      return undefined;
    }
    const configured = vscode.workspace
      .getConfiguration('laxative')
      .get<string>('storeFile', '.laxative/notes.json');
    return vscode.Uri.joinPath(root, ...configured.split(/[\\/]+/).filter(Boolean));
  }

  async initialize(): Promise<void> {
    await this.reload();
    this.watchStoreFile();
  }

  private watchStoreFile(): void {
    this.watcher?.dispose();
    const root = this.root;
    const uri = this.storeUri;
    if (!root || !uri) {
      return;
    }
    const relative = uri.path.slice(root.path.length + 1);
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, relative)
    );
    // Picks up `git checkout`, `git pull`, or a teammate's edit to the file.
    const onExternal = () => void this.reloadIfChangedOnDisk();
    this.watcher.onDidChange(onExternal);
    this.watcher.onDidCreate(onExternal);
    this.watcher.onDidDelete(onExternal);
  }

  private async readFile(): Promise<string | undefined> {
    const uri = this.storeUri;
    if (!uri) {
      return undefined;
    }
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  async reload(): Promise<void> {
    // Re-read if one of our own writes lands while we are reading: applying the
    // older content would silently drop notes that were just created.
    let text: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const generation = this.writeGeneration;
      text = await this.readFile();
      if (this.writesInFlight === 0 && generation === this.writeGeneration) {
        break;
      }
      if (attempt === 4) {
        return; // Writes keep coming; their state is newer than anything on disk.
      }
    }
    this.lastWritten = text ?? '';
    try {
      this.notes = text ? parse(text) : [];
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Laxative: could not parse ${this.storeUri?.fsPath}: ${String(err)}`
      );
      this.notes = [];
    }
    this.watchStoreFile();
    this.emitter.fire();
  }

  private async reloadIfChangedOnDisk(): Promise<void> {
    const text = (await this.readFile()) ?? '';
    if (text === this.lastWritten) {
      return; // Our own write echoing back.
    }
    await this.reload();
  }

  private async persist(): Promise<void> {
    const uri = this.storeUri;
    if (!uri) {
      return;
    }
    const text = serialize(this.notes);
    this.writesInFlight++;
    this.writeGeneration++;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      // Write beside the target and rename over it, so a reader (or a crash)
      // never sees a half-written notes file.
      const temporary = uri.with({ path: `${uri.path}.tmp` });
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(text));
      await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
      // Only once the bytes are on disk, so a watcher event that arrives
      // mid-write is never mistaken for an external change.
      this.lastWritten = text;
    } finally {
      this.writesInFlight--;
    }
    this.emitter.fire();
  }

  all(): readonly Note[] {
    return this.notes;
  }

  get(id: string): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  byFile(file: string): Note[] {
    return this.notes
      .filter((n) => n.file === file)
      .sort((a, b) => a.line - b.line || a.character - b.character);
  }

  files(): string[] {
    return [...new Set(this.notes.map((n) => n.file))].sort();
  }


  async create(input: {
    file: string;
    line: number;
    character: number;
    body: string;
  }): Promise<Note> {
    const now = new Date().toISOString();
    const note: Note = {
      id: newId(new Set(this.notes.map((n) => n.id))),
      title: deriveTitle(input.body),
      body: input.body,
      file: input.file,
      line: input.line,
      character: input.character,
      tags: parseTags(input.body),
      createdAt: now,
      updatedAt: now
    };
    this.notes = sortNotes([...this.notes, note]);
    await this.persist();
    return note;
  }

  async update(id: string, patch: Partial<Omit<Note, 'id' | 'createdAt'>>): Promise<Note | undefined> {
    const note = this.get(id);
    if (!note) {
      return undefined;
    }
    Object.assign(note, patch);
    if (patch.body !== undefined) {
      note.tags = parseTags(patch.body);
      if (patch.title === undefined) {
        note.title = deriveTitle(patch.body);
      }
    }
    note.updatedAt = new Date().toISOString();
    this.notes = sortNotes(this.notes);
    await this.persist();
    return note;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  /** Used by import. `merge` keeps existing notes and re-ids colliding imports. */
  async importNotes(incoming: Note[], mode: ImportMode): Promise<number> {
    if (mode === 'replace') {
      this.notes = sortNotes(incoming);
      await this.persist();
      return incoming.length;
    }
    const existing = new Set(this.notes.map((n) => n.id));
    const added: Note[] = [];
    for (const note of incoming) {
      if (existing.has(note.id)) {
        continue; // Same id means same note; keep the local copy.
      }
      existing.add(note.id);
      added.push(note);
    }
    this.notes = sortNotes([...this.notes, ...added]);
    await this.persist();
    return added.length;
  }

  /** Workspace-relative, posix path for a document uri, or undefined if outside. */
  relativePath(uri: vscode.Uri): string | undefined {
    const root = this.root;
    if (!root || uri.scheme !== 'file') {
      return undefined;
    }
    const rootPath = root.path.endsWith('/') ? root.path : root.path + '/';
    return uri.path.startsWith(rootPath) ? uri.path.slice(rootPath.length) : undefined;
  }

  absoluteUri(file: string): vscode.Uri | undefined {
    const root = this.root;
    return root ? vscode.Uri.joinPath(root, ...file.split('/')) : undefined;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
