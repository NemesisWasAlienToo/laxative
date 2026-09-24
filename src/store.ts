import * as vscode from 'vscode';
import { Note } from './core/types';
import { deriveTitle, newId, parse, serialize, sortNotes } from './core/schema';
import { parseTags } from './core/tags';
import {
  NOTES_DIR,
  NoteFileConfig,
  activeNames,
  discoverFiles,
  nameFromPath,
  pathForName
} from './core/noteFiles';

export type ImportMode = 'merge' | 'replace';

/** One notes file on disk, and the state needed to read and write it safely. */
class NoteFile {
  notes: Note[] = [];
  private lastWritten = '';
  /** Guards against reloading stale content while our own write is in flight. */
  private writesInFlight = 0;
  private writeGeneration = 0;
  private watcher?: vscode.FileSystemWatcher;

  constructor(
    readonly config: NoteFileConfig,
    readonly uri: vscode.Uri
  ) {}

  get name(): string {
    return this.config.name;
  }

  watch(root: vscode.Uri, onExternal: () => void): void {
    this.watcher?.dispose();
    const relative = this.uri.path.slice(root.path.length + 1);
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, relative)
    );
    // Picks up `git checkout`, `git pull`, or a teammate's edit to the file.
    this.watcher.onDidChange(onExternal);
    this.watcher.onDidCreate(onExternal);
    this.watcher.onDidDelete(onExternal);
  }

  private async readFile(): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri));
    } catch {
      return undefined;
    }
  }

  async read(): Promise<void> {
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
      // Every note remembers which file it came from, so edits go back where
      // they belong however many files are switched on.
      this.notes = (text ? parse(text) : []).map((note) => ({ ...note, store: this.name }));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Laxative: could not parse ${this.uri.fsPath}: ${String(err)}`
      );
      this.notes = [];
    }
  }

  /** True when the file on disk differs from what we last wrote. */
  async changedOnDisk(): Promise<boolean> {
    return ((await this.readFile()) ?? '') !== this.lastWritten;
  }

  async persist(): Promise<void> {
    const text = serialize(this.notes);
    this.writesInFlight++;
    this.writeGeneration++;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.uri, '..'));
      // Write beside the target and rename over it, so a reader (or a crash)
      // never sees a half-written notes file.
      const temporary = this.uri.with({ path: `${this.uri.path}.tmp` });
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(text));
      await vscode.workspace.fs.rename(temporary, this.uri, { overwrite: true });
      // Only once the bytes are on disk, so a watcher event that arrives
      // mid-write is never mistaken for an external change.
      this.lastWritten = text;
    } finally {
      this.writesInFlight--;
    }
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}

/**
 * Owns the note files. They are whatever `.laxative/` holds — the folder is
 * the list, so there is nothing to keep in step with it — and any number of
 * them can be switched on at once; everything else in the extension reads the
 * notes from whichever are on, and reacts to `onDidChange`.
 */
export class NoteStore implements vscode.Disposable {
  /** The enabled files, loaded. `files()` means annotated source files. */
  private loaded: NoteFile[] = [];
  private merged: Note[] = [];
  // Looked up on every cursor movement, every CodeLens request and every
  // decoration pass, so these are indexes rather than scans of every note.
  private byId = new Map<string, Note>();
  private bySource = new Map<string, Note[]>();
  /** Every note file in the folder, switched on or not, as last discovered. */
  private discovered: NoteFileConfig[] = [];
  /** The note-file settings the current state was loaded from. */
  private loadedFrom = '';
  /** Watches for note files appearing in or leaving the folder. */
  private folderWatcher?: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          (e.affectsConfiguration('laxative.activeNoteFiles') ||
            e.affectsConfiguration('laxative.defaultNoteFile')) &&
          // Changing them through this class reloads already; the event that
          // follows would only do the same work, and redraw everything, again.
          this.settingsKey() !== this.loadedFrom
        ) {
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

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('laxative');
  }

  /** Every note file in the folder, switched on or not. */
  noteFiles(): NoteFileConfig[] {
    return this.discovered;
  }

  /** What `.laxative/` holds right now, and which of it is switched on. */
  private async discover(): Promise<NoteFileConfig[]> {
    const root = this.root;
    if (!root) {
      return [];
    }
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, NOTES_DIR));
    } catch {
      // No folder yet; the first note makes it.
    }
    return discoverFiles(
      entries.filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => name),
      this.config().get<unknown>('activeNoteFiles', [])
    );
  }

  /** The files notes are being read from and written to right now. */
  enabledFiles(): NoteFileConfig[] {
    return this.loaded.map((file) => file.config);
  }

  /**
   * Where a new note goes: the file named by `laxative.defaultNoteFile` when it
   * is one of the enabled ones, otherwise the first enabled file.
   */
  defaultFile(): string | undefined {
    const wanted = this.config().get<string>('defaultNoteFile', '').trim();
    const match = this.loaded.find((file) => file.name.toLowerCase() === wanted.toLowerCase());
    return (match ?? this.loaded[0])?.name;
  }

  uriOf(name: string): vscode.Uri | undefined {
    const root = this.root;
    const config = this.noteFiles().find((file) => file.name === name);
    return root && config ? vscode.Uri.joinPath(root, ...config.path.split('/')) : undefined;
  }

  /** The file a new note would be written to; also what "the store file" means. */
  get storeUri(): vscode.Uri | undefined {
    const name = this.defaultFile();
    return name ? this.uriOf(name) : undefined;
  }

  /** Which note file a note lives in. */
  storeOf(id: string): string | undefined {
    return this.get(id)?.store;
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  private get target(): vscode.ConfigurationTarget {
    return this.root
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  /**
   * Switches note files on or off, by name. Switching every one on is written
   * as nothing at all, so a file added later is on as well rather than hidden
   * by a list drawn up before it existed.
   */
  async setEnabled(names: readonly string[]): Promise<void> {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const on = this.discovered
      .filter((file) => wanted.has(file.name.toLowerCase()))
      .map((file) => file.name);
    await this.config().update(
      'activeNoteFiles',
      on.length === this.discovered.length ? [] : on,
      this.target
    );
    await this.reload();
  }

  /**
   * Creates an empty note file. The folder is the list, so writing the file is
   * what adds it; it is switched on, whatever was chosen before.
   */
  async addNoteFile(name: string): Promise<NoteFileConfig | undefined> {
    const root = this.root;
    if (!root) {
      return undefined;
    }
    const path = pathForName(name, this.discovered.map((file) => file.path));
    const uri = vscode.Uri.joinPath(root, ...path.split('/'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serialize([])));
    const active = activeNames(this.config().get<unknown>('activeNoteFiles', []));
    if (active.length > 0) {
      await this.config().update('activeNoteFiles', [...active, nameFromPath(path)], this.target);
    }
    await this.reload();
    return this.discovered.find((file) => file.path === path);
  }

  /** Deletes a note file, notes and all. To the trash, so it can be got back. */
  async deleteNoteFile(name: string): Promise<boolean> {
    const config = this.discovered.find((file) => file.name === name);
    const root = this.root;
    if (!config || !root) {
      return false;
    }
    const uri = vscode.Uri.joinPath(root, ...config.path.split('/'));
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
    await this.forgetName(config.name);
    await this.reload();
    return true;
  }

  /** Renames the file, which is what a note file's name is. */
  async renameNoteFile(name: string, to: string): Promise<NoteFileConfig | undefined> {
    const config = this.discovered.find((file) => file.name === name);
    const root = this.root;
    if (!config || !root) {
      return undefined;
    }
    const path = pathForName(to, this.discovered.map((file) => file.path));
    await vscode.workspace.fs.rename(
      vscode.Uri.joinPath(root, ...config.path.split('/')),
      vscode.Uri.joinPath(root, ...path.split('/')),
      { overwrite: false }
    );
    await this.forgetName(config.name, nameFromPath(path));
    await this.reload();
    return this.discovered.find((file) => file.path === path);
  }

  /** Settings address a file by name, so a rename or a delete has to reach them. */
  private async forgetName(from: string, to?: string): Promise<void> {
    const config = this.config();
    const active = activeNames(config.get<unknown>('activeNoteFiles', []));
    const gone = (name: string) => name.toLowerCase() === from.toLowerCase();
    if (active.some(gone)) {
      const next = active.filter((name) => !gone(name));
      await config.update('activeNoteFiles', to ? [...next, to] : next, this.target);
    }
    if (gone(config.get<string>('defaultNoteFile', '').trim())) {
      await config.update('defaultNoteFile', to ?? '', this.target);
    }
  }

  private settingsKey(): string {
    return JSON.stringify([
      activeNames(this.config().get<unknown>('activeNoteFiles', [])),
      this.config().get<string>('defaultNoteFile', ''),
      this.root?.toString()
    ]);
  }

  async reload(): Promise<void> {
    this.loadedFrom = this.settingsKey();
    const root = this.root;
    this.discovered = await this.discover();
    const wanted = this.discovered.filter((file) => file.enabled);
    for (const file of this.loaded) {
      file.dispose();
    }
    this.loaded = root
      ? wanted.map(
          (config) => new NoteFile(config, vscode.Uri.joinPath(root, ...config.path.split('/')))
        )
      : [];

    for (const file of this.loaded) {
      await file.read();
      if (root) {
        file.watch(root, () => void this.reloadIfChangedOnDisk(file));
      }
    }
    this.watchFolder();
    this.remerge();
    this.emitter.fire();
  }

  /**
   * One list of notes across every enabled file. Ids address notes — a `[[ref]]`
   * names one — so if two files happen to use the same id, the first file wins
   * and the other copy is left out rather than making references ambiguous.
   */
  private remerge(): void {
    const seen = new Set<string>();
    const notes: Note[] = [];
    for (const file of this.loaded) {
      for (const note of file.notes) {
        if (!seen.has(note.id)) {
          seen.add(note.id);
          notes.push(note);
        }
      }
    }
    this.merged = sortNotes(notes);
    this.byId = new Map(this.merged.map((note) => [note.id, note]));
    this.bySource = new Map();
    for (const note of this.merged) {
      if (note.file === undefined) {
        continue; // A note about no line of code is on no source file either.
      }
      // `merged` is sorted by file, then line, then column, so each list is
      // already in the order the file is read.
      const list = this.bySource.get(note.file);
      if (list) {
        list.push(note);
      } else {
        this.bySource.set(note.file, [note]);
      }
    }
  }

  /** A note file appearing in the folder, or leaving it, changes the list. */
  private watchFolder(): void {
    const root = this.root;
    if (this.folderWatcher || !root) {
      return;
    }
    this.folderWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `${NOTES_DIR}/*.json`)
    );
    const look = () => void this.rediscover();
    this.folderWatcher.onDidCreate(look);
    this.folderWatcher.onDidDelete(look);
  }

  /** Our own writes land here too, so nothing is done unless the list differs. */
  private async rediscover(): Promise<void> {
    const found = await this.discover();
    if (JSON.stringify(found) !== JSON.stringify(this.discovered)) {
      await this.reload();
    }
  }

  private async reloadIfChangedOnDisk(file: NoteFile): Promise<void> {
    if (!(await file.changedOnDisk())) {
      return; // Our own write echoing back.
    }
    await file.read();
    this.remerge();
    this.emitter.fire();
  }

  private fileOf(id: string): NoteFile | undefined {
    return this.loaded.find((file) => file.notes.some((note) => note.id === id));
  }

  private fileNamed(name: string | undefined): NoteFile | undefined {
    return name ? this.loaded.find((file) => file.name === name) : undefined;
  }

  private async persist(file: NoteFile): Promise<void> {
    file.notes = sortNotes(file.notes);
    await file.persist();
    this.remerge();
    this.emitter.fire();
  }

  all(): readonly Note[] {
    return this.merged;
  }

  get(id: string): Note | undefined {
    return this.byId.get(id);
  }

  /** The notes on one source file, in the order they appear in it. */
  byFile(file: string): readonly Note[] {
    return this.bySource.get(file) ?? [];
  }

  /** Annotated source files, across every enabled note file. */
  files(): string[] {
    return [...this.bySource.keys()].sort();
  }

  /**
   * A new note. Leave the location out and it is a note about the workspace
   * rather than about a line in it.
   */
  async create(
    input: {
      file?: string;
      line?: number;
      character?: number;
      body: string;
    },
    target?: string
  ): Promise<Note | undefined> {
    const file = this.fileNamed(target) ?? this.fileNamed(this.defaultFile());
    if (!file) {
      return undefined;
    }
    const now = new Date().toISOString();
    const note: Note = {
      id: newId(new Set(this.merged.map((n) => n.id))),
      title: deriveTitle(input.body),
      body: input.body,
      ...(input.file !== undefined
        ? { file: input.file, line: input.line ?? 0, character: input.character ?? 0 }
        : {}),
      tags: parseTags(input.body),
      store: file.name,
      createdAt: now,
      updatedAt: now
    };
    file.notes = [...file.notes, note];
    await this.persist(file);
    return note;
  }

  async update(
    id: string,
    patch: Partial<Omit<Note, 'id' | 'createdAt'>>
  ): Promise<Note | undefined> {
    const file = this.fileOf(id);
    const note = file?.notes.find((n) => n.id === id);
    if (!file || !note) {
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
    await this.persist(file);
    return note;
  }

  async remove(id: string): Promise<boolean> {
    const file = this.fileOf(id);
    if (!file) {
      return false;
    }
    file.notes = file.notes.filter((n) => n.id !== id);
    await this.persist(file);
    return true;
  }

  /** Moves a note to another note file, keeping its id and its references. */
  async moveToFile(id: string, target: string): Promise<boolean> {
    const from = this.fileOf(id);
    const to = this.fileNamed(target);
    const note = from?.notes.find((n) => n.id === id);
    if (!from || !to || !note || from === to) {
      return false;
    }
    from.notes = from.notes.filter((n) => n.id !== id);
    to.notes = [...to.notes, { ...note, store: to.name, updatedAt: new Date().toISOString() }];
    from.notes = sortNotes(from.notes);
    to.notes = sortNotes(to.notes);
    await from.persist();
    await to.persist();
    this.remerge();
    this.emitter.fire();
    return true;
  }

  /** Used by import. `merge` keeps existing notes and skips colliding imports. */
  async importNotes(incoming: Note[], mode: ImportMode, target?: string): Promise<number> {
    const file = this.fileNamed(target) ?? this.fileNamed(this.defaultFile());
    if (!file) {
      return 0;
    }
    const stamped = incoming.map((note) => ({ ...note, store: file.name }));
    if (mode === 'replace') {
      file.notes = stamped;
      await this.persist(file);
      return stamped.length;
    }
    const existing = new Set(this.merged.map((n) => n.id));
    const added: Note[] = [];
    for (const note of stamped) {
      if (existing.has(note.id)) {
        continue; // Same id means same note; keep the local copy.
      }
      existing.add(note.id);
      added.push(note);
    }
    file.notes = [...file.notes, ...added];
    await this.persist(file);
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
    this.folderWatcher?.dispose();
    for (const file of this.loaded) {
      file.dispose();
    }
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
