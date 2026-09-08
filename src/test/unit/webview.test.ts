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
  /** What the script has persisted through the webview state API. */
  state: { current: any };
  send(message: unknown): void;
  destroy(): void;
}

function load(
  script: string,
  html: string,
  prepare?: (window: any) => void,
  initialState?: unknown
): Harness {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const window = dom.window as any;
  const posted: any[] = [];
  const state = { current: initialState };
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => state.current,
    setState: (value: unknown) => {
      state.current = value;
      return value;
    }
  });
  prepare?.(window);
  window.eval(fs.readFileSync(path.join(MEDIA, script), 'utf8'));
  return {
    dom,
    window,
    posted,
    state,
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
      <label><input id="showTip" type="checkbox" checked></label>
      <button id="tidy" type="button">Tidy</button>
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
    harness = load(
      'graph.js',
      HTML,
      prepareCanvas(size, { fixedLayout: true, recordArcs: true })
    );
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

    // Aim at wherever the node was last painted, rather than assuming the
    // layout leaves it in any particular place.
    const [nodeX, nodeY] = harness.window.__context.arcs.at(-1);

    // Grab it and drag it somewhere known: exactly the gesture that used to
    // open the note.
    mouse(canvas, 'mousedown', nodeX, nodeY);
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

  it('opens on a finished layout instead of animating into one', async () => {
    // The layout used to crawl into place for several seconds after every
    // reopen, which made the graph unusable while it moved. The whole anneal
    // now happens before the first paint, so the very first frame is final.
    harness = load('graph.js', HTML, prepareCanvas({ width: 800, height: 600 }, { recordArcs: true }));
    harness.send(graph);

    const arcs = () => harness.window.__context.arcs;
    const positions = (from: any[]) => from.map((a: any) => [a[0], a[1]]);
    await delay(400);
    const first = positions(arcs().slice(0, graph.nodes.length));
    const last = positions(arcs().slice(-graph.nodes.length));

    assert.strictEqual(first.length, graph.nodes.length, 'both notes are drawn');
    const moved = Math.max(
      ...first.map((p: number[], i: number) => Math.hypot(p[0] - last[i][0], p[1] - last[i][1]))
    );
    assert.ok(moved < 1, `first frame is the finished layout (it moved ${moved.toFixed(2)}px after)`);
  });

  it('comes to a stop soon after a node is dropped, near where it was dropped', async () => {
    // Dropping a node used to leave it creeping towards the middle for
    // seconds, because the centre pull never stops and the old stop condition
    // only watched for slow velocities — which a constant force keeps alive.
    harness = load(
      'graph.js',
      HTML,
      prepareCanvas({ width: 800, height: 600 }, { fixedLayout: true, recordArcs: true })
    );
    harness.send({
      type: 'graph',
      nodes: [{ id: 'solo', title: 'Solo', file: 'src/a.ts', line: 1, tags: [], excerpt: '' }],
      edges: [],
      broken: []
    });
    await delay(120);

    const canvas = harness.window.document.getElementById('canvas');
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, bubbles: true });
    const mouse = (target: any, type: string, x: number, y: number) =>
      target.dispatchEvent(new harness.window.MouseEvent(type, at(x, y)));
    const painted = () => harness.window.__context.arcs.at(-1).slice(0, 2) as number[];

    const [nodeX, nodeY] = painted();
    mouse(canvas, 'mousedown', nodeX, nodeY);
    mouse(harness.window, 'mousemove', 700, 90);
    mouse(harness.window, 'mouseup', 700, 90);

    await delay(250);
    const settledAt = painted();
    await delay(400);
    const later = painted();

    const drift = Math.hypot(settledAt[0] - later[0], settledAt[1] - later[1]);
    assert.ok(drift < 1, `at rest 250ms after the drop (still moved ${drift.toFixed(2)}px)`);
    const fromDrop = Math.hypot(settledAt[0] - 700, settledAt[1] - 90);
    assert.ok(fromDrop < 60, `stays roughly where it was put (drifted ${fromDrop.toFixed(0)}px)`);
  });

  it('stops the layout while a held node is kept still', async () => {
    // Warmth used to be held for as long as the mouse button was down, so
    // grabbing a node and holding it left everything else drifting until the
    // button came up.
    harness = load(
      'graph.js',
      HTML,
      prepareCanvas({ width: 800, height: 600 }, { recordArcs: true })
    );
    harness.send(graph);
    await delay(150);

    const canvas = harness.window.document.getElementById('canvas');
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, bubbles: true });
    const mouse = (target: any, type: string, x: number, y: number) =>
      target.dispatchEvent(new harness.window.MouseEvent(type, at(x, y)));
    // The second node: the one that should stop moving, not the held one.
    const other = () => harness.window.__context.arcs.at(-1).slice(0, 2) as number[];

    const [firstX, firstY] = harness.window.__context.arcs.at(-2).slice(0, 2) as number[];
    mouse(canvas, 'mousedown', firstX, firstY);
    mouse(harness.window, 'mousemove', 180, 480);

    // Button still down for the whole of this: no mouseup anywhere.
    await delay(250);
    const held = other();
    await delay(400);
    const stillHeld = other();

    // Exact equality on purpose. A layout that is merely converging is still
    // running, still burning a frame's work, and still visibly creeping; the
    // guarantee is that it comes to a full stop while the button is down.
    assert.deepStrictEqual(
      stillHeld,
      held,
      `everything is frozen while the node is held (it drifted ` +
        `${Math.hypot(held[0] - stillHeld[0], held[1] - stillHeld[1]).toFixed(4)}px)`
    );
  });

  it('can turn off the hover card that covers what you are looking at', async () => {
    harness = load(
      'graph.js',
      HTML,
      prepareCanvas({ width: 800, height: 600 }, { recordArcs: true })
    );
    harness.send(graph);
    await delay(150);

    const tip = harness.window.document.getElementById('tip');
    const toggle = harness.window.document.getElementById('showTip');
    const [x, y] = harness.window.__context.arcs.at(-1).slice(0, 2) as number[];
    const hover = (px: number, py: number) =>
      harness.window.dispatchEvent(
        new harness.window.MouseEvent('mousemove', { clientX: px, clientY: py, bubbles: true })
      );

    hover(x, y);
    assert.strictEqual(tip.hidden, false, 'the hover card shows by default');
    // arcs are painted in node order, so the last one is the second note.
    assert.ok(tip.textContent.includes('Second'), 'and describes the note under the pointer');

    toggle.checked = false;
    toggle.dispatchEvent(new harness.window.Event('change'));
    assert.strictEqual(tip.hidden, true, 'unticking it hides the card at once');

    hover(400, 300);
    hover(x, y);
    assert.strictEqual(tip.hidden, true, 'and hovering a node no longer brings it back');

    await delay(300); // persisting is debounced
    assert.strictEqual(harness.state.current.tooltips, false, 'the choice is remembered');
  });

  it('lets a cluster be parked off to one side, and tidied back', async () => {
    // Every node was pulled towards the middle of the canvas, so dragging one
    // note into a corner left its neighbours behind, halfway back to the
    // centre: you could not hold two groups apart.
    harness = load(
      'graph.js',
      HTML,
      prepareCanvas({ width: 800, height: 600 }, { recordArcs: true })
    );
    harness.send(graph);
    await delay(150);

    const canvas = harness.window.document.getElementById('canvas');
    const mouse = (target: any, type: string, x: number, y: number) =>
      target.dispatchEvent(new harness.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    const drawn = () => {
      const arcs = harness.window.__context.arcs.slice(-2);
      return { first: arcs[0].slice(0, 2) as number[], second: arcs[1].slice(0, 2) as number[] };
    };

    // Drag the first note into the top-left corner and let go.
    const [grabX, grabY] = drawn().first;
    mouse(canvas, 'mousedown', grabX, grabY);
    // Spread over frames, the way a real drag is: the physics only runs on
    // animation frames, so moves dispatched back to back would be one step.
    for (const [x, y] of [[600, 380], [500, 300], [380, 230], [240, 150], [110, 90]]) {
      mouse(harness.window, 'mousemove', x, y);
      await delay(50);
    }
    mouse(harness.window, 'mouseup', 110, 90);
    await delay(500);

    const centre = [400, 300];
    const parked = drawn().first;
    assert.ok(
      Math.hypot(parked[0] - 110, parked[1] - 90) < 60,
      `the note stays in the corner it was put in (at ${parked.map(Math.round)})`
    );

    // Every later disturbance used to claw it back towards the middle a little
    // more, so an arrangement never survived being touched.
    const showFiles = harness.window.document.getElementById('showFiles');
    for (let i = 0; i < 6; i++) {
      showFiles.checked = !showFiles.checked;
      showFiles.dispatchEvent(new harness.window.Event('change'));
      await delay(120);
    }
    const after = drawn().first;
    const crept = Math.hypot(after[0] - parked[0], after[1] - parked[1]);
    assert.ok(
      crept < 40,
      `it stays parked through later re-settles (it crept ${crept.toFixed(0)}px back)`
    );

    // Tidy hands the layout back to the simulation.
    harness.window.document.getElementById('tidy').dispatchEvent(
      new harness.window.MouseEvent('click', { bubbles: true })
    );
    await delay(200);
    const tidied = drawn();
    const spread = [tidied.first, tidied.second].map((p) =>
      Math.hypot(p[0] - centre[0], p[1] - centre[1])
    );
    assert.ok(
      Math.max(...spread) < 250,
      `Tidy brings them back to the middle (furthest ${Math.max(...spread).toFixed(0)}px out)`
    );
  });

  it('remembers its layout so reopening the panel does not re-animate', async () => {
    const remembered = {
      v: 2,
      positions: { a: [120, 140], b: [660, 470] },
      view: { x: 0, y: 0, scale: 1 },
      query: '',
      groupByFile: true,
      groupByTag: true
    };
    harness = load(
      'graph.js',
      HTML,
      prepareCanvas({ width: 800, height: 600 }, { recordArcs: true }),
      remembered
    );
    harness.send(graph);
    await delay(200);

    const drawn = harness.window.__context.arcs.slice(-2).map((a: any) => [a[0], a[1]]);
    assert.deepStrictEqual(
      drawn.map((p: number[]) => [Math.round(p[0]), Math.round(p[1])]),
      [[120, 140], [660, 470]],
      'nodes come back exactly where they were left, with no settling animation'
    );
  });

  it('restores the filter and grouping it was left with', async () => {
    harness = load('graph.js', HTML, prepareCanvas({ width: 800, height: 600 }), {
      v: 2,
      positions: {},
      view: { x: 0, y: 0, scale: 1 },
      query: 'second',
      groupByFile: false,
      groupByTag: true
    });
    const byId = (id: string) => harness.window.document.getElementById(id);
    assert.strictEqual(byId('filter').value, 'second');
    assert.strictEqual(byId('showFiles').checked, false);
    assert.strictEqual(byId('showTags').checked, true);
  });

  it('persists where the notes ended up once it has settled', async () => {
    harness = load('graph.js', HTML, prepareCanvas({ width: 800, height: 600 }));
    harness.send(graph);
    await delay(600);

    const saved = harness.state.current;
    assert.ok(saved, 'something was persisted');
    assert.strictEqual(saved.v, 2);
    assert.deepStrictEqual(Object.keys(saved.positions).sort(), ['a', 'b']);
    for (const id of ['a', 'b']) {
      assert.ok(Number.isFinite(saved.positions[id][0]), `${id} has a real x`);
    }
  });

  it('says so instead of drawing nothing when there are no notes', async () => {
    harness = load('graph.js', HTML, prepareCanvas({ width: 800, height: 600 }));
    harness.send({ type: 'graph', nodes: [], edges: [], broken: [] });
    await delay(120);
    assert.ok(harness.window.__context.calls.fillText > 0, 'an empty-state message is drawn');
    assert.strictEqual(harness.window.__context.calls.arc ?? 0, 0, 'no nodes drawn');
  });
});
