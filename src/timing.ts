/**
 * How long the expensive steps took the last time they ran, and how many times
 * they have run. Read by the integration tests' performance checks and shown
 * by Show Rendering Diagnostics; costs a clock read per step.
 */
export interface Timing {
  ms: number;
  runs: number;
}

const timings = new Map<string, Timing>();

export function record(name: string, ms: number): void {
  timings.set(name, { ms, runs: (timings.get(name)?.runs ?? 0) + 1 });
}

export function timed<T>(name: string, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    record(name, performance.now() - started);
  }
}

export async function timedAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    record(name, performance.now() - started);
  }
}

export function snapshotTimings(): Record<string, Timing> {
  return Object.fromEntries(timings);
}
