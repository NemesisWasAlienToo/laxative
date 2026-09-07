import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/**
 * The webview scripts run in a browser, not in the extension host, so they are
 * exercised here in jsdom. This is the layer where a blank panel or an empty
 * graph would otherwise go unnoticed until someone opened one by hand.
 */

const MEDIA = path.resolve(__dirname, '../../../media');

interface Harness {
  dom: JSDOM;
  window: any;
  posted: any[];
  send(message: unknown): void;
  destroy(): void;
}

function load(script: string, html: string, prepare?: (window: any) => void): Harness {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const window = dom.window as any;
  const posted: any[] = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined
  });
  prepare?.(window);
  window.eval(fs.readFileSync(path.join(MEDIA, script), 'utf8'));
  return {
    dom,
    window,
    posted,
    send: (message) => window.dispatchEvent(new window.MessageEvent('message', { data: message })),
    destroy: () => dom.window.close()
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Messages come from jsdom's realm, whose prototypes are not Node's. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('panel webview', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    type: 'render',
    note: { id: 'n1', title: 'Cache warmer race', file: 'src/cache.ts', line: 13 },
    html: '<h1>Cache warmer race</h1>\n<p>Some <strong>bold</strong> text.</p>',
    empty: false,
    meta: { file: 'src/cache.ts', line: 14, character: 5, tags: ['bug'] },
    ...overrides
  });

  const labels = (window: any) =>
    [...window.document.querySelectorAll('button.action')].map((b: any) =>
      b.getAttribute('aria-label')
    );

  let harness: Harness;
  afterEach(() => harness?.destroy());

  it('announces itself so the extension can send the note', () => {
    harness = load('panel.js', '<div id="root"></div>');
    assert.deepStrictEqual(plain(harness.posted), [{ type: 'ready' }]);
  });

  it('renders the note markdown', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload());
    const root = harness.window.document.getElementById('root');
    assert.match(root.innerHTML, /<strong>bold<\/strong>/, 'markdown html is rendered');
    assert.strictEqual(root.querySelector('.chip').textContent, '#bug');
    assert.strictEqual(
      root.querySelector('.location').textContent,
      'src/cache.ts:14:5',
      'the anchor shows line and character'
    );
  });

  it('shows the note title once, from the content itself', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload());
    const root = harness.window.document.getElementById('root');
    const headings = [...root.querySelectorAll('h1')].map((h: any) => h.textContent);
    assert.deepStrictEqual(
      headings,
      ['Cache warmer race'],
      'only the markdown heading, no separate title of our own'
    );
  });

  it('does not repeat the reference lists that the tree and graph already show', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload({ html: '<p>see <a href="laxative:other1">Other</a></p>' }));
    const text = harness.window.document.getElementById('root').textContent;
    assert.ok(!/Referenced by/i.test(text), 'no backlinks section');
    assert.ok(!/^References$/im.test(text), 'no outgoing references section');
  });

  it('gives the actions a real toolbar with icons and accessible names', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload());
    const window = harness.window;
    assert.deepStrictEqual(labels(window), ['Edit', 'Go to code', 'Copy reference', 'Delete']);
    for (const button of window.document.querySelectorAll('button.action')) {
      assert.ok(button.querySelector('svg'), `${button.getAttribute('aria-label')} has an icon`);
      assert.strictEqual(button.getAttribute('title'), button.getAttribute('aria-label'));
    }
    assert.ok(
      window.document.querySelector('button.action.danger[aria-label="Delete"]'),
      'delete is marked as the destructive action'
    );
  });

  it('always offers Edit, including on a note with no content yet', () => {
    harness = load('panel.js', '<div id="root"></div>');
    for (const state of [payload(), payload({ empty: true, html: '' })]) {
      harness.send(state);
      assert.ok(labels(harness.window).includes('Edit'), `Edit present (empty=${state.empty})`);
      assert.ok(labels(harness.window).includes('Delete'));
    }
  });

  it('asks the extension to open the editor when Edit is clicked', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload());
    const edit = harness.window.document.querySelector(
      'button.action[aria-label="Edit"]'
    ) as any;
    edit.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(plain(harness.posted.at(-1)), { type: 'edit' });
  });

  it('re-renders when a newer version of the note arrives', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload());
    harness.send(payload({ html: '<p>updated while typing</p>' }));
    assert.match(harness.window.document.getElementById('root').innerHTML, /updated while typing/);
  });

  it('turns a note reference into a click that opens that note', () => {
    harness = load('panel.js', '<div id="root"></div>');
    harness.send(payload({ html: '<p>see <a href="laxative:other1">Other</a></p>' }));
    const link = harness.window.document.querySelector('a[href^="laxative:"]') as any;
    link.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(plain(harness.posted.at(-1)), { type: 'open', id: 'other1' });
  });
});

describe('graph webview', () => {
  const HTML = `
    <div id="hud">
      <input id="filter" type="text">
      <label><input id="showFiles" type="checkbox" checked></label>
      <label><input id="showTags" type="checkbox" checked></label>
      <span id="stats"></span>
    </div>
    <canvas id="canvas"></canvas>
    <div id="tip" hidden></div>`;

  /** Records what was drawn, and lets the test control the element's size. */
  function prepareCanvas(
    size: { width: number; height: number },
    options: { recordArcs?: boolean; fixedLayout?: boolean } = {}
  ) {
    return (window: any) => {
      if (options.fixedLayout) {
        // Node seeding jitters by Math.random; pinning it makes the starting
        // position known, so the test can aim at a node.
        window.Math.random = () => 0.5;
      }
      const calls: Record<string, number> = {};
      const arcs: unknown[][] = [];
      const record = (name: string) => (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1;
        if (name === 'arc' && options.recordArcs) {
          arcs.push(args);
        }
      };
      const context: Record<string, unknown> = { calls, arcs };
      for (const name of [
        'clearRect', 'save', 'restore', 'translate', 'scale', 'beginPath', 'arc', 'fill',
        'stroke', 'moveTo', 'lineTo', 'closePath', 'setLineDash', 'fillText', 'setTransform'
      ]) {
        context[name] = record(name);
      }
      context.measureText = () => ({ width: 10 });
      window.HTMLCanvasElement.prototype.getContext = () => context;
      for (const [property, key] of [
        ['clientWidth', 'width'],
        ['clientHeight', 'height']
      ] as const) {
        Object.defineProperty(window.HTMLCanvasElement.prototype, property, {
          configurable: true,
          get: () => size[key]
        });
      }
      window.__context = context;
    };
  }

  const graph = {
    type: 'graph',
    nodes: [
      { id: 'a', title: 'First', file: 'src/a.ts', line: 1, tags: ['perf'], excerpt: 'one' },
      { id: 'b', title: 'Second', file: 'src/b.ts', line: 2, tags: ['perf'], excerpt: 'two' }
    ],
    edges: [{ from: 'a', to: 'b' }],
    broken: []
  };

  let harness: Harness;
  afterEach(() => harness?.destroy());

  it('draws the notes it is given', async () => {
    const size = { width: 800, height: 600 };
    harness = load('graph.js', HTML, prepareCanvas(size));
    harness.send(graph);
    await delay(150);
    assert.ok(harness.window.__context.calls.arc > 0, 'nodes are drawn');
    assert.strictEqual(
      harness.window.document.getElementById('stats').textContent,
      '2 notes · 1 links · double-click to open'
    );
  });

  it('sizes nodes by how connected they are', async () => {
    const size = { width: 800, height: 600 };
    harness = load('graph.js', HTML, prepareCanvas(size, { recordArcs: true }));
    harness.send({
      type: 'graph',
      nodes: ['hub', 'a', 'b', 'c', 'lonely'].map((id) => ({
        id,
        title: id,
        file: 'src/a.ts',
        line: 1,
        tags: [],
        excerpt: id
      })),
      edges: [
        { from: 'a', to: 'hub' },
        { from: 'b', to: 'hub' },
        { from: 'c', to: 'hub' }
      ],
      broken: []
    });
    await delay(150);
    const radii = harness.window.__context.arcs.slice(-5).map((a: any) => a[2]);
    const biggest = Math.max(...radii);
    const smallest = Math.min(...radii);
    assert.ok(biggest > smallest + 2, `hub is visibly bigger (${smallest} -> ${biggest})`);
    assert.ok(biggest < smallest * 3, 'but not so big that it swamps the others');
  });

  it('hides filtered-out notes instead of greying them', async () => {
    const size = { width: 800, height: 600 };
    harness = load('graph.js', HTML, prepareCanvas(size));
    harness.send(graph);
    await delay(150);

    const perFrame = () => {
      const calls = harness.window.__context.calls;
      const before = { arc: calls.arc ?? 0, frames: calls.clearRect ?? 0 };
      return async () => {
        await delay(150);
        const arcs = (calls.arc ?? 0) - before.arc;
        const frames = (calls.clearRect ?? 0) - before.frames;
        return frames > 0 ? arcs / frames : 0;
      };
    };

    const unfiltered = await (perFrame())();
    assert.ok(unfiltered > 1.5, `both notes drawn each frame (${unfiltered})`);

    const filter = harness.window.document.getElementById('filter');
    filter.value = 'First';
    filter.dispatchEvent(new harness.window.Event('input'));
    const filtered = await (perFrame())();
    assert.ok(filtered > 0.5 && filtered < 1.5, `only the match is drawn (${filtered})`);
  });

  it('opens a note on double click only, so dragging one never opens it', async () => {
    const size = { width: 800, height: 600 };
    harness = load('graph.js', HTML, prepareCanvas(size, { fixedLayout: true }));
    harness.send({
      type: 'graph',
      nodes: [{ id: 'solo', title: 'Solo', file: 'src/a.ts', line: 1, tags: [], excerpt: '' }],
      edges: [],
      broken: []
    });
    await delay(60);

    const canvas = harness.window.document.getElementById('canvas');
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, bubbles: true });
    const mouse = (target: any, type: string, x: number, y: number) =>
      target.dispatchEvent(new harness.window.MouseEvent(type, at(x, y)));
    const opens = () => harness.posted.filter((m: any) => m.type === 'open');

    // The single node is seeded a fixed distance right of centre. Grab it and
    // drag it somewhere known: exactly the gesture that used to open the note.
    mouse(canvas, 'mousedown', 560, 300);
    mouse(harness.window, 'mousemove', 250, 200);
    mouse(harness.window, 'mouseup', 250, 200);
    assert.strictEqual(opens().length, 0, 'dragging a node opens nothing');

    mouse(canvas, 'click', 250, 200);
    assert.strictEqual(opens().length, 0, 'nor does a plain click on it');

    mouse(canvas, 'dblclick', 250, 200);
    assert.deepStrictEqual(plain(opens()), [{ type: 'open', id: 'solo' }]);
  });

  it('still draws when the webview gets its size only after the script ran', async () => {
    // This is the "graph is empty" bug: a canvas laid out at 0x0 on load kept a
    // 0x0 drawing buffer forever, so every frame painted nothing.
    const size = { width: 0, height: 0 };
    harness = load('graph.js', HTML, prepareCanvas(size));
    harness.send(graph);
    await delay(80);

    size.width = 900;
    size.height = 700;
    await delay(200);

    const ratio = harness.window.devicePixelRatio || 1;
    assert.strictEqual(harness.window.document.getElementById('canvas').width, 900 * ratio);
    assert.ok(harness.window.__context.calls.arc > 0, 'nodes are drawn once there is room');
  });

  it('says so instead of drawing nothing when there are no notes', async () => {
    harness = load('graph.js', HTML, prepareCanvas({ width: 800, height: 600 }));
    harness.send({ type: 'graph', nodes: [], edges: [], broken: [] });
    await delay(120);
    assert.ok(harness.window.__context.calls.fillText > 0, 'an empty-state message is drawn');
    assert.strictEqual(harness.window.__context.calls.arc ?? 0, 0, 'no nodes drawn');
  });
});
