// Seeds a project with 600 source files (about 240k lines) and 6,000 notes,
// for trying the extension at the size of a big project by hand:
//   5,000 notes scattered over src/big/mod*/file*.ts
//   1,000 notes on one large file, src/big/huge.ts (8,000 lines)
// The notes go in .laxative/big.json, beside the sandbox's own note files.
//
//   node docker/seed-big.mjs <project-dir>
//
// Same shape as the integration performance test, and the same numbers every
// run.
import fs from 'node:fs';
import path from 'node:path';

const project = process.argv[2];
if (!project) {
  console.error('usage: node seed-big.mjs <project-dir>');
  process.exit(1);
}

const DIRS = 30;
const FILES_PER_DIR = 20;
const LINES_PER_FILE = 400;
const SCATTERED = 5000;
const HUGE_LINES = 8000;
const HUGE_NOTES = 1000;

function rng(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** Code that looks like code: many `}`, blank lines and repeated statements. */
function sourceFile(seed, lines) {
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

// The same as src/core/anchoring.ts, so the notes start out with snippets.
const normalize = (text) => text.trim().replace(/\s+/g, ' ').slice(0, 160);
const snippetAt = (lines, line) => ({
  above: normalize(lines[line - 1] ?? ''),
  line: normalize(lines[line] ?? ''),
  below: normalize(lines[line + 1] ?? '')
});

const sources = new Map();
const files = [];
for (let d = 0; d < DIRS; d++) {
  fs.mkdirSync(path.join(project, 'src', 'big', `mod${d}`), { recursive: true });
  for (let f = 0; f < FILES_PER_DIR; f++) {
    const file = `src/big/mod${d}/file${f}.ts`;
    const lines = sourceFile(d * 100 + f, LINES_PER_FILE);
    fs.writeFileSync(path.join(project, file), lines.join('\n'));
    files.push(file);
    sources.set(file, lines);
  }
}
const hugeFile = 'src/big/huge.ts';
const huge = sourceFile(99999, HUGE_LINES);
fs.writeFileSync(path.join(project, hugeFile), huge.join('\n'));
sources.set(hugeFile, huge);

const random = rng(7);
const now = '2026-09-01T09:00:00.000Z';
const idOf = (n) => `b${String(n).padStart(7, '0')}`;
const notes = [];
const make = (file, line, n) => {
  const title = `Note ${n} on ${path.basename(file)}`;
  const other = idOf(Math.floor(random() * (SCATTERED + HUGE_NOTES)));
  return {
    id: idOf(n),
    title,
    body: `${title}\n\nWhy this line matters, and what to watch for when it changes. See [[${other}]]. #area${n % 40} #team${n % 7}`,
    file,
    line,
    character: 2,
    snippet: snippetAt(sources.get(file), line),
    tags: [`area${n % 40}`, `team${n % 7}`],
    createdAt: now,
    updatedAt: now
  };
};

// Scattered: a few notes on each file, each on a line of its own.
const used = new Map();
let n = 0;
while (n < SCATTERED) {
  const file = files[Math.floor(random() * files.length)];
  const line = Math.floor(random() * LINES_PER_FILE);
  const taken = used.get(file) ?? new Set();
  if (taken.has(line) || sources.get(file)[line].trim() === '') {
    continue;
  }
  taken.add(line);
  used.set(file, taken);
  notes.push(make(file, line, n++));
}
for (let i = 0; i < HUGE_NOTES; i++) {
  notes.push(make(hugeFile, i * 8 + 5, n++));
}

fs.mkdirSync(path.join(project, '.laxative'), { recursive: true });
fs.writeFileSync(
  path.join(project, '.laxative', 'big.json'),
  JSON.stringify({ version: 1, notes }, null, 2) + '\n'
);
console.log(`Seeded ${files.length + 1} files and ${notes.length} notes.`);
