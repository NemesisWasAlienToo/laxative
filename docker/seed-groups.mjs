// Seeds a project made of groups within groups, for trying grouping by hand:
// four areas, each with three or four parts, a few notes on each part, and
// links that cross from one area to another. Plus two images, one kept with
// the notes in .laxative/assets/ and one in the project's own docs/ folder.
// The notes go in .laxative/system.json.
//
//   node docker/seed-groups.mjs <project-dir>
//
// The same notes every run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const project = process.argv[2];
if (!project) {
  console.error('usage: node seed-groups.mjs <project-dir>');
  process.exit(1);
}

/** area -> part -> what its notes are about */
const SYSTEM = {
  api: {
    auth: ['Token refresh races the logout', 'Session cookie is not SameSite', 'Password reset links never expire', 'Rate limit is per IP, not per account', 'OAuth state is not checked'],
    billing: ['Invoices are rounded twice', 'Webhook retries are not idempotent', 'Currency comes from the browser', 'Refunds skip the audit log'],
    search: ['Query parser chokes on quotes', 'Results are not paginated', 'Index rebuild blocks writes'],
    gateway: ['Timeouts differ per route', 'Errors leak stack traces']
  },
  storage: {
    cache: ['Cache key ignores the tenant', 'Eviction drops warm entries', 'TTL is in seconds here, ms elsewhere'],
    db: ['N+1 in the orders query', 'Migrations are not reversible', 'Connection pool is too small', 'Soft deletes are still unique-indexed'],
    queue: ['Poison messages loop forever', 'Consumers ack before work is done', 'Dead letter queue is never read']
  },
  frontend: {
    ui: ['Modal traps focus forever', 'Dark theme misses the charts', 'Date picker is US only', 'Buttons have no loading state'],
    state: ['Store is mutated in place', 'Optimistic update never rolls back', 'Two sources of truth for the user'],
    routing: ['Back button loses filters', 'Deep links skip the auth check']
  },
  infra: {
    deploy: ['Rollback needs a manual step', 'Secrets are baked into the image', 'Blue/green shares one database'],
    monitoring: ['Alerts fire on every deploy', 'No trace across the queue', 'Dashboards use the wrong percentile']
  }
};

/** Links that cross areas: from a note to another, by their titles. */
const CROSS = [
  ['Token refresh races the logout', 'Cache key ignores the tenant'],
  ['Session cookie is not SameSite', 'Deep links skip the auth check'],
  ['Webhook retries are not idempotent', 'Poison messages loop forever'],
  ['Refunds skip the audit log', 'Soft deletes are still unique-indexed'],
  ['Index rebuild blocks writes', 'Connection pool is too small'],
  ['Errors leak stack traces', 'Alerts fire on every deploy'],
  ['Consumers ack before work is done', 'No trace across the queue'],
  ['Optimistic update never rolls back', 'Webhook retries are not idempotent'],
  ['Two sources of truth for the user', 'Token refresh races the logout'],
  ['Back button loses filters', 'Results are not paginated'],
  ['Secrets are baked into the image', 'OAuth state is not checked'],
  ['Blue/green shares one database', 'Migrations are not reversible'],
  ['TTL is in seconds here, ms elsewhere', 'Timeouts differ per route'],
  ['Dashboards use the wrong percentile', 'N+1 in the orders query']
];

const normalize = (text) => text.trim().replace(/\s+/g, ' ').slice(0, 160);
const snippetAt = (lines, line) => ({
  above: normalize(lines[line - 1] ?? ''),
  line: normalize(lines[line] ?? ''),
  below: normalize(lines[line + 1] ?? '')
});

const now = '2026-11-17T09:00:00.000Z';
const notes = [];
const byTitle = new Map();
let n = 0;
for (const [area, parts] of Object.entries(SYSTEM)) {
  for (const [part, titles] of Object.entries(parts)) {
    // One source file per part, a function per note.
    const file = `src/${area}/${part}.ts`;
    const lines = [`// ${area} / ${part}`, ''];
    const at = [];
    titles.forEach((title, i) => {
      lines.push(`export function ${part}Step${i}(input: string): string {`);
      at.push(lines.length);
      lines.push(`  const result = input.trim(); // ${title.toLowerCase()}`);
      lines.push('  return result;', '}', '');
    });
    fs.mkdirSync(path.join(project, 'src', area), { recursive: true });
    fs.writeFileSync(path.join(project, file), lines.join('\n'));
    titles.forEach((title, i) => {
      const id = `s${String(n++).padStart(7, '0')}`;
      const note = {
        id,
        title,
        group: `${area}/${part}`,
        file,
        line: at[i],
        character: 2,
        snippet: snippetAt(lines, at[i]),
        links: []
      };
      notes.push(note);
      byTitle.set(title, note);
    });
  }
}

// Inside each part, each note links to the next: groups have links inside them.
for (let i = 1; i < notes.length; i++) {
  if (notes[i].group === notes[i - 1].group) {
    notes[i].links.push(notes[i - 1].id);
  }
}
for (const [from, to] of CROSS) {
  byTitle.get(from).links.push(byTitle.get(to).id);
}

// A few notes that belong to an area as a whole, not to any part of it.
const overview = (area, title, text) => {
  const id = `s${String(n++).padStart(7, '0')}`;
  notes.push({ id, title, group: area, links: [], text });
};
overview('api', 'API overview', 'Everything a client can call. Auth comes first; billing and search sit behind it.');
overview('storage', 'Storage overview', 'Three stores, three consistency models. Read the queue notes before touching the cache.');
overview('frontend', 'Frontend overview', 'One store, one router, a lot of components.');

const records = notes.map((note) => {
  const refs = note.links.map((id) => `[[${id}]]`).join(' ');
  const body =
    `${note.title} @${note.group}\n\n` +
    (note.text ?? 'Why this matters, and what to watch for when it changes.') +
    (refs ? `\n\nSee ${refs}.` : '') +
    `\n\n#${note.group.split('/')[0]}`;
  return {
    id: note.id,
    title: note.title,
    body,
    ...(note.file
      ? { file: note.file, line: note.line, character: note.character, snippet: note.snippet }
      : {}),
    tags: [note.group.split('/')[0]],
    createdAt: now,
    updatedAt: now
  };
});

// Notes that show the rest: images from both places, a note in no group, and
// an @ that is only text.
records.push(
  {
    id: 'simages1',
    title: 'Architecture at a glance',
    body:
      'Architecture at a glance @overview\n\n' +
      'An image kept with the notes, in `.laxative/assets/`:\n\n' +
      '![request flow](assets/request-flow.png)\n\n' +
      'And one from the project itself, `docs/architecture.svg`:\n\n' +
      '![architecture](docs/architecture.svg)\n\n' +
      'Paste or drop your own into a note while editing it, or run **Laxative: Insert Image...**.',
    tags: [],
    createdAt: now,
    updatedAt: now
  },
  {
    id: 'sescape1',
    title: 'Send the on-call rota to ops@oncall',
    body:
      'Send the on-call rota to ops\\@oncall\n\n' +
      'The first line ends in `ops\\@oncall`: the backslash makes it a plain @, so this note is in ' +
      'no group, and its name shows as `ops@oncall`. Take the backslash out and it moves into ' +
      'group `@oncall`.',
    tags: [],
    createdAt: now,
    updatedAt: now
  },
  {
    id: 'sloose01',
    title: 'Release checklist',
    body: 'Release checklist\n\nNot in any group: it sits on its own in the graph.\n\nSee [[s0000000]].',
    tags: [],
    createdAt: now,
    updatedAt: now
  }
);

fs.mkdirSync(path.join(project, '.laxative', 'assets'), { recursive: true });
fs.writeFileSync(
  path.join(project, '.laxative', 'system.json'),
  JSON.stringify({ version: 1, notes: records }, null, 2) + '\n'
);

// --- Images ----------------------------------------------------------------

/** A PNG of four coloured boxes joined by a bar: a "request flow". */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const COLOURS = [[78, 161, 255], [242, 166, 59], [95, 211, 154], [224, 108, 159]];
fs.writeFileSync(
  path.join(project, '.laxative', 'assets', 'request-flow.png'),
  png(480, 120, (x, y) => {
    const box = Math.floor(x / 120);
    const inBox = x % 120 > 15 && x % 120 < 105 && y > 25 && y < 95;
    const bar = y > 56 && y < 64;
    if (inBox) return COLOURS[box];
    if (bar) return [140, 140, 140];
    return [30, 30, 30];
  })
);

fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
fs.writeFileSync(
  path.join(project, 'docs', 'architecture.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="160" viewBox="0 0 420 160" font-family="sans-serif" font-size="14">
  <rect width="420" height="160" fill="#1e1e1e"/>
  <g fill="none" stroke-width="2">
    <rect x="20" y="20" width="110" height="50" rx="8" stroke="#4ea1ff"/>
    <rect x="155" y="20" width="110" height="50" rx="8" stroke="#f2a63b"/>
    <rect x="290" y="20" width="110" height="50" rx="8" stroke="#5fd39a"/>
    <rect x="155" y="95" width="110" height="50" rx="8" stroke="#e06c9f"/>
    <path d="M130 45h25M265 45h25M210 70v25" stroke="#8c8c8c"/>
  </g>
  <g fill="#ddd" text-anchor="middle">
    <text x="75" y="50">frontend</text><text x="210" y="50">api</text>
    <text x="345" y="50">storage</text><text x="210" y="125">infra</text>
  </g>
</svg>
`
);

console.log(`Seeded ${records.length} notes in groups, and two images.`);
