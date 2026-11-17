import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Note } from '../../core/types';
import { serialize } from '../../core/schema';
import { snippetAt } from '../../core/anchoring';

/**
 * A big project: 600 source files (about 240k lines) and 6,000 notes, 5,000
 * scattered across the files and 1,000 on one large file. Measures loading,
 * checking where notes are, and drawing them, and how long the extension host
 * is blocked at a stretch while it does: that is what makes typing stutter.
 */

const manifest = require('../../../package.json') as { publisher: string; name: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

const DIRS = 30;
const FILES_PER_DIR = 20;
const LINES_PER_FILE = 400;
const SCATTERED = 5000;
const BIG_LINES = 8000;
const BIG_NOTES = 1000;

const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
// A note file of its own, which nothing has opened as a document.
const storePath = () => path.join(root(), '.laxative', 'perf.json');

/** Same numbers every run. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** Code that looks like code: many `}`, blank lines and repeated statements. */
function sourceFile(seed: number, lines: number): string[] {
  const random = rng(seed);
  const out = [`import { helper } from '../shared/helper${seed % 13}';`, ''];
  let fn = 0;
  while (out.length < lines) {
    out.push(`export function handler${seed}_${fn}(input: Input${fn % 9}): Result {`);
    const body = 4 + Math.floor(random() * 14);
    for (let i = 0; i < body && out.length < lines; i++) {
      const r = random();
      out.push(
        r < 0.15
          ? '  if (!input) {'
          : r < 0.25
            ? '    return undefined;'
            : r < 0.32
              ? '  }'
              : r < 0.4
                ? ''
                : r < 0.5
                  ? `  // TODO: revisit step ${i}`
                  : `  const value${i} = helper(input.field${Math.floor(random() * 50)}, ${Math.floor(random() * 1000)});`
      );
    }
    out.push('  return result;', '}', '');
    fn++;
  }
  return out.slice(0, lines);
}

interface Lag {
  stop(): number;
}

/** Longest stretch the extension host could not run anything else. */
function watchLag(): Lag {
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(0, max);
    }
  };
}

type Timings = Record<string, { ms: number; runs: number }>;

async function timings(): Promise<Timings> {
  const report = await vscode.commands.executeCommand<{ timings: Timings }>('laxative._diagnostics');
  return report?.timings ?? {};
}

async function notes(): Promise<{ id: string; line?: number; lost: boolean }[]> {
  const result = await vscode.commands.executeCommand<{ notes: { id: string; line?: number; lost: boolean }[] }>(
    'laxative._notes'
  );
  return result?.notes ?? [];
}

async function until<T>(probe: () => Promise<T | undefined>, what: string, ms = 120000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits for a timing to be recorded again after `before`. */
async function nextRun(name: string, before: Timings, what: string, wait?: number): Promise<number> {
  return until(
    async () => {
      const now = (await timings())[name];
      return now && now.runs > (before[name]?.runs ?? 0) ? now.ms : undefined;
    },
    what,
    wait
  );
}

const results: { step: string; value: string }[] = [];
const report = (step: string, value: string) => {
  results.push({ step, value });
  console.log(`      ${step.padEnd(48)} ${value}`);
};
const ms = (n: number) => `${n.toFixed(0)} ms`;

describe('Performance: 6,000 notes on a 600-file project', function () {
  this.timeout(180000);

  let originalStore: string | undefined;
  const files: string[] = [];
  const sources = new Map<string, string[]>();
  const allNotes: Note[] = [];
  const bigFile = 'perf/big.ts';

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    await extension.activate();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Let whatever check is running finish, so the timings below are ours.
    await vscode.commands.executeCommand('laxative._checkAnchors');
    originalStore = fs.existsSync(storePath()) ? fs.readFileSync(storePath(), 'utf8') : undefined;
    // Every note file switched on, so this one is read.
    await vscode.workspace
      .getConfiguration('laxative')
      .update('activeNoteFiles', undefined, vscode.ConfigurationTarget.Workspace);

    const random = rng(7);
    const now = new Date().toISOString();
    const make = (file: string, line: number, n: number): Note => {
      const lines = sources.get(file)!;
      const id = `p${String(n).padStart(7, '0')}`;
      const other = `p${String(Math.floor(random() * (SCATTERED + BIG_NOTES))).padStart(7, '0')}`;
      const body = `Note ${n} on ${path.basename(file)}\n\nWhy this line matters, and what to watch for when it changes. See [[${other}]]. #area${n % 40} #team${n % 7}`;
      return {
        id,
        title: `Note ${n} on ${path.basename(file)}`,
        body,
        file,
        line,
        character: 2,
        snippet: snippetAt(lines, line),
        tags: [`area${n % 40}`, `team${n % 7}`],
        createdAt: now,
        updatedAt: now
      };
    };

    // The project exists before anything is annotated: on Linux, a folder made
    // in the same instant as its parent can go unwatched, which a real project
    // never does.
    fs.mkdirSync(path.join(root(), 'perf'), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (let d = 0; d < DIRS; d++) {
      fs.mkdirSync(path.join(root(), 'perf', `mod${d}`), { recursive: true });
      for (let f = 0; f < FILES_PER_DIR; f++) {
        const file = `perf/mod${d}/file${f}.ts`;
        const lines = sourceFile(d * 100 + f, LINES_PER_FILE);
        fs.writeFileSync(path.join(root(), file), lines.join('\n'));
        files.push(file);
        sources.set(file, lines);
      }
    }
    const big = sourceFile(99999, BIG_LINES);
    fs.writeFileSync(path.join(root(), bigFile), big.join('\n'));
    sources.set(bigFile, big);

    // Scattered: a few notes on each file, on lines no other note is on.
    const used = new Map<string, Set<number>>();
    let n = 0;
    while (n < SCATTERED) {
      const file = files[Math.floor(random() * files.length)];
      const line = Math.floor(random() * LINES_PER_FILE);
      const taken = used.get(file) ?? new Set<number>();
      if (taken.has(line) || sources.get(file)![line].trim() === '') {
        continue;
      }
      taken.add(line);
      used.set(file, taken);
      allNotes.push(make(file, line, n++));
    }
    for (let i = 0; i < BIG_NOTES; i++) {
      // Every 8th line, so each note has a line of its own to be drawn on.
      allNotes.push(make(bigFile, i * 8 + 5, n++));
    }
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    fs.rmSync(path.join(root(), 'perf'), { recursive: true, force: true });
    if (originalStore !== undefined) {
      fs.writeFileSync(storePath(), originalStore);
    } else {
      fs.rmSync(storePath(), { force: true });
    }
    await vscode.commands.executeCommand('laxative.refresh');
    console.log('\n      Summary');
    for (const { step, value } of results) {
      console.log(`      ${step.padEnd(48)} ${value}`);
    }
  });

  it('loads and checks every note at startup', async () => {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), serialize(allNotes));
    const size = fs.statSync(storePath()).size;
    const before = await timings();
    const lag = watchLag();
    const started = performance.now();
    await vscode.commands.executeCommand('laxative.refresh');
    const checked = await nextRun('check all files', before, 'the startup check');
    const wall = performance.now() - started;
    const blocked = lag.stop();
    const after = await timings();

    report('note file size', `${(size / 1024 / 1024).toFixed(1)} MB`);
    report('load notes (read + parse + index + views)', ms(after['load notes'].ms));
    report('Notes list build', ms(after['notes list'].ms));
    report('check all 601 files (read + match + save)', ms(checked));
    report('startup total, wall clock', ms(wall));
    report('startup: longest host freeze', ms(blocked));

    const loaded = (await notes()).filter((n) => n.id.startsWith('p0'));
    assert.strictEqual(loaded.length, SCATTERED + BIG_NOTES);
    assert.strictEqual(loaded.filter((n) => n.lost).length, 0, 'every note found its code');
  });

  it('draws 1,000 notes in one editor', async () => {
    const before = await timings();
    const document = await vscode.workspace.openTextDocument(path.join(root(), bigFile));
    await vscode.window.showTextDocument(document);
    const marks = await until(async () => {
      const drawn = await vscode.commands.executeCommand<{ gutter: number[] }>('laxative._marks');
      return drawn && drawn.gutter.length === BIG_NOTES ? drawn : undefined;
    }, 'the marks');
    const after = await timings();
    assert.strictEqual(marks.gutter[0], 5);
    assert.ok(after['editor marks'].runs > (before['editor marks']?.runs ?? 0));
    report('editor marks for 1,000 notes', ms(after['editor marks'].ms));
  });

  it('draws the graph of 6,000 notes', async () => {
    const before = await timings();
    await vscode.commands.executeCommand('laxative.showGraph');
    try {
      const painted = await nextRun('graph paint', before, 'the graph', 90000);
      report('graph: send + first frame with 6,000 nodes', ms(painted));
    } catch {
      report('graph: send + first frame with 6,000 nodes', 'not painted within 90 s');
    }
    // Drawing at each zoom level, in the real webview: what zooming costs.
    const zoom = await vscode.commands.executeCommand<{ scale: number; ms: number; shown: number }[]>(
      'laxative._graphBenchmark',
      [0.2, 0.35, 0.6, 1, 2]
    );
    for (const z of zoom ?? []) {
      report(`graph: one frame at zoom ${z.scale} (${z.shown} notes on screen)`, `${z.ms} ms`);
    }
    // Back to the editor, so the next steps type into it.
    if (process.env.PERF_CLOSE_GRAPH) {
      await vscode.commands.executeCommand('workbench.action.closePanel');
    }
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  });

  it('follows a terminal edit of the big file', async () => {
    const before = await timings();
    const lines = sources.get(bigFile)!;
    const added = Array.from({ length: 25 }, (_, i) => `// added from a terminal ${i}`);
    const lag = watchLag();
    const started = performance.now();
    fs.writeFileSync(path.join(root(), bigFile), [...added, ...lines].join('\n'));
    const firstBig = allNotes[SCATTERED].id;
    // Moved, and the move written to disk.
    await nextRun('check one file', before, 'the check of the file');
    await until(async () => {
      const note = (await notes()).find((n) => n.id === firstBig);
      return note?.line === 5 + 25 ? note : undefined;
    }, 'the notes to move');
    const wall = performance.now() - started;
    const blocked = lag.stop();
    const check = (await timings())['check one file'];
    const now = new Map((await notes()).map((n) => [n.id, n]));
    const big = allNotes.slice(SCATTERED);
    assert.ok(big.every((n) => now.get(n.id)?.line === n.line! + 25), 'all 1,000 moved');
    report('terminal edit: check of the 1,000-note file', ms(check.ms));
    report('terminal edit: written to notes moved, wall', ms(wall));
    report('terminal edit: longest host freeze', ms(blocked));
    sources.set(bigFile, [...added, ...lines]);
  });

  it('follows a pull that changes 100 files, some losing code', async () => {
    const changed = files.slice(0, 100);
    const losing = new Set<string>();
    const lag = watchLag();
    const started = performance.now();
    for (const [i, file] of changed.entries()) {
      let lines = ['// from upstream', '// from upstream', '// from upstream', ...sources.get(file)!];
      // Every tenth file has the code of its first note deleted.
      const first = allNotes.find((n) => n.file === file);
      if (i % 10 === 0 && first) {
        const at = first.line! + 3;
        lines = [...lines.slice(0, at - 1), ...lines.slice(at + 2)];
        losing.add(first.id);
      }
      fs.writeFileSync(path.join(root(), file), lines.join('\n'));
    }
    // Three lines added at the top move every note down 3; where three lines
    // were also deleted, notes after them are back where they were. Notes
    // within two lines of deleted code may land anywhere, so they are left out.
    const deletedAt = new Map<string, number>();
    for (const id of losing) {
      const gone = allNotes.find((g) => g.id === id)!;
      deletedAt.set(gone.file!, gone.line!);
    }
    const shift = (n: Note): number | undefined => {
      const at = deletedAt.get(n.file!);
      if (at === undefined || n.line! < at - 2) {
        return 3;
      }
      return Math.abs(n.line! - at) <= 2 ? undefined : 0;
    };
    const expected = allNotes.filter((n) => changed.includes(n.file!) && shift(n) !== undefined);
    const right = (now: Map<string, { line?: number }>) =>
      expected.filter((n) => now.get(n.id)?.line === n.line! + shift(n)!).length;
    let last = -1;
    let stable = 0;
    // Until every pulled file has been checked: nothing changes for a second.
    await until(async () => {
      const count = right(new Map((await notes()).map((n) => [n.id, n])));
      stable = count === last ? stable + 1 : 0;
      last = count;
      return count === expected.length || stable > 40 ? true : undefined;
    }, 'the pulled files to be checked');
    const wall = performance.now() - started;
    const blocked = lag.stop();
    const now = new Map((await notes()).map((n) => [n.id, n]));
    const lost = [...losing].filter((id) => now.get(id)?.lost).length;
    report('pull of 100 files: all checked, wall', ms(wall));
    const batch = (await timings())['check changed files'];
    report('pull: checks run / last one took', batch ? `${batch.runs} / ${ms(batch.ms)}` : 'none');
    report('pull: notes moved correctly', `${right(now)} of ${expected.length}`);
    const wrong = expected.filter((n) => now.get(n.id)?.line !== n.line! + shift(n)!);
    const wrongFiles = [...new Set(wrong.map((n) => n.file!))];
    // Only says anything when something went wrong, and then what.
    for (const file of wrongFiles.slice(0, 5)) {
      const sample = wrong.filter((n) => n.file === file).slice(0, 3);
      console.log(
        `      wrong in ${file} (deleted at ${deletedAt.get(file) ?? '-'}): ` +
          sample.map((n) => `${n.line}->${now.get(n.id)?.line} want ${n.line! + shift(n)!}`).join(', ')
      );
    }
    assert.strictEqual(right(now), expected.length, 'every note followed its code');
    report('pull: notes whose code was deleted shown as lost', `${lost} of ${losing.size}`);
    report('pull: longest host freeze', ms(blocked));
    for (const file of changed) {
      sources.set(file, fs.readFileSync(path.join(root(), file), 'utf8').split('\n'));
    }
  });

  it('keeps up with typing in the big file', async () => {
    const editor = vscode.window.activeTextEditor!;
    assert.ok(editor.document.uri.fsPath.endsWith('big.ts'));
    const before = await timings();
    const lag = watchLag();
    const started = performance.now();
    // Ten lines typed at the top, at typing speed.
    for (let i = 0; i < 10; i++) {
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), `// typed ${i}\n`));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const typed = performance.now() - started;
    const firstBig = allNotes[SCATTERED].id;
    await until(async () => {
      const note = (await notes()).find((n) => n.id === firstBig);
      return note?.line === 5 + 25 + 10 ? note : undefined;
    }, 'the notes to follow the typing');
    const settled = performance.now() - started - typed;
    await nextRun('check one file', before, 'the check to be written');
    const blocked = lag.stop();
    const after = await timings();
    report('typing: check of the 1,000-note file', ms(after['check one file'].ms));
    report('typing: notes in place after last key', ms(settled));
    report('typing: longest host freeze', ms(blocked));

    // Closing without saving puts them back where the file on disk has them.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await until(async () => {
      const note = (await notes()).find((n) => n.id === firstBig);
      return note?.line === 5 + 25 ? note : undefined;
    }, 'the notes to go back after closing unsaved');
  });

  it('checks everything again quickly when nothing changed', async () => {
    const lag = watchLag();
    const result = await vscode.commands.executeCommand<{ ms: number; moved: number }>('laxative._checkAnchors');
    const blocked = lag.stop();
    assert.strictEqual(result?.moved, 0);
    report('re-check all, nothing changed', ms(result!.ms));
    report('re-check: longest host freeze', ms(blocked));
  });

  it('stays smooth while the note file itself is open in an editor', async () => {
    // VS Code copies every open document into the extension host again when
    // it changes on disk; for a 3.5 MB note file that stalls for seconds. So
    // moves wait while it is open, and are written when it is closed.
    const document = await vscode.workspace.openTextDocument(storePath());
    await vscode.window.showTextDocument(document, { preview: false });
    const before = await timings();
    const lines = sources.get(bigFile)!;
    const firstBig = allNotes[SCATTERED].id;
    const was = (await notes()).find((n) => n.id === firstBig)!.line!;
    const lag = watchLag();
    fs.writeFileSync(path.join(root(), bigFile), ['// one more', ...lines].join('\n'));
    await until(async () => {
      const note = (await notes()).find((n) => n.id === firstBig);
      return note?.line === was + 1 ? note : undefined;
    }, 'the notes to move');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const blocked = lag.stop();
    assert.strictEqual(
      (await timings())['write note file']?.runs ?? 0,
      before['write note file']?.runs ?? 0,
      'not written while open'
    );
    report('note file open in an editor: longest host freeze', ms(blocked));

    // Closed: now it is written.
    const closing = watchLag();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await nextRun('write note file', before, 'the moves to be written once it is closed');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    report('note file closed, then written: longest host freeze', ms(closing.stop()));
    sources.set(bigFile, ['// one more', ...lines]);
  });
});
