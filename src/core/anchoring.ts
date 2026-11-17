/**
 * A note's line number is only a guess once the file has changed, and it can
 * change in ways nothing reports: a `git pull`, a patch, a script run in a
 * terminal. So each note keeps a few lines of the code it is on, and is put
 * back wherever that code is now.
 *
 * Pure, so the rules can be tested without a workspace.
 */

/** The line a note is on and the one either side of it, as `normalize` has them. */
export interface Snippet {
  above: string;
  line: string;
  below: string;
}

/** Where a note is now, and the code it is on there. */
export interface Placement {
  line: number;
  character: number;
  snippet: Snippet;
}

export interface Anchor {
  line: number;
  character: number;
  snippet?: Snippet;
}

/** Kept short: enough to tell one line from another, not a copy of the file. */
const MAX_LENGTH = 160;

/**
 * Indentation and spacing don't change what a line is, so a reformat or a
 * re-indent still finds the note.
 */
export function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_LENGTH);
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The snippet a note at `line` would keep. `lines` are raw, as in the file. */
export function snippetAt(lines: readonly string[], line: number): Snippet {
  return {
    above: normalize(lines[line - 1] ?? ''),
    line: normalize(lines[line] ?? ''),
    below: normalize(lines[line + 1] ?? '')
  };
}

export function sameSnippet(a: Snippet | undefined, b: Snippet | undefined): boolean {
  return !!a && !!b && a.above === b.above && a.line === b.line && a.below === b.below;
}

/**
 * One file's text, indexed for finding many notes in it: each note costs a
 * look-up rather than a scan of the file.
 */
export class CodeIndex {
  private readonly raw: string[];
  private readonly lines: string[];
  private readonly byText = new Map<string, number[]>();

  constructor(text: string) {
    this.raw = splitLines(text);
    this.lines = this.raw.map(normalize);
    this.lines.forEach((line, index) => {
      const list = this.byText.get(line);
      if (list) {
        list.push(index);
      } else {
        this.byText.set(line, [index]);
      }
    });
  }

  get lineCount(): number {
    return this.raw.length;
  }

  /** How many of the lines either side still match: 0, 1 or 2. */
  private context(index: number, snippet: Snippet): number {
    return (
      Number((this.lines[index - 1] ?? '') === snippet.above) +
      Number((this.lines[index + 1] ?? '') === snippet.below)
    );
  }

  /**
   * The column is kept as it was, even past the end of a shorter line: going
   * to the note clamps it, and changing it here would count as a move and
   * rewrite the note file on every check.
   */
  private placed(line: number, character: number): Placement {
    return { line, character, snippet: snippetAt(this.raw, line) };
  }

  /** Where the note's code is now, or undefined when it is not in the file. */
  find(anchor: Anchor): Placement | undefined {
    return this.findAll([anchor])[0];
  }

  /**
   * Where each note's code is now; undefined for a note whose code is not in
   * the file. Notes on the same file are found together, because code moves
   * in blocks: a note whose lines appear in several places (a `}` after a
   * `return`, in every function) goes to the copy that moved the way the notes
   * around it did, rather than to whichever copy is nearest.
   */
  findAll(anchors: readonly Anchor[]): (Placement | undefined)[] {
    const results: (Placement | undefined)[] = new Array(anchors.length);
    /** Notes placed for certain: how far each moved, by where it was. */
    const sure: { from: number; shift: number }[] = [];
    const unsure: { at: number; lines: number[] }[] = [];

    anchors.forEach((anchor, at) => {
      const lines = this.candidates(anchor);
      if (lines.length === 1) {
        results[at] = this.placed(lines[0], anchor.character);
        sure.push({ from: anchor.line, shift: lines[0] - anchor.line });
      } else if (lines.length > 1) {
        unsure.push({ at, lines });
      }
    });

    sure.sort((a, b) => a.from - b.from);
    for (const { at, lines } of unsure) {
      const anchor = anchors[at];
      const expected = anchor.line + nearestShift(sure, anchor.line);
      let best = lines[0];
      for (const line of lines) {
        if (Math.abs(line - expected) < Math.abs(best - expected)) {
          best = line;
        }
      }
      results[at] = this.placed(best, anchor.character);
    }
    return results;
  }

  /**
   * The lines the note's code could be on now: one when it is certain, none
   * when the code is gone.
   */
  private candidates(anchor: Anchor): number[] {
    const snippet = anchor.snippet;
    // Never kept a snippet: there is nothing to check its line against, so it
    // takes one from where it says it is.
    if (!snippet) {
      return [Math.min(anchor.line, Math.max(this.raw.length - 1, 0))];
    }

    // The same line, wherever it is now; the copies whose neighbours match
    // best. Lines like `}` are everywhere, so the neighbours matter.
    let best: number[] = [];
    let bestScore = -1;
    for (const index of this.byText.get(snippet.line) ?? []) {
      const score = this.context(index, snippet);
      if (score > bestScore) {
        best = [index];
        bestScore = score;
      } else if (score === bestScore) {
        best.push(index);
      }
    }
    // A blank line is only itself with a neighbour to say which one.
    if (best.length > 0 && (snippet.line !== '' || bestScore > 0)) {
      return best;
    }

    // The line itself was edited: still there if both its neighbours are,
    // with one line between them.
    if (snippet.above === '' || snippet.below === '') {
      return [];
    }
    const edited: number[] = [];
    for (const index of this.byText.get(snippet.above) ?? []) {
      if (this.lines[index + 2] === snippet.below) {
        edited.push(index + 1);
      }
    }
    return edited;
  }
}

/** How far the certain note nearest to `line` moved; 0 when there is none. */
function nearestShift(sure: readonly { from: number; shift: number }[], line: number): number {
  if (sure.length === 0) {
    return 0;
  }
  // Binary search for the first certain note at or after `line`.
  let low = 0;
  let high = sure.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sure[mid].from < line) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const after = sure[low];
  const before = sure[low - 1];
  if (!before) {
    return after.shift;
  }
  if (!after) {
    return before.shift;
  }
  return line - before.from <= after.from - line ? before.shift : after.shift;
}
