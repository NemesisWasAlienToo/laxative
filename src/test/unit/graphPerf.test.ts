import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as inspector from 'inspector';
import { JSDOM } from 'jsdom';

/**
 * The graph with a big project's notes in it: 6,000 notes over 600 files, two
 * hashtags each and a link each, like `./docker/try-it.sh --big`. Times the
 * first layout and every frame of dragging a node, and profiles the drag.
 *
 * Canvas calls are stubbed (jsdom has no canvas), so this measures the script:
 * the layout and the work of issuing the drawing, not the GPU.
 */

const MEDIA = path.resolve(__dirname, '../../../media');
const NOTES = 6000;
const PROFILE = process.env.GRAPH_PROFILE === '1';

const HTML = `
  <div id="hud"><input id="filter"><input id="exclude"><span id="stats"></span></div>
  <canvas id="canvas"></canvas>
  <div id="tip" hidden></div>
  <div id="options" hidden>
    <input id="showFiles" type="checkbox" checked><input id="showTags" type="checkbox" checked>
    <input id="linkPull" type="checkbox" checked><input id="showTip" type="checkbox" checked>
    <input id="openNote" type="checkbox" checked><input id="openReveals" type="checkbox">
    <button id="tidy"></button>
  </div>
  <div id="nodeMenu" hidden></div>`;

function bigGraph() {
  const nodes = [];
  const edges = [];
  for (let n = 0; n < NOTES; n++) {
    nodes.push({
      id: `n${n}`,
      title: `Note ${n} on file${n % 600}.ts`,
      file: `src/big/mod${n % 30}/file${n % 600}.ts`,
      line: n,
      tags: [`area${n % 40}`, `team${n % 7}`],
      excerpt: 'Why this line matters'
    });
    edges.push({ from: `n${n}`, to: `n${(n * 7919) % NOTES}` });
  }
  return { type: 'graph', nodes, edges, broken: [] };
}

describe('graph with 6,000 notes', function () {
  this.timeout(180000);

  it('lays out, then drags a node smoothly', async () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${HTML}</body></html>`, {
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    const window = dom.window as any;
    const state = { current: undefined as any };
    window.acquireVsCodeApi = () => ({
      postMessage: () => undefined,
      getState: () => state.current,
      setState: (value: unknown) => (state.current = value)
    });
    const noop = () => undefined;
    const context: Record<string, unknown> = { measureText: () => ({ width: 10 }) };
    for (const name of [
      'clearRect', 'save', 'restore', 'translate', 'scale', 'beginPath', 'arc', 'fill', 'stroke',
      'moveTo', 'lineTo', 'closePath', 'setLineDash', 'fillText', 'setTransform', 'fillRect', 'strokeRect'
    ]) {
      context[name] = noop;
    }
    window.HTMLCanvasElement.prototype.getContext = () => context;
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { get: () => 1200 });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { get: () => 800 });

    // Time every animation frame the graph asks for.
    const frames: number[] = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: (t: number) => void) =>
      raf((t: number) => {
        const started = performance.now();
        callback(t);
        frames.push(performance.now() - started);
      });

    window.eval(fs.readFileSync(path.join(MEDIA, 'graph.js'), 'utf8'));
    const send = (message: unknown) =>
      window.dispatchEvent(new window.MessageEvent('message', { data: message }));

    const loadStarted = performance.now();
    send(bigGraph());
    const firstLayout = performance.now() - loadStarted;
    console.log(`      first layout (before any frame)     ${firstLayout.toFixed(0)} ms`);

    // Let it settle, then find a node on screen from the saved layout.
    for (let i = 0; i < 100 && !state.current?.positions; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Until it has finished settling on screen: no frame asked for in 300 ms.
    const settleStarted = performance.now();
    let seen = -1;
    // Bounded: a graph that never stops moving fails the test, not hangs it.
    for (let wait = 0; seen !== frames.length && wait < 100; wait++) {
      seen = frames.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log(`      settled on screen after             ${(performance.now() - settleStarted).toFixed(0)} ms more`);
    const { positions, view } = state.current;
    const [x, y] = positions.n0;
    const screen = (wx: number, wy: number) => ({
      clientX: wx * view.scale + view.x,
      clientY: wy * view.scale + view.y,
      bubbles: true
    });
    const canvas = window.document.getElementById('canvas');

    // Drag n0 50px to the right over about a second, as a hand would.
    let session: inspector.Session | undefined;
    if (PROFILE) {
      session = new inspector.Session();
      session.connect();
      const post = (method: string) =>
        new Promise((resolve) => session!.post(method, {}, resolve));
      await post('Profiler.enable');
      await post('Profiler.start');
    }
    frames.length = 0;
    const dragStarted = performance.now();
    canvas.dispatchEvent(new window.MouseEvent('mousedown', screen(x, y)));
    for (let i = 1; i <= 30; i++) {
      window.dispatchEvent(new window.MouseEvent('mousemove', screen(x + i * 2, y)));
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    const held = frames.length;
    window.dispatchEvent(new window.MouseEvent('mouseup', screen(x + 60, y)));
    // Until the graph stops asking for frames.
    let count = -1;
    for (let wait = 0; count !== frames.length && wait < 100; wait++) {
      count = frames.length;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const dragTotal = performance.now() - dragStarted;

    if (session) {
      const { profile } = (await new Promise((resolve) =>
        session!.post('Profiler.stop', (_err, result) => resolve(result))
      )) as any;
      session.disconnect();
      const self = new Map<string, number>();
      const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
      profile.samples.forEach((id: number, i: number) => {
        const f = byId.get(id).callFrame;
        const key = `${f.functionName || '(anonymous)'} ${path.basename(String(f.url))}:${f.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
      });
      console.log('      profile of the drag, self time:');
      for (const [key, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`        ${t.toFixed(0).padStart(6)} ms  ${key}`);
      }
    }

    const stats = (list: number[]) => {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return { median: at(0.5), p95: at(0.95), worst: at(1), text: `${at(0.5).toFixed(0)} / ${at(0.95).toFixed(0)} / ${at(1).toFixed(0)} ms (${list.length} frames)` };
    };
    const holding = stats(frames.slice(0, held));
    const after = stats(frames.slice(held));
    console.log(`      while held: median / 95th / worst   ${holding.text}`);
    console.log(`      after letting go: same              ${after.text}`);
    console.log(`      drag: total until it stops          ${dragTotal.toFixed(0)} ms`);
    dom.window.close();

    // 60 frames a second is 16 ms a frame; measured at 13 ms median, 16 ms
    // 95th. The margin is for slower machines: before the grid and the local
    // drag, a frame took over 4 seconds.
    assert.ok(holding.p95 < 25, `95th percentile frame while dragging: ${holding.p95.toFixed(0)} ms`);
    assert.ok(firstLayout < 3000, `first layout took ${firstLayout.toFixed(0)} ms`);
  });

  it('does not shove a nearby note far away when one note is dragged', async () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${HTML}</body></html>`, {
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    const window = dom.window as any;
    const state = { current: undefined as any };
    window.acquireVsCodeApi = () => ({
      postMessage: () => undefined,
      getState: () => state.current,
      setState: (value: unknown) => (state.current = value)
    });
    const context: Record<string, unknown> = { measureText: () => ({ width: 10 }), getImageData: () => ({}) };
    for (const name of [
      'clearRect', 'save', 'restore', 'translate', 'scale', 'beginPath', 'arc', 'fill', 'stroke',
      'moveTo', 'lineTo', 'closePath', 'setLineDash', 'fillText', 'setTransform', 'fillRect', 'strokeRect'
    ]) {
      context[name] = () => undefined;
    }
    window.HTMLCanvasElement.prototype.getContext = () => context;
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { get: () => 1200 });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { get: () => 800 });
    let frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: (t: number) => void) =>
      raf((t: number) => {
        frames++;
        callback(t);
      });
    window.eval(fs.readFileSync(path.join(MEDIA, 'graph.js'), 'utf8'));
    window.dispatchEvent(new window.MessageEvent('message', { data: bigGraph() }));

    const settle = async () => {
      let seen = -1;
      for (let wait = 0; seen !== frames && wait < 100; wait++) {
        seen = frames;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // Positions are saved a moment after the layout stops.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return state.current;
    };
    const canvas = window.document.getElementById('canvas');
    /** Drags a note from where it is to (x, y), in graph coordinates. */
    const drag = async (id: string, x: number, y: number) => {
      const { positions, view } = await settle();
      const at = (wx: number, wy: number) => ({
        clientX: wx * view.scale + view.x,
        clientY: wy * view.scale + view.y,
        bubbles: true
      });
      const [fx, fy] = positions[id];
      canvas.dispatchEvent(new window.MouseEvent('mousedown', at(fx, fy)));
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        window.dispatchEvent(new window.MouseEvent('mousemove', at(fx + (x - fx) * t, fy + (y - fy) * t)));
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      window.dispatchEvent(new window.MouseEvent('mouseup', at(x, y)));
    };

    let { positions } = await settle();
    const xs = Object.values(positions).map((p: any) => p[0]);
    const ys = Object.values(positions).map((p: any) => p[1]);
    const outside = Math.max(...xs) + 1500;
    const middle = (Math.min(...ys) + Math.max(...ys)) / 2;

    for (const gap of [120, 250]) {
      // Two notes taken well out of the crowd, `gap` apart.
      await drag('n0', outside, middle);
      await drag('n1', outside + gap, middle);
      ({ positions } = await settle());
      const before = positions.n1;
      // Then the first one nudged a little and let go.
      await drag('n0', outside - 20, middle + 20);
      ({ positions } = await settle());
      const after = positions.n1;
      const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
      console.log(`      ${gap}px apart: the other note moved ${moved.toFixed(0)} px`);
      // A small push is fair at that distance; hundreds of pixels was the bug.
      assert.ok(moved < 40, `${gap}px apart, the other note moved ${moved.toFixed(0)} px`);
    }
    dom.window.close();
  });
});
